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
LG_LISTEN_ADDR=127.0.0.1:8081
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
        -p NoNewPrivileges=true -p ProtectSystem=strict \
        -p ProtectHome=true -p PrivateTmp=true \
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

The wrapper listens on loopback, and `cloudflared` reaches the local service
over loopback. A default-drop input firewall needs an explicit accept rule for
`lo` before any drop rules. The exact keyword varies by VyOS version, but the
shape is:

```sh
set firewall ipv4 input filter rule 5 action accept
set firewall ipv4 input filter rule 5 inbound-interface name lo
set firewall ipv6 input filter rule 5 action accept
set firewall ipv6 input filter rule 5 inbound-interface name lo
```

Commit and save as usual for your VyOS configuration workflow.

## HAProxy Local Concurrency Gate

Deploy HAProxy on loopback in front of the wrapper. This is the mandatory local
concurrency gate and the only true global cap for this vantage point. Cloudflare
rate limiting is only a courtesy throttle; HAProxy `maxconn` is the hard DoS
bound for concurrent origin pressure. It is not a direct subprocess-lifetime
controller.

```text
cloudflared -> 127.0.0.1:8080 (HAProxy) -> 127.0.0.1:8081 (wrapper)
```

The wrapper environment above already binds the wrapper to `8081`:

```sh
LG_LISTEN_ADDR=127.0.0.1:8081
```

Create `/config/haproxy/haproxy.cfg`:

```haproxy
global
  log stdout format raw local0
  maxconn 64

defaults
  mode http
  option httplog
  option dontlognull
  timeout connect 2s
  timeout client 75s
  timeout server 75s
  timeout queue 1s

frontend looking_glass
  bind 127.0.0.1:8080
  stick-table type string size 16 expire 2m store conn_cur
  acl command_path path /api/bgp /api/ping /api/traceroute
  http-request track-sc0 str(lg-commands) if command_path
  http-request deny deny_status 429 content-type text/plain lf-string "too many active looking-glass commands\n" if command_path { sc0_conn_cur gt 4 }
  default_backend wrapper

backend wrapper
  server wrapper 127.0.0.1:8081 check maxconn 4
```

`maxconn 4` is the hard stop to the wrapper origin. The stick-table rule gives
command paths a clean `429` before HAProxy queues. Adjust both `maxconn 4` and
`gt 4` together for a different cap.

Run HAProxy as a VyOS-managed container with host networking:

```text
set container name haproxy image docker.io/haproxy:2.9-alpine
set container name haproxy allow-host-networks
set container name haproxy restart always
set container name haproxy arguments 'haproxy -f /usr/local/etc/haproxy/haproxy.cfg'
set container name haproxy volume haproxy-config source /config/haproxy
set container name haproxy volume haproxy-config destination /usr/local/etc/haproxy
```

Commit and save. Leave `cloudflared` pointed at `http://127.0.0.1:8080`; it now
reaches HAProxy instead of the wrapper directly.

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
networking so `127.0.0.1:8080` resolves to the router's loopback HAProxy
service:

```text
set container name cloudflared allow-host-networks
```

Keep the cloudflared config and tunnel credentials on persistent storage so they
survive image upgrades. The tunnel dials out over HTTPS/QUIC; do not open inbound
ports to the wrapper.
