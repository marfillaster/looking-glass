package lg

import "testing"

func TestEnforceLoopback(t *testing.T) {
	cases := []struct {
		name        string
		addr        string
		allowUnsafe bool
		wantErr     bool
	}{
		{"ipv4 loopback", "127.0.0.1:8080", false, false},
		{"ipv4 loopback other port", "127.0.0.1:9999", false, false},
		{"ipv6 loopback", "[::1]:8080", false, false},
		{"all interfaces v4", "0.0.0.0:8080", false, true},
		{"all interfaces v6", "[::]:8080", false, true},
		{"empty host", ":8080", false, true},
		{"public ipv4", "192.0.2.1:8080", false, true},
		{"public ipv6", "[2001:db8::1]:8080", false, true},
		{"hostname not ip literal", "localhost:8080", false, true},
		{"garbage", "not-an-addr", false, true},
		{"non-loopback allowed by override", "0.0.0.0:8080", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := Config{ListenAddr: tc.addr, AllowNonLoopback: tc.allowUnsafe}
			err := c.EnforceLoopback()
			if (err != nil) != tc.wantErr {
				t.Fatalf("EnforceLoopback(%q, allowUnsafe=%v) err=%v, wantErr=%v",
					tc.addr, tc.allowUnsafe, err, tc.wantErr)
			}
		})
	}
}

func TestAddressFamilyPolicy(t *testing.T) {
	ipv6Only := Config{AddressFamilies: parseAddressFamilies("ipv6")}
	if _, err := ipv6Only.resolveBGPFamily(QueryPrefix, FamilyAuto, "192.0.2.0/24"); err != ErrFamilyOff {
		t.Fatalf("IPv4 prefix on IPv6-only policy err=%v, want %v", err, ErrFamilyOff)
	}
	if got, err := ipv6Only.resolveBGPFamily(QueryASPath, FamilyAuto, "_64500$"); err != nil || got != FamilyV6 {
		t.Fatalf("AS-path auto on IPv6-only policy = %v err=%v, want %v", got, err, FamilyV6)
	}
	if got, err := ipv6Only.resolveProbeFamily(FamilyAuto, FamilyAuto); err != nil || got != FamilyV6 {
		t.Fatalf("hostname probe on IPv6-only policy = %v err=%v, want %v", got, err, FamilyV6)
	}
	if _, err := ipv6Only.resolveProbeFamily(FamilyV4, FamilyAuto); err != ErrFamilyOff {
		t.Fatalf("IPv4 target on IPv6-only policy err=%v, want %v", err, ErrFamilyOff)
	}

	dual := Config{AddressFamilies: parseAddressFamilies("dual")}
	if got, err := dual.resolveProbeFamily(FamilyAuto, FamilyAuto); err != nil || got != FamilyAuto {
		t.Fatalf("hostname probe on dual policy = %v err=%v, want %v", got, err, FamilyAuto)
	}
	if _, err := dual.resolveProbeFamily(FamilyV4, FamilyV6); err != ErrFamilyMatch {
		t.Fatalf("mismatched probe family err=%v, want %v", err, ErrFamilyMatch)
	}
}
