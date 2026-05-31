# Ubuntu / BIRD2 Router Setup

Use this when the looking-glass vantage point is an Ubuntu host running BIRD2.
The wrapper uses `birdc -r` for BGP table queries and Linux `ping` /
`traceroute` for probes.

## Host Packages

Install the routing daemon, probe tools, and `cloudflared` using your normal
Ubuntu package-management flow:

```sh
sudo apt-get update
sudo apt-get install -y bird2 iputils-ping traceroute
```

Install `cloudflared` from Cloudflare's package repository or release package.
The looking-glass config below only assumes the `cloudflared` binary and a
tunnel credentials JSON are present.

## Build And Install The Wrapper

Build the static Go binary from a development machine or on the Ubuntu host:

```sh
cd wrapper
go test ./...
go build -o wrapper ./cmd/wrapper
```

Install it under `/opt`:

```sh
sudo install -d -m 0755 /opt/looking-glass
sudo install -m 0755 wrapper /opt/looking-glass/wrapper
```

Create an unprivileged runtime user. Give it supplementary access to the BIRD
control socket group, usually `bird` on Ubuntu:

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin lg
sudo usermod -aG bird lg
```

Verify the control socket group on your host and adjust `SupplementaryGroups=`
below if your package uses a different group:

```sh
stat -c '%G %n' /run/bird/bird.ctl 2>/dev/null || stat -c '%G %n' /var/run/bird/bird.ctl
```

## Wrapper Environment

Create `/etc/looking-glass/wrapper.env`:

```sh
sudo install -d -m 0755 /etc/looking-glass
sudo tee /etc/looking-glass/wrapper.env >/dev/null <<'EOF'
LG_LISTEN_ADDR=127.0.0.1:8081
LG_ROUTING_BACKEND=bird
LG_BIRDC_PATH=/usr/sbin/birdc
LG_PING_PATH=/usr/bin/ping
LG_TRACEROUTE_PATH=/usr/bin/traceroute
LG_BIRD_TABLE_V4=master4
LG_BIRD_TABLE_V6=master6
LG_ADDRESS_FAMILIES=ipv4,ipv6
EOF
```

Full settings and bounds are documented in
[`wrapper/.env.example`](../wrapper/.env.example). Keep
`LG_LISTEN_ADDR` on loopback in production; the wrapper has no application-layer
client auth.

The Worker must use the same frontend-visible routing backend:

```text
LG_ROUTING_BACKEND=bird
```

That switches the UI from FRR AS-path regex examples to BIRD path-mask examples.

## Systemd Service

Create `/etc/systemd/system/lg-wrapper.service`:

```ini
[Unit]
Description=Looking Glass wrapper
After=network-online.target bird.service
Wants=network-online.target

[Service]
Type=simple
User=lg
Group=lg
SupplementaryGroups=bird
EnvironmentFile=/etc/looking-glass/wrapper.env
ExecStart=/opt/looking-glass/wrapper
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
```

Enable it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now lg-wrapper.service
sudo systemctl status lg-wrapper.service
```

Check logs with:

```sh
journalctl -u lg-wrapper.service
```

## Loopback Firewall

The wrapper listens on loopback, and `cloudflared` reaches the local service
over loopback. Ubuntu normally accepts loopback traffic by default. If you run a
default-drop firewall, make sure loopback is accepted before any drop rules.

For UFW:

```sh
sudo ufw allow in on lo
```

For nftables, the input chain should include an early rule like:

```nft
iif "lo" accept
```

Do not expose the wrapper port on a public or LAN interface.

## HAProxy Local Concurrency Gate

Deploy HAProxy on loopback in front of the wrapper. This is the mandatory local
concurrency gate and the only true global cap for this vantage point. Cloudflare
rate limiting is only a courtesy throttle; HAProxy `maxconn` is the hard DoS
bound for concurrent origin pressure. It is not a direct subprocess-lifetime
controller.

```text
cloudflared -> 127.0.0.1:8080 (HAProxy) -> 127.0.0.1:8081 (wrapper)
```

Install HAProxy:

```sh
sudo apt-get update
sudo apt-get install -y haproxy
```

The wrapper environment above already binds the wrapper to `8081`:

```sh
LG_LISTEN_ADDR=127.0.0.1:8081
```

Create `/etc/haproxy/haproxy.cfg`:

```haproxy
global
  log /dev/log local0
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

Restart both services:

```sh
sudo systemctl restart lg-wrapper.service
sudo systemctl enable --now haproxy
sudo systemctl status haproxy
```

Leave `cloudflared` pointed at `http://127.0.0.1:8080`; it now reaches HAProxy
instead of the wrapper directly.

## Cloudflared On Ubuntu

Create the cloudflared config directory and copy the tunnel template:

```sh
sudo install -d -m 0755 /etc/cloudflared
sudo cp deploy/cloudflared/config.yml.example /etc/cloudflared/config.yml
```

Edit `/etc/cloudflared/config.yml` with your tunnel UUID, credentials file, and
wrapper-origin hostname. The ingress service should stay loopback-only:

```yaml
ingress:
  - hostname: lg-api.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Install and start the service:

```sh
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

The tunnel dials out over HTTPS/QUIC; do not open inbound ports to the wrapper.
