package lg

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Server is the HTTP API. It exposes only the fixed, allow-listed endpoints
// below; there is no generic "run command" surface.
type Server struct {
	cfg      Config
	resolver probeResolver
}

type probeResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

const probeResolveTimeout = 5 * time.Second

func NewServer(cfg Config) *Server { return &Server{cfg: cfg, resolver: net.DefaultResolver} }

func (s *Server) Routes() http.Handler {
	// No application-layer client auth: the wrapper binds loopback only and is
	// reached solely via cloudflared + the edge CF Access policy. Loopback
	// binding (enforced in main) is the local security boundary.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("POST /api/bgp", s.handleBGP)
	mux.HandleFunc("GET /api/ping", s.handlePing)
	mux.HandleFunc("GET /api/traceroute", s.handleTraceroute)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type bgpRequest struct {
	Type   string `json:"type"`
	Family string `json:"family"`
	Query  string `json:"query"`
}

type bgpResponse struct {
	Command string `json:"command"`
	Output  string `json:"output"`
}

func (s *Server) handleBGP(w http.ResponseWriter, r *http.Request) {
	var req bgpRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	qt, err := ParseQueryType(req.Type)
	if err != nil {
		writeError(w, http.StatusBadRequest, "unknown query type")
		return
	}
	if !s.cfg.queryTypeAllowed(qt) {
		writeError(w, http.StatusForbidden, "query type not enabled")
		return
	}
	fam, err := ParseFamily(req.Family)
	if err != nil {
		writeError(w, http.StatusBadRequest, "unknown address family")
		return
	}
	query, err := validateBGPQuery(s.cfg.Backend, qt, req.Query)
	if err != nil {
		writeError(w, http.StatusBadRequest, "query failed validation")
		return
	}
	fam, err = s.cfg.resolveBGPFamily(qt, fam, query)
	if err != nil {
		writeFamilyError(w, err)
		return
	}

	cmdLine, out, err := s.cfg.RunBGP(r.Context(), qt, fam, query)
	if err != nil {
		// vtysh may exit non-zero for "no such route"; surface output anyway.
		log.Printf("bgp query error: %v", err)
	}
	writeJSON(w, http.StatusOK, bgpResponse{Command: cmdLine, Output: out})
}

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	s.stream(w, r, s.cfg.StreamPing)
}

func (s *Server) handleTraceroute(w http.ResponseWriter, r *http.Request) {
	s.stream(w, r, s.cfg.StreamTraceroute)
}

// stream validates the target and streams command output line-by-line as
// Server-Sent Events. Long-running probes never block an SSR loader because the
// frontend calls these resource endpoints from the client.
func (s *Server) stream(w http.ResponseWriter, r *http.Request, run func(ctx context.Context, target string, fam Family, onLine func(string)) (string, error)) {
	target, targetFam, err := validateTarget(r.URL.Query().Get("target"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "target failed validation")
		return
	}
	reqFam, err := ParseFamily(r.URL.Query().Get("family"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "unknown address family")
		return
	}
	fam, err := s.cfg.resolveProbeFamily(targetFam, reqFam)
	if err != nil {
		writeFamilyError(w, err)
		return
	}
	target, fam, err = s.resolveProbeTarget(r.Context(), target, fam)
	if err != nil {
		if errors.Is(err, ErrBadTarget) {
			writeError(w, http.StatusBadRequest, "target failed validation")
			return
		}
		writeFamilyError(w, err)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	send := func(event, data string) {
		// SSE framing; data lines are display-only command output. Strip control
		// sequences before they reach the browser-side terminal renderer.
		w.Write([]byte("event: " + event + "\ndata: " + sanitizeSSEData(data) + "\n\n"))
		flusher.Flush()
	}

	cmdLine, runErr := run(r.Context(), target, fam, func(line string) {
		send("line", line)
	})
	_ = cmdLine
	if runErr != nil {
		// Named "fail" (not "error") so it doesn't collide with the browser
		// EventSource's native "error" connection event.
		send("fail", runErr.Error())
	}
	send("done", "")
}

func (s *Server) resolveProbeTarget(ctx context.Context, target string, fam Family) (string, Family, error) {
	if _, targetFam, err := validateTarget(target); err == nil && targetFam != FamilyAuto {
		if fam != FamilyAuto && fam != targetFam {
			return "", "", ErrFamilyMatch
		}
		return target, targetFam, nil
	}

	ctx, cancel := context.WithTimeout(ctx, probeResolveTimeout)
	defer cancel()

	addrs, err := s.resolver.LookupIPAddr(ctx, target)
	if err != nil || len(addrs) == 0 {
		return "", "", ErrBadTarget
	}

	var selected string
	var selectedFam Family
	for _, addr := range addrs {
		resolved := addr.IP.String()
		cleaned, resolvedFam, err := validateTarget(resolved)
		if err != nil {
			return "", "", ErrBadTarget
		}
		if fam != FamilyAuto && fam != resolvedFam {
			continue
		}
		if selected == "" {
			selected = cleaned
			selectedFam = resolvedFam
		}
	}
	if selected == "" {
		return "", "", ErrFamilyMatch
	}
	return selected, selectedFam, nil
}

func sanitizeSSEData(s string) string {
	s = stripANSIEscapes(s)
	var b strings.Builder
	b.Grow(len(s))
	lastWasSpace := false
	for len(s) > 0 {
		r, size := utf8.DecodeRuneInString(s)
		if r == utf8.RuneError && size == 1 {
			r = '�'
		}
		s = s[size:]

		if r == '\t' {
			b.WriteByte('\t')
			lastWasSpace = false
			continue
		}
		if r == '\r' || r == '\n' {
			if !lastWasSpace {
				b.WriteByte(' ')
				lastWasSpace = true
			}
			continue
		}
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
		lastWasSpace = false
	}
	return b.String()
}

func stripANSIEscapes(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] == 0x1b {
			i = skipEscapeSequence(s, i)
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

func skipEscapeSequence(s string, i int) int {
	i++ // ESC
	if i >= len(s) {
		return i
	}
	switch s[i] {
	case '[':
		i++
		for i < len(s) {
			c := s[i]
			i++
			if c >= 0x40 && c <= 0x7e {
				break
			}
		}
		return i
	case ']':
		return skipUntilStringTerminator(s, i+1)
	case 'P', '^', '_':
		return skipUntilStringTerminator(s, i+1)
	default:
		// Other ANSI escape forms are short control sequences. Drop ESC and the
		// following byte rather than trying to render terminal control text.
		return i + 1
	}
}

func skipUntilStringTerminator(s string, i int) int {
	for i < len(s) {
		if s[i] == 0x07 { // BEL
			return i + 1
		}
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\' {
			return i + 2
		}
		i++
	}
	return i
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func writeFamilyError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrFamilyOff):
		writeError(w, http.StatusForbidden, "address family not enabled")
	case errors.Is(err, ErrFamilyMatch):
		writeError(w, http.StatusBadRequest, "address family does not match target")
	default:
		writeError(w, http.StatusBadRequest, "unknown address family")
	}
}
