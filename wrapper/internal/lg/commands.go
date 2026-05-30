package lg

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/netip"
	"os/exec"
	"strconv"
)

// Every command is built here as an explicit argv slice and executed with
// exec.CommandContext. There is no shell anywhere in this file — no sh -c, no
// string interpolation into a command line. The only caller-controlled data
// that reaches argv has already passed the validators in validate.go.

// bgpArgv builds the vtysh argv for a validated BGP query. The full FRR command
// is one argv element after "-c"; vtysh parses it with its own command parser,
// not a shell.
func (c Config) bgpArgv(t QueryType, fam Family, query string) []string {
	afi := "ipv4"
	if fam == FamilyV6 {
		afi = "ipv6"
	}
	if fam == FamilyAuto && t == QueryPrefix {
		// query is canonical here; a colon means it's an IPv6 literal/prefix.
		if isV6(query) {
			afi = "ipv6"
		}
	}

	var show string
	switch t {
	case QueryPrefix:
		show = fmt.Sprintf("show bgp %s unicast %s", afi, query)
	case QueryASPath:
		show = fmt.Sprintf("show bgp %s unicast regexp %s", afi, query)
	case QueryCommunity:
		show = fmt.Sprintf("show bgp %s unicast community %s", afi, query)
	}
	return []string{c.VtyshPath, "-c", show}
}

// birdArgv builds the birdc argv for a validated BGP query. The restricted
// client `birdc -r` refuses anything but `show …`, and the whole command is one
// argv element (birdc joins its positional args into the command it sends over
// the control socket — no shell). For prefix the query is a canonical CIDR/addr;
// for as-path/community it is a complete `where` predicate from the validators.
func (c Config) birdArgv(t QueryType, fam Family, query string) []string {
	frame := "show route table " + c.birdTable(fam) + " "
	var cmd string
	switch t {
	case QueryPrefix:
		cmd = frame + "for " + query + " all"
	case QueryASPath, QueryCommunity:
		cmd = frame + "where " + query + " all"
	}
	return []string{c.BirdcPath, "-r", cmd}
}

// birdTable picks the v4 or v6 routing table for the resolved family. BGP family
// resolution (resolveBGPFamily) has already mapped auto/prefix to a concrete
// family before this is called.
func (c Config) birdTable(fam Family) string {
	if fam == FamilyV6 {
		return c.BirdTableV6
	}
	return c.BirdTableV4
}

// RunBGP executes a fast BGP query and returns the combined output. Suitable for
// an SSR loader: it is bounded by BGPTimeout and never streams.
func (c Config) RunBGP(ctx context.Context, t QueryType, fam Family, query string) (cmdLine string, out string, err error) {
	ctx, cancel := context.WithTimeout(ctx, c.BGPTimeout)
	defer cancel()

	fam, err = c.resolveBGPFamily(t, fam, query)
	if err != nil {
		return "", "", err
	}
	var argv []string
	if c.Backend == BackendBIRD {
		argv = c.birdArgv(t, fam, query)
	} else {
		argv = c.bgpArgv(t, fam, query)
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	b, err := cmd.CombinedOutput()
	return displayCmd(argv), string(b), err
}

// pingArgv / tracerouteArgv assume Linux iputils / traceroute (the VyOS/FRR
// target). count, hops, and timeouts all come from clamped config.
func (c Config) pingArgv(target string, fam Family) []string {
	argv := []string{c.PingPath, "-c", strconv.Itoa(c.PingCount), "-w", strconv.Itoa(int(c.PingTimeout.Seconds()))}
	fam, source := c.probeSource(fam, target)
	argv = appendFamilyFlag(argv, fam)
	if source != "" {
		argv = append(argv, "-I", source)
	}
	return append(argv, "--", target)
}

func (c Config) tracerouteArgv(target string, fam Family) []string {
	argv := []string{c.TraceroutePath, "-m", strconv.Itoa(c.TracerouteMaxHop), "-q", strconv.Itoa(c.TracerouteQueries), "-w", "2"}
	fam, source := c.probeSource(fam, target)
	argv = appendFamilyFlag(argv, fam)
	if source != "" {
		argv = append(argv, "-s", source)
	}
	return append(argv, "--", target)
}

func (c Config) probeSource(fam Family, target string) (Family, string) {
	switch fam {
	case FamilyV4:
		return fam, c.ProbeSourceIPv4
	case FamilyV6:
		return fam, c.ProbeSourceIPv6
	case FamilyAuto:
		if isV4(target) && c.ProbeSourceIPv4 != "" {
			return FamilyV4, c.ProbeSourceIPv4
		}
		if isV4(target) {
			return fam, ""
		}
		if c.ProbeSourceIPv6 != "" {
			return FamilyV6, c.ProbeSourceIPv6
		}
	}
	return fam, ""
}

// streamCommand runs argv and calls onLine for each line of combined output as
// it arrives, so the handler can flush to the client (SSE/chunked). Bounded by
// the supplied timeout.
func streamCommand(ctx context.Context, argv []string, onLine func(string)) error {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout // merge stderr into the same stream
	if err := cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	for scanner.Scan() {
		onLine(scanner.Text())
	}
	if err := scanner.Err(); err != nil && err != io.EOF {
		_ = cmd.Wait()
		return err
	}
	return cmd.Wait()
}

func (c Config) StreamPing(ctx context.Context, target string, fam Family, onLine func(string)) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, c.PingTimeout)
	defer cancel()
	argv := c.pingArgv(target, fam)
	return displayCmd(argv), streamCommand(ctx, argv, onLine)
}

func (c Config) StreamTraceroute(ctx context.Context, target string, fam Family, onLine func(string)) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, c.TracerouteTimeout)
	defer cancel()
	argv := c.tracerouteArgv(target, fam)
	return displayCmd(argv), streamCommand(ctx, argv, onLine)
}

func appendFamilyFlag(argv []string, fam Family) []string {
	switch fam {
	case FamilyV4:
		return append(argv, "-4")
	case FamilyV6:
		return append(argv, "-6")
	default:
		return argv
	}
}

func isV6(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			return true
		}
	}
	return false
}

func isV4(s string) bool {
	addr, err := netip.ParseAddr(s)
	return err == nil && addr.Is4()
}

// displayCmd renders argv for display/logging only — never re-parsed or exec'd.
func displayCmd(argv []string) string {
	out := ""
	for i, a := range argv {
		if i > 0 {
			out += " "
		}
		out += a
	}
	return out
}
