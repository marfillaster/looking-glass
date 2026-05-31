# Looking Glass Frontend

React Router v7 SSR app for the public looking-glass UI. The default production
target is Cloudflare Workers; `server/index.js` also provides an optional
Node/Express runtime.

## Local Setup

The terminal renderer depends on `ghostty-vt.wasm`, which is generated and
ignored by git. For local/mac development, use the Docker-based build script:

```sh
../scripts/build-ghostty-vt.sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Point `.dev.vars` at a local wrapper or the stub wrapper described in the
top-level README.

## Checks

```sh
npm run typecheck
npm run build
npm run check
```

`npm run build` verifies `app/lib/ghostty/ghostty-vt.wasm` is present, then Vite
emits it as a content-hashed static asset through the `?url` import.

## Global Command Gate

The frontend has an additional global command concurrency gate in front of the
box-side HAProxy gate. It rejects excess `/api/bgp`, `/api/ping`, and
`/api/traceroute` requests with `429`, which the terminal UI treats as "backend
busy" and retries. `/api/healthz` is intentionally not gated.

This is belt-and-suspenders. HAProxy remains the hard authority on the box; the
frontend gate is a pre-filter that fails open if its backend is unavailable.
Every acquired slot has a TTL, so a dropped browser or dead stream cannot leak a
slot forever.

Cloudflare Workers use the `COMMAND_GATE` Durable Object binding declared in
`wrangler.json`. Node/Express uses Redis only when `LG_REDIS_URL` is set;
otherwise it installs a no-op gate and relies on HAProxy.

There is no separate Durable Object activation step after deploy. The Worker
config declares the `COMMAND_GATE` binding, and Wrangler registers the Durable
Object class during `wrangler deploy`. The global DO instance itself is lazy and
appears on the first command request that resolves `idFromName("global")`.

Config:

```sh
LG_MAX_CONCURRENT=4
LG_GATE_TTL_SEC=30
LG_REDIS_URL=redis://localhost:6379 # Node only, optional
```

The Durable Object gate is deliberately a single global key. That means every
command makes a small round trip to one single-threaded object pinned to one
Cloudflare colo. That is fine for looking-glass traffic, and fail-open degrades
to HAProxy-only if the DO has a bad moment. It is the structural tradeoff of a
true global cap rather than per-IP keying.

## Deploy

Local deploys are the safe default for a public repo:

```sh
cd ..
scripts/deploy.sh
scripts/deploy.sh --dry-run
```

The opt-in GitHub Actions deploy workflow lives at
`deploy/github-actions/deploy.yml.template`; it does not run unless copied to
`.github/workflows/`.
