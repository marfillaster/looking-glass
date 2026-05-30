package lg

import (
	"errors"
	"net/netip"
	"regexp"
	"strings"
)

// Command injection is the entire threat model for this service. Nothing here
// is ever interpolated into a shell — commands are built as argv arrays in
// commands.go. These validators are the second line of defense: every piece of
// caller input must pass a strict allow-list before it can reach an argv slot.

// QueryType is a closed enum. Callers may only request one of these.
type QueryType string

const (
	QueryPrefix    QueryType = "prefix"
	QueryASPath    QueryType = "as-path"
	QueryCommunity QueryType = "community"
)

// Family is a closed enum used to pick the BGP AFI / ping mode.
type Family string

const (
	FamilyAuto Family = "auto"
	FamilyV4   Family = "ipv4"
	FamilyV6   Family = "ipv6"
)

// RoutingBackend is a closed enum selecting which routing daemon the BGP path
// shells out to. It only affects the BGP query (commands.go); ping/traceroute
// are daemon-agnostic. Defaults to FRR.
type RoutingBackend string

const (
	BackendFRR  RoutingBackend = "frr"
	BackendBIRD RoutingBackend = "bird"
)

// ParseRoutingBackend maps an env string to a backend, defaulting to FRR for
// empty or unrecognized values (matching the lenient-default config style).
func ParseRoutingBackend(s string) RoutingBackend {
	if strings.EqualFold(strings.TrimSpace(s), string(BackendBIRD)) {
		return BackendBIRD
	}
	return BackendFRR
}

var (
	ErrBadQueryType = errors.New("unknown query type")
	ErrBadFamily    = errors.New("unknown address family")
	ErrFamilyOff    = errors.New("address family not enabled")
	ErrFamilyMatch  = errors.New("address family does not match target")
	ErrBadQuery     = errors.New("query failed validation")
	ErrBadTarget    = errors.New("target failed validation")
)

var specialProbePrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("255.255.255.255/32"),

	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("::ffff:0:0/96"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

func ParseQueryType(s string) (QueryType, error) {
	switch QueryType(s) {
	case QueryPrefix, QueryASPath, QueryCommunity:
		return QueryType(s), nil
	default:
		return "", ErrBadQueryType
	}
}

func ParseFamily(s string) (Family, error) {
	switch s {
	case "", string(FamilyAuto):
		return FamilyAuto, nil
	case string(FamilyV4):
		return FamilyV4, nil
	case string(FamilyV6):
		return FamilyV6, nil
	default:
		return "", ErrBadFamily
	}
}

// AS-path queries are POSIX-regexp strings handed to FRR's own regexp engine
// (never a shell). We still clamp the charset hard: only what a real AS-path
// regex needs, nothing that could confuse vtysh's parser.
var asPathRe = regexp.MustCompile(`^[0-9_^$.*+()\[\]| ]{1,64}$`)

// Communities: standard (asn:value), large (a:b:c), or a small set of
// well-known names. Anything else is rejected.
var communityRe = regexp.MustCompile(`^(\d{1,10}:\d{1,5}|\d{1,10}:\d{1,10}:\d{1,10})$`)

var wellKnownCommunities = map[string]bool{
	"no-export":    true,
	"no-advertise": true,
	"local-AS":     true,
	"internet":     true,
}

// --- BIRD (birdc) filter-language validators ---------------------------------
//
// These return a complete BIRD `where` predicate (e.g. "bgp_path ~ [= 64500 =]")
// so commands.go can wrap it in a fixed `show route ... where <predicate>` frame
// without knowing the filter grammar. The same allow-list discipline applies:
// only digits, the mask wildcards, and the colon-separated community digits ever
// reach the output — no shell metacharacters can pass.

// A single BIRD AS-path mask atom: an AS number, "*" (any run, incl. empty), or
// "?" (exactly one AS). Sets/ranges ([..], a..b) are intentionally excluded to
// keep the allow-list tight; the common looking-glass masks need only these.
var birdMaskAtomRe = regexp.MustCompile(`^(\d{1,10}|\*|\?)$`)

// validateBirdPathMask accepts space-separated mask atoms (e.g. "* 64500 *") and
// returns the predicate "bgp_path ~ [= <atoms> =]". At least one real AS number
// must be present so a bare "*"/"?" can't match the entire table.
func validateBirdPathMask(raw string) (string, error) {
	if len(raw) > 64 {
		return "", ErrBadQuery
	}
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return "", ErrBadQuery
	}
	hasASN := false
	for _, f := range fields {
		if !birdMaskAtomRe.MatchString(f) {
			return "", ErrBadQuery
		}
		if f != "*" && f != "?" {
			hasASN = true
		}
	}
	if !hasASN {
		return "", ErrBadQuery
	}
	return "bgp_path ~ [= " + strings.Join(fields, " ") + " =]", nil
}

