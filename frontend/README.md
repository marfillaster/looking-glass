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
