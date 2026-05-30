# VyOS / FRR Router Setup

Use this when the looking-glass vantage point is a VyOS router running FRR. The
wrapper uses `vtysh` for BGP table queries and Linux `ping` / `traceroute` for
probes.

## Build And Install The Wrapper

Build the static Go binary from a development machine or on the router:

```sh
cd wrapper
go test ./...
go build -o wrapper ./cmd/wrapper
```

Install it on persistent VyOS storage so it survives image upgrades:

```sh
install -d -m 0755 /config/looking-glass
install -m 0755 wrapper /config/looking-glass/wrapper
```

Create an unprivileged user that can read FRR through `vtysh` without running
the wrapper as root. The exact user-management commands vary by deployment; the
important runtime property is `User=lg` plus supplementary group `frrvty`.

## Wrapper Environment

Create `/config/looking-glass/wrapper.env`:

```sh
LG_LISTEN_ADDR=127.0.0.1:8080
LG_ROUTING_BACKEND=frr
LG_VTYSH_PATH=/usr/bin/vtysh
LG_PING_PATH=/usr/bin/ping
LG_TRACEROUTE_PATH=/usr/bin/traceroute
LG_ADDRESS_FAMILIES=ipv4,ipv6
```

Full settings and bounds are documented in
[`wrapper/.env.example`](../wrapper/.env.example). Keep
`LG_LISTEN_ADDR` on loopback in production; the wrapper has no application-layer
client auth.

## Persistent Service

On VyOS, start the wrapper as a transient, auto-restarting `systemd-run` unit
from the post-config bootup script. The script runs as root on boot; the unit
itself drops to the unprivileged user and `frrvty` group.

Append this to `/config/scripts/vyos-postconfig-bootup.script`:

```sh
if ! systemctl is-active --quiet lg-wrapper.service; then
    systemd-run --unit=lg-wrapper --collect \
        -p User=lg -p SupplementaryGroups=frrvty \
        -p Restart=always -p RestartSec=2 \
        -p EnvironmentFile=/config/looking-glass/wrapper.env \
        /config/looking-glass/wrapper
fi
```

Manage it with:

```sh
systemctl status lg-wrapper
journalctl -u lg-wrapper
systemctl stop lg-wrapper
```

## Loopback Firewall

The wrapper listens on `127.0.0.1:8080`, and `cloudflared` reaches it over
loopback. A default-drop input firewall needs an explicit accept rule for `lo`
before any drop rules. The exact keyword varies by VyOS version, but the shape is:

```sh
set firewall ipv4 input filter rule 5 action accept
set firewall ipv4 input filter rule 5 inbound-interface name lo
set firewall ipv6 input filter rule 5 action accept
set firewall ipv6 input filter rule 5 inbound-interface name lo
```

Commit and save as usual for your VyOS configuration workflow.

## Cloudflared On VyOS

Copy the tunnel config template and fill in your tunnel UUID, credentials file,
and wrapper-origin hostname:

```sh
cp deploy/cloudflared/config.yml.example deploy/cloudflared/config.yml
```

The ingress service should stay loopback-only:

```yaml
ingress:
  - hostname: lg-api.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

On VyOS, run `cloudflared` as a podman container via `set container` with host
networking so `127.0.0.1:8080` resolves to the wrapper on the router:

```text
set container name cloudflared allow-host-networks
```

Keep the cloudflared config and tunnel credentials on persistent storage so they
survive image upgrades. The tunnel dials out over HTTPS/QUIC; do not open inbound
ports to the wrapper.
