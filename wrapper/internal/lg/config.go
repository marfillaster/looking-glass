package lg

import (
	"fmt"
	"net"
	"net/netip"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Config is the wrapper's runtime configuration. Every value has a safe default
// and is overridable from the environment so the repo ships no site-specifics.
type Config struct {
	// ListenAddr MUST stay on loopback in production. cloudflared reaches the
	// wrapper over 127.0.0.1; the wrapper is never directly internet-facing.
	// Loopback binding is the wrapper's only local security boundary — enforced
	// at startup (see EnforceLoopback), there is no application-layer auth.
	ListenAddr string

	// AllowNonLoopback is an intentionally unsafe escape hatch (set via
	// LG_UNSAFE_NON_LOOPBACK) for dev/staging where the wrapper is reached over a
	// trusted overlay (e.g. WireGuard). Never set in production.
	AllowNonLoopback bool

	// Backend selects which routing daemon the BGP path queries: FRR via vtysh
	// (default) or BIRD via birdc. Only the BGP path differs; ping/traceroute are
	// daemon-agnostic.
	Backend RoutingBackend

	// Absolute paths or bare names resolved via PATH. Kept configurable so the
	// binary can run in a minimal container with non-standard locations. VtyshPath
	// is used only by the FRR backend, BirdcPath only by the BIRD backend.
	VtyshPath      string
	BirdcPath      string
	PingPath       string
	TraceroutePath string

	// BIRD routing-table names per family (default master4/master6). BIRD splits
	// v4/v6 into separate tables/channels; the BGP query selects the one matching
	// the resolved family. Ignored by the FRR backend.
	BirdTableV4 string
	BirdTableV6 string

	// Optional source addresses for probes. Useful when the looking-glass host
	// has policy routing that sends a dedicated source through a transit edge.
	ProbeSourceIPv4 string
	ProbeSourceIPv6 string

	// AddressFamilies is the operator-advertised AFI policy. Empty is treated as
	// dual stack. Single-family deployments reject the other family instead of
	// letting probes leak through unrelated transit/source addresses.
	AddressFamilies map[Family]bool

	// AllowedQueryTypes restricts the BGP query enum further than the built-in
	// allow-list (e.g. "prefix" only). Empty = all built-in types allowed.
	AllowedQueryTypes map[QueryType]bool

	// Bounds — every external command is capped so nothing runs unbounded.
	BGPTimeout        time.Duration
	PingCount         int
	PingTimeout       time.Duration
	TracerouteMaxHop  int
	TracerouteQueries int
	TracerouteTimeout time.Duration
}

func LoadConfig() Config {
	c := Config{
		ListenAddr:        env("LG_LISTEN_ADDR", "127.0.0.1:8080"),
		Backend:           ParseRoutingBackend(env("LG_ROUTING_BACKEND", string(BackendFRR))),
		VtyshPath:         env("LG_VTYSH_PATH", "vtysh"),
		BirdcPath:         env("LG_BIRDC_PATH", "birdc"),
		BirdTableV4:       envBirdTable("LG_BIRD_TABLE_V4", "master4"),
		BirdTableV6:       envBirdTable("LG_BIRD_TABLE_V6", "master6"),
		PingPath:          env("LG_PING_PATH", "ping"),
		TraceroutePath:    env("LG_TRACEROUTE_PATH", "traceroute"),
		ProbeSourceIPv4:   envIP("LG_PROBE_SOURCE_IPV4", ""),
		ProbeSourceIPv6:   envIP("LG_PROBE_SOURCE_IPV6", ""),
		AddressFamilies:   parseAddressFamilies(env("LG_ADDRESS_FAMILIES", "ipv4,ipv6")),
		AllowNonLoopback:  envBool("LG_UNSAFE_NON_LOOPBACK"),
		BGPTimeout:        envDuration("LG_BGP_TIMEOUT_SEC", 10*time.Second),
		PingCount:         envInt("LG_PING_COUNT", 5, 1, 20),
		PingTimeout:       envDuration("LG_PING_TIMEOUT_SEC", 15*time.Second),
		TracerouteMaxHop:  envInt("LG_TRACEROUTE_MAX_HOPS", 15, 1, 30),
		TracerouteQueries: envInt("LG_TRACEROUTE_QUERIES", 2, 1, 5),
		TracerouteTimeout: envDuration("LG_TRACEROUTE_TIMEOUT_SEC", 20*time.Second),
	}

	if raw := env("LG_ALLOW_QUERY_TYPES", ""); raw != "" {
		c.AllowedQueryTypes = map[QueryType]bool{}
		for _, t := range strings.Split(raw, ",") {
			c.AllowedQueryTypes[QueryType(strings.TrimSpace(t))] = true
		}
	}
	return c
}

// EnforceLoopback returns an error unless ListenAddr is a loopback address.
// Loopback binding is the wrapper's local security boundary: it must never be
// directly reachable off-box. The intentionally-unsafe LG_UNSAFE_NON_LOOPBACK
// override is honored only for dev/staging on a trusted overlay.
func (c Config) EnforceLoopback() error {
	if c.listenIsLoopback() || c.AllowNonLoopback {
		return nil
	}
	return fmt.Errorf(
		"refusing non-loopback listen address %q: bind 127.0.0.1 or [::1] "+
			"(set LG_UNSAFE_NON_LOOPBACK=1 to override for dev/staging only)",
		c.ListenAddr,
	)
}

func (c Config) listenIsLoopback() bool {
	host, _, err := net.SplitHostPort(c.ListenAddr)
	if err != nil {
		return false
	}
	addr, err := netip.ParseAddr(host)
	return err == nil && addr.IsLoopback()
}

// queryTypeAllowed reports whether a (valid) query type is enabled by config.
func (c Config) queryTypeAllowed(t QueryType) bool {
	if c.AllowedQueryTypes == nil {
		return true
	}
	return c.AllowedQueryTypes[t]
}

func (c Config) familyAllowed(f Family) bool {
	if f == FamilyAuto {
		return true
	}
	if c.AddressFamilies == nil {
		return f == FamilyV4 || f == FamilyV6
	}
	return c.AddressFamilies[f]
}

func (c Config) defaultFamily() Family {
	if c.familyAllowed(FamilyV4) {
		return FamilyV4
	}
	return FamilyV6
}

func (c Config) resolveBGPFamily(t QueryType, fam Family, query string) (Family, error) {
	if fam == FamilyAuto {
		if t == QueryPrefix {
			if isV6(query) {
				fam = FamilyV6
			} else {
				fam = FamilyV4
			}
		} else {
			fam = c.defaultFamily()
		}
	}
	if !c.familyAllowed(fam) {
		return "", ErrFamilyOff
	}
	return fam, nil
}

func (c Config) resolveProbeFamily(targetFam, reqFam Family) (Family, error) {
	fam := reqFam
	if fam != FamilyAuto {
		if targetFam != FamilyAuto && targetFam != fam {
			return "", ErrFamilyMatch
		}
	} else if targetFam != FamilyAuto {
		fam = targetFam
	} else if !c.familyAllowed(FamilyV4) || !c.familyAllowed(FamilyV6) {
		fam = c.defaultFamily()
	}
	if !c.familyAllowed(fam) {
		return "", ErrFamilyOff
	}
	return fam, nil
}

func parseAddressFamilies(raw string) map[Family]bool {
	out := map[Family]bool{}
	for _, part := range strings.Split(raw, ",") {
		switch strings.ToLower(strings.TrimSpace(part)) {
		case "dual", "dual-stack", "all", "both":
			out[FamilyV4] = true
			out[FamilyV6] = true
		case string(FamilyV4), "4", "v4":
			out[FamilyV4] = true
		case string(FamilyV6), "6", "v6":
			out[FamilyV6] = true
		}
	}
	if !out[FamilyV4] && !out[FamilyV6] {
		out[FamilyV4] = true
		out[FamilyV6] = true
	}
	return out
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envBool(key string) bool {
	v, err := strconv.ParseBool(os.Getenv(key))
	return err == nil && v
}

// birdTableRe restricts BIRD table names to a safe identifier charset. Table
// names come from operator env (trusted, like the binary paths) but still flow
// into the birdc command string, so keep them inside a strict allow-list and
// fall back to the default on anything unexpected.
var birdTableRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

func envBirdTable(key, def string) string {
	v := env(key, def)
	if !birdTableRe.MatchString(v) {
		return def
	}
	return v
}

func envIP(key, def string) string {
	v := env(key, def)
	if v == "" {
		return ""
	}
	if _, err := netip.ParseAddr(v); err != nil {
		return ""
	}
	return v
}

func envInt(key string, def, min, max int) int {
	v, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		v = def
	}
	if v < min {
		v = min
	}
	if v > max {
		v = max
	}
	return v
}

func envDuration(key string, def time.Duration) time.Duration {
	if secs, err := strconv.Atoi(os.Getenv(key)); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	return def
}