// BIRD has no string aliases for well-known communities; map the standard ones
// to their numeric pairs. ("internet" is not a real community in BIRD and is
// rejected.)
var birdWellKnownCommunities = map[string]string{
	"no-export":    "(65535, 65281) ~ bgp_community",
	"no-advertise": "(65535, 65282) ~ bgp_community",
	"local-AS":     "(65535, 65283) ~ bgp_community",
}

// validateBirdCommunity translates an FRR-style community string into a BIRD
// predicate: standard "asn:val" -> "(asn, val) ~ bgp_community"; large "a:b:c"
// -> "(a, b, c) ~ bgp_large_community". communityRe guarantees digit-only parts.
func validateBirdCommunity(raw string) (string, error) {
	if v, ok := birdWellKnownCommunities[raw]; ok {
		return v, nil
	}
	if !communityRe.MatchString(raw) {
		return "", ErrBadQuery
	}
	parts := strings.Split(raw, ":")
	if len(parts) == 3 {
		return "(" + parts[0] + ", " + parts[1] + ", " + parts[2] + ") ~ bgp_large_community", nil
	}
	return "(" + parts[0] + ", " + parts[1] + ") ~ bgp_community", nil
}

// validateBGPQuery returns the cleaned query string for the given type and
// backend, or an error. The returned value is safe to place in a single argv
// element. Prefix validation is backend-independent; as-path and community use
// the daemon's own filter language (FRR regexp / community list vs BIRD path
// masks / community pairs), so they branch on the backend.
func validateBGPQuery(backend RoutingBackend, t QueryType, raw string) (string, error) {
	q := strings.TrimSpace(raw)
	if q == "" {
		return "", ErrBadQuery
	}
	switch t {
	case QueryPrefix:
		return validatePrefix(q)
	case QueryASPath:
		if backend == BackendBIRD {
			return validateBirdPathMask(q)
		}
		if !asPathRe.MatchString(q) {
			return "", ErrBadQuery
		}
		return q, nil
	case QueryCommunity:
		if backend == BackendBIRD {
			return validateBirdCommunity(q)
		}
		if wellKnownCommunities[q] || communityRe.MatchString(q) {
			return q, nil
		}
		return "", ErrBadQuery
	default:
		return "", ErrBadQueryType
	}
}

// validatePrefix accepts a bare IP (v4/v6) or a CIDR and returns its canonical
// string. A value that does not parse as an address never reaches vtysh.
func validatePrefix(q string) (string, error) {
	if strings.Contains(q, "/") {
		p, err := netip.ParsePrefix(q)
		if err != nil {
			return "", ErrBadQuery
		}
		return p.Masked().String(), nil
	}
	addr, err := netip.ParseAddr(q)
	if err != nil {
		return "", ErrBadQuery
	}
	return addr.String(), nil
}

// hostnameRe is RFC 1123: labels of [A-Za-z0-9-], not starting/ending with a
// hyphen, separated by dots.
var hostnameRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$`)

// validateTarget accepts a public IP literal or a strict hostname for
// ping/traceroute and returns the cleaned value plus the detected family for IP
// literals. Hostnames are syntax-checked here only; server.go resolves them and
// feeds the resolved IP back through this validator before execution.
func validateTarget(raw string) (target string, fam Family, err error) {
	t := strings.TrimSpace(raw)
	if t == "" || len(t) > 253 {
		return "", "", ErrBadTarget
	}
	if addr, err := netip.ParseAddr(t); err == nil {
		addr = addr.Unmap()
		if !isPublicProbeAddr(addr) {
			return "", "", ErrBadTarget
		}
		if addr.Is4() {
			return addr.String(), FamilyV4, nil
		}
		return addr.String(), FamilyV6, nil
	}
	if hostnameRe.MatchString(t) {
		return t, FamilyAuto, nil
	}
	return "", "", ErrBadTarget
}

func isPublicProbeAddr(addr netip.Addr) bool {
	if !addr.IsValid() {
		return false
	}
	addr = addr.Unmap()
	if addr.IsUnspecified() ||
		addr.IsLoopback() ||
		addr.IsPrivate() ||
		addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() ||
		addr.IsMulticast() {
		return false
	}
	for _, p := range specialProbePrefixes {
		if p.Contains(addr) {
			return false
		}
	}
	return true
}
