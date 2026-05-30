#!/usr/bin/env bash
# Local deploy for the looking-glass Worker (frontend).
#
# Deploy happens from a trusted local machine, NOT from CI — this is a public
# repo, so no Cloudflare API token lives in GitHub. The GitHub Actions deploy
# workflow is shipped only as an opt-in template under deploy/github-actions/.
#
# Prereqs (one-time):
#   - Docker running (used to build the gitignored ghostty-vt.wasm on macOS).
#   - wrangler authenticated: run `wrangler login`, OR export
#     CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in your shell.
#   - Worker secrets already set once (see deploy runbook):
#       wrangler secret put CF_ACCESS_CLIENT_ID
#       wrangler secret put CF_ACCESS_CLIENT_SECRET
#   - Production vars (LG_API_BASE_URL + UI copy) set in the gitignored
#     frontend/wrangler.prod.jsonc, or placeholders from wrangler.json are used.
#
# Usage:
#   scripts/deploy.sh              # build wasm if missing, then build + deploy
#   scripts/deploy.sh --rebuild-wasm   # force a fresh wasm build first
#   scripts/deploy.sh --dry-run    # build + `wrangler deploy --dry-run`, no upload
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
WASM="$ROOT/frontend/app/lib/ghostty/ghostty-vt.wasm"

rebuild_wasm=0
dry_run=0
for arg in "$@"; do
	case "$arg" in
		--rebuild-wasm) rebuild_wasm=1 ;;
		--dry-run) dry_run=1 ;;
		*) echo "unknown arg: $arg" >&2; exit 2 ;;
	esac
done

if [[ "$rebuild_wasm" == 1 || ! -f "$WASM" ]]; then
	echo "==> Building ghostty-vt.wasm (Docker)…"
	"$ROOT/scripts/build-ghostty-vt.sh"
else
	echo "==> Reusing existing wasm: $WASM"
fi

cd "$ROOT/frontend"
echo "==> Installing frontend deps (npm ci)…"
npm ci

# The @cloudflare/vite-plugin bakes vars/routes into a generated deploy config
# (build/server/wrangler.json) at BUILD time. To ship real prod vars/branding +
# the custom domain, point the build at the gitignored prod config; otherwise
# the committed placeholder wrangler.json is used.
build_env=()
if [[ -f wrangler.prod.jsonc ]]; then
	echo "==> Building with wrangler.prod.jsonc"
	build_env=(WRANGLER_CONFIG=wrangler.prod.jsonc)
else
	echo "==> wrangler.prod.jsonc not found — building with committed wrangler.json (placeholders)"
fi

echo "==> Building…"
env "${build_env[@]}" npm run build

# Deploy the GENERATED config (main=index.js, no_bundle), never the source
# config — the source main is workers/app.ts, which makes wrangler re-bundle and
# fail on the react-router "virtual:react-router/server-build" module.
gen_config="build/server/wrangler.json"
if [[ ! -f "$gen_config" ]]; then
	echo "ERROR: expected generated config $gen_config missing after build" >&2
	exit 1
fi

if [[ "$dry_run" == 1 ]]; then
	echo "==> Dry-run deploy (no upload)…"
	npx wrangler deploy --dry-run -c "$gen_config"
else
	echo "==> Deploying Worker…"
	npx wrangler deploy -c "$gen_config"
fi
