package lg

import (
	"reflect"
	"testing"
	"time"
)

func TestProbeSourceArgv(t *testing.T) {
	cfg := Config{
		PingPath:          "ping",
		TraceroutePath:    "traceroute",
		PingCount:         3,
		PingTimeout:       9 * time.Second,
		TracerouteMaxHop:  12,
		TracerouteQueries: 1,
		ProbeSourceIPv6:   "2001:db8::53",
	}

	wantPing := []string{"ping", "-c", "3", "-w", "9", "-6", "-I", "2001:db8::53", "--", "2001:db8::1"}
	if got := cfg.pingArgv("2001:db8::1", FamilyAuto); !reflect.DeepEqual(got, wantPing) {
		t.Fatalf("pingArgv() = %#v, want %#v", got, wantPing)
	}

	wantTrace := []string{"traceroute", "-m", "12", "-q", "1", "-w", "2", "-6", "-s", "2001:db8::53", "--", "2001:db8::1"}
	if got := cfg.tracerouteArgv("2001:db8::1", FamilyAuto); !reflect.DeepEqual(got, wantTrace) {
		t.Fatalf("tracerouteArgv() = %#v, want %#v", got, wantTrace)
	}

	wantHostname := []string{"ping", "-c", "3", "-w", "9", "-6", "-I", "2001:db8::53", "--", "example.com"}
	if got := cfg.pingArgv("example.com", FamilyAuto); !reflect.DeepEqual(got, wantHostname) {
		t.Fatalf("pingArgv(hostname) = %#v, want %#v", got, wantHostname)
	}
}

func TestBirdArgv(t *testing.T) {
	cfg := Config{
		Backend:     BackendBIRD,
		BirdcPath:   "birdc",
		BirdTableV4: "master4",
		BirdTableV6: "master6",
	}
	cases := []struct {
		qt    QueryType
		fam   Family
		query string // already-validated query / predicate
		want  []string
	}{
		{QueryPrefix, FamilyV6, "2001:db8::/32",
			[]string{"birdc", "-r", "show route table master6 for 2001:db8::/32 all"}},
		{QueryPrefix, FamilyV4, "192.0.2.0/24",
			[]string{"birdc", "-r", "show route table master4 for 192.0.2.0/24 all"}},
		{QueryASPath, FamilyV4, "bgp_path ~ [= * 64500 * =]",
			[]string{"birdc", "-r", "show route table master4 where bgp_path ~ [= * 64500 * =] all"}},
		{QueryCommunity, FamilyV6, "(64500, 100) ~ bgp_community",
			[]string{"birdc", "-r", "show route table master6 where (64500, 100) ~ bgp_community all"}},
	}
	for _, c := range cases {
		if got := cfg.birdArgv(c.qt, c.fam, c.query); !reflect.DeepEqual(got, c.want) {
			t.Errorf("birdArgv(%v, %v, %q) = %#v, want %#v", c.qt, c.fam, c.query, got, c.want)
		}
	}
}
