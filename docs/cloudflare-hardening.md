# Cloudflare Hardening

This project relies on Cloudflare for the public edge and keeps the vantage-side
wrapper private behind Cloudflare Tunnel + Access. The mandatory local HAProxy
gate is the hard concurrency cap; Cloudflare can add a useful outer guard:

- challenge human page loads on the public frontend hostname;
- rate-limit command traffic on the backend API hostname as a courtesy throttle;
- keep API failures machine-friendly (`429`) instead of challenge pages.

Use placeholders below with your own hostnames:

- public frontend: `lg.example.com`
- tunneled wrapper API: `lg-api.example.com`

## Baseline

Before adding these rules, deploy the normal security path:

1. The wrapper listens on `127.0.0.1:8081` only.
2. HAProxy listens on `127.0.0.1:8080` and forwards to the wrapper with a
   backend `maxconn` hard cap.
3. `cloudflared` forwards `lg-api.example.com` to `http://127.0.0.1:8080`.
4. `lg-api.example.com` is protected by a Cloudflare Access Service Auth policy.
5. The Worker sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
6. Public users only browse `lg.example.com`; they do not call the wrapper API
   hostname directly.

The hardening rules below are additive. They are not a replacement for Access or
the wrapper's loopback-only boundary, and they are not a replacement for the
local HAProxy `maxconn` cap.

## Frontend HTML Challenge

Challenge only the browser-facing HTML shell:

```text
http.host eq "lg.example.com"
and http.request.method eq "GET"
and http.request.uri.path eq "/"
and not cf.client.bot
```

Action:

```text
managed_challenge
```

Do not challenge `/api/*` or static assets. Browser APIs (`fetch`,
`EventSource`) do not handle Cloudflare challenge pages like normal users do,
and content-hashed assets should stay cacheable.

The `not cf.client.bot` clause exempts Cloudflare's known good bots and
crawlers, including major search engine crawlers and verified bot categories.
This matters for indexing: a Managed Challenge is a browser challenge, and many
crawlers cannot complete it. Cloudflare-verified bots bypass this rule; bots
that Cloudflare does not verify may still be challenged. If the site must be
fully crawlable by arbitrary AI agents and non-verified crawlers, do not deploy
the homepage challenge rule.

## Backend API Rate Limit

Rate-limit command endpoints on the backend API hostname as a courtesy throttle:

```text
http.host eq "lg-api.example.com"
and http.request.uri.path in {"/api/bgp" "/api/ping" "/api/traceroute"}
```

Action:

```text
block
```

Cloudflare's default block response for rate limiting is `429 Too Many
Requests`, which is what the frontend expects. BGP uses `fetch`, checks
`res.ok` before parsing JSON, and therefore tolerates a plain-text or HTML `429`
body. Probe streams use `EventSource`; browsers do not expose the HTTP status,
so the UI shows a generic stream-closed/rate-limited message.

## Free Plan Shape

On Cloudflare Free, the practical rate-limit shape is constrained:

- only one zone-level rule in the `http_ratelimit` phase;
- only a `10` second period;
- only a `10` second mitigation timeout for `block`;
- `cf.colo.id` is mandatory and cannot be the only characteristic;
- stable characteristics such as `http.host` or request headers require
  Advanced Rate Limiting.

That means a Free-plan shared backend courtesy throttle looks like:

```json
{
  "characteristics": ["cf.colo.id", "ip.src"],
  "period": 10,
  "requests_per_period": 3,
  "mitigation_timeout": 10
}
```

This is not DoS protection and not a true global concurrency cap. It is a
short-window throttle keyed by Cloudflare data center and source IP. It can
absorb some obvious bursts before they reach the router, but HAProxy `maxconn`
remains the hard bound.

## Rulesets API Example

Set `ZONE_ID` and `CLOUDFLARE_API_TOKEN`, then create the two entrypoint
rulesets. If your zone already has entrypoint rulesets for these phases, add or
patch rules instead of creating duplicate rulesets.

```sh
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{
    "name": "looking-glass backend API rate limit",
    "kind": "zone",
    "phase": "http_ratelimit",
    "rules": [
      {
        "ref": "looking_glass_backend_api_rate_limit",
        "description": "Looking Glass backend API rate limit",
        "expression": "(http.host eq \"lg-api.example.com\" and http.request.uri.path in {\"/api/bgp\" \"/api/ping\" \"/api/traceroute\"})",
        "action": "block",
        "ratelimit": {
          "characteristics": ["cf.colo.id", "ip.src"],
          "period": 10,
          "requests_per_period": 3,
          "mitigation_timeout": 10
        }
      }
    ]
  }'

curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{
    "name": "looking-glass frontend HTML challenge",
    "kind": "zone",
    "phase": "http_request_firewall_custom",
    "rules": [
      {
        "ref": "looking_glass_frontend_html_managed_challenge",
        "description": "Managed challenge for Looking Glass HTML shell, excluding verified bots",
        "expression": "(http.host eq \"lg.example.com\" and http.request.method eq \"GET\" and http.request.uri.path eq \"/\" and not cf.client.bot)",
        "action": "managed_challenge"
      }
    ]
  }'
```

Verify the active rules:

```sh
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_ratelimit/entrypoint" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_request_firewall_custom/entrypoint" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

## Local Hard Cap

Cloudflare rate limiting counts request rate, not live command processes. The
wrapper intentionally stays a dumb command adapter and does not enforce global
concurrency. The production hard cap belongs in the local loopback HAProxy
between `cloudflared` and the wrapper; its backend `maxconn` is the real bound
for this vantage point.

Advanced Rate Limiting can improve the edge keying model with stable
characteristics like `http.host`, selected headers, cookies, or custom counting
expressions. Even then, `cf.colo.id` remains part of the rate-limit
characteristics, so it is still per-Cloudflare-colo rather than one global
counter.
