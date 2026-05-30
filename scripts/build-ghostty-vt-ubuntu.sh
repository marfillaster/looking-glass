#!/usr/bin/env bash
# Build libghostty-vt to WebAssembly on Ubuntu/Linux without Docker.
#
# This is the GitHub Actions path. The local/mac script uses Docker to avoid
# host SDK linker issues, but Ubuntu runners can build directly with Linux Zig.
#
# Output: frontend/app/lib/ghostty/ghostty-vt.wasm (generated, ReleaseSmall).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/ghostty-vt.env"

OUT="$ROOT/frontend/app/lib/ghostty/ghostty-vt.wasm"
WORK="$ROOT/.lg-build"
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && ARCH="aarch64"

case "$(uname -s)" in
	Linux) ;;
	*)
		echo "build-ghostty-vt-ubuntu.sh only supports Linux; use scripts/build-ghostty-vt.sh locally" >&2
		exit 1
		;;
esac

mkdir -p "$WORK"

# 1. Ghostty source at the pinned commit.
if [ ! -d "$WORK/ghostty/.git" ]; then
	git clone "$GHOSTTY_REPO" "$WORK/ghostty"
fi
git -C "$WORK/ghostty" fetch --depth 1 origin "$GHOSTTY_COMMIT" 2>/dev/null || true
git -C "$WORK/ghostty" checkout -q "$GHOSTTY_COMMIT"

# 2. Linux Zig toolchain (matches the runner arch).
ZIG_DIR="$WORK/zig-${ARCH}-linux-${ZIG_VERSION}"
if [ ! -x "$ZIG_DIR/zig" ]; then
	curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-${ARCH}-linux-${ZIG_VERSION}.tar.xz" \
		| tar -xJ -C "$WORK"
fi

# 3. Build directly on Ubuntu/Linux (ReleaseSmall).
export ZIG_GLOBAL_CACHE_DIR="$WORK/zig-cache"
(
	cd "$WORK/ghostty"
	"$ZIG_DIR/zig" build \
		-Demit-lib-vt=true \
		-Dtarget=wasm32-freestanding \
		-Doptimize=ReleaseSmall
)

cp "$WORK/ghostty/zig-out/bin/ghostty-vt.wasm" "$OUT"
echo "Generated $(du -h "$OUT" | cut -f1) -> $OUT"
