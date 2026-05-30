package lg

import "testing"

func TestValidateBGPQuery_Prefix(t *testing.T) {
	ok := []struct{ in, want string }{
		{"192.0.2.1", "192.0.2.1"},
		{"192.0.2.0/24", "192.0.2.0/24"},
		{"2001:db8::1", "2001:db8::1"},
		{"2001:db8::/32", "2001:db8::/32"},
		{"192.0.2.5/24", "192.0.2.0/24"}, // canonicalized (masked)
	}
	for _, c := range ok {
		got, err := validateBGPQuery(BackendFRR, QueryPrefix, c.in)
		if err != nil {
			t.Fatalf("validateBGPQuery(prefix, %q) errored: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("validateBGPQuery(prefix, %q) = %q, want %q", c.in, got, c.want)
		}
	}

	// Injection / junk must all be rejected — none of these parse as IP/CIDR.
	bad := []string{
		"192.0.2.1; reload",
		"192.0.2.1 | sh",
		"$(reboot)",
		"`id`",
		"192.0.2.1 && cat /etc/passwd",
		"show running-config",
		"../../etc/passwd",
		"",
		"   ",
		"not-an-ip",
	}
	for _, in := range bad {
		if _, err := validateBGPQuery(BackendFRR, QueryPrefix, in); err == nil {
			t.Errorf("validateBGPQuery(prefix, %q) accepted a bad value", in)
		}
	}
}

func TestValidateBGPQuery_ASPathAndCommunity(t *testing.T) {
	if _, err := validateBGPQuery(BackendFRR, QueryASPath, "_64500$"); err != nil {
		t.Errorf("valid as-path regex rejected: %v", err)
	}
	if _, err := validateBGPQuery(BackendFRR, QueryASPath, "64500; reload"); err == nil {
		t.Error("as-path with ';' accepted")
	}
	if _, err := validateBGPQuery(BackendFRR, QueryCommunity, "64500:100"); err != nil {
		t.Errorf("valid community rejected: %v", err)
	}
	if _, err := validateBGPQuery(BackendFRR, QueryCommunity, "no-export"); err != nil {
		t.Errorf("well-known community rejected: %v", err)
	}
	if _, err := validateBGPQuery(BackendFRR, QueryCommunity, "64500:100 || rm -rf /"); err == nil {
		t.Error("community with shell metachars accepted")
	}
}

func TestValidateBGPQuery_BirdASPath(t *testing.T) {
	ok := []struct{ in, want string }{
		{"64500", "bgp_path ~ [= 64500 =]"},
		{"* 64500 *", "bgp_path ~ [= * 64500 * =]"},
		{"64500 ?", "bgp_path ~ [= 64500 ? =]"},
		{"  64500   64501 ", "bgp_path ~ [= 64500 64501 =]"}, // whitespace normalized
	}
	for _, c := range ok {
		got, err := validateBGPQuery(BackendBIRD, QueryASPath, c.in)
		if err != nil {
			t.Fatalf("BIRD as-path %q errored: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("BIRD as-path %q = %q, want %q", c.in, got, c.want)
		}
	}

	bad := []string{
		"*",             // no AS number
		"? ?",           // no AS number
		"64500; reload", // shell metachars
		"[= 1 =]",       // brackets not allowed as input
		"64*500",        // not a valid atom
		"bgp_path",      // bareword
		"64500 | sh",    // pipe
		"$(reboot)",     // command substitution
		"",              // empty
	}
	for _, in := range bad {
		if _, err := validateBGPQuery(BackendBIRD, QueryASPath, in); err == nil {
			t.Errorf("BIRD as-path %q accepted a bad value", in)
		}
	}
}

func TestValidateBGPQuery_BirdCommunity(t *testing.T) {
	ok := []struct{ in, want string }{
		{"64500:100", "(64500, 100) ~ bgp_community"},
		{"64500:100:200", "(64500, 100, 200) ~ bgp_large_community"},
		{"no-export", "(65535, 65281) ~ bgp_community"},
	}
	for _, c := range ok {
		got, err := validateBGPQuery(BackendBIRD, QueryCommunity, c.in)
		if err != nil {
			t.Fatalf("BIRD community %q errored: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("BIRD community %q = %q, want %q", c.in, got, c.want)
		}
	}

	bad := []string{
		"internet",              // not a real BIRD community
		"64500:100 || rm -rf /", // shell metachars
		"(64500,100)",           // BIRD-native form is not accepted as input
		"abc:def",               // non-numeric
		"",                      // empty
	}
	for _, in := range bad {
		if _, err := validateBGPQuery(BackendBIRD, QueryCommunity, in); err == nil {
			t.Errorf("BIRD community %q accepted a bad value", in)
		}
	}
}

func TestValidateTarget(t *testing.T) {
	if _, fam, err := validateTarget("8.8.8.8"); err != nil || fam != FamilyV4 {
		t.Errorf("IPv4 target: fam=%v err=%v", fam, err)
	}
	if _, fam, err := validateTarget("2606:4700:4700::1111"); err != nil || fam != FamilyV6 {
		t.Errorf("IPv6 target: fam=%v err=%v", fam, err)
	}
	if _, fam, err := validateTarget("lg.example.com"); err != nil || fam != FamilyAuto {
		t.Errorf("hostname target: fam=%v err=%v", fam, err)
	}
	bad := []string{
		"", "-flag", "a;b", "host name", "$(x)", "192.0.2.1; ls", "foo/bar",
		"0.0.0.1",
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.1.1",
		"172.16.0.1",
		"192.0.2.1",
		"192.168.0.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"::ffff:10.0.0.1",
		"100::1",
		"2001:db8::1",
		"3fff::1",
		"fc00::1",
		"fe80::1",
		"ff00::1",
	}
	for _, in := range bad {
		if _, _, err := validateTarget(in); err == nil {
			t.Errorf("validateTarget(%q) accepted a bad value", in)
		}
	}
}

func TestParseEnums(t *testing.T) {
	if _, err := ParseQueryType("prefix"); err != nil {
		t.Error("prefix should be valid")
	}
	if _, err := ParseQueryType("exec"); err == nil {
		t.Error("unknown query type accepted")
	}
	if f, err := ParseFamily(""); err != nil || f != FamilyAuto {
		t.Errorf("empty family should default to auto: %v %v", f, err)
	}
	if _, err := ParseFamily("ipv7"); err == nil {
		t.Error("bad family accepted")
	}
}
