#!/usr/bin/env bash
# Build libghostty-vt to WebAssembly locally, using a Linux container for host
# isolation.
#
# Why a container: libghostty-vt's product target is wasm32-freestanding (no
# host SDK needed), but Zig's *build runner* links against the host libc. On a
# macOS 26 host, Zig 0.15.2's bundled linker cannot parse the macOS 26 SDK's
# .tbd stub format, so the host link fails. Building inside a Linux container
# sidesteps the host toolchain entirely. GitHub Actions uses
# scripts/build-ghostty-vt-ubuntu.sh instead.
#
# Container runtime: prefers `container` (Apple, brew install container), falls
# back to `docker`. Override with CONTAINER_RUNTIME=docker|container.
#
# Output: frontend/app/lib/ghostty/ghostty-vt.wasm (generated, ReleaseSmall).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/ghostty-vt.env"

OUT="$ROOT/frontend/app/lib/ghostty/ghostty-vt.wasm"
WORK="$ROOT/.lg-build"
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && ARCH="aarch64"

# Resolve container runtime.
if [ -z "${CONTAINER_RUNTIME:-}" ]; then
	if command -v container &>/dev/null && container system status &>/dev/null 2>&1; then
		CONTAINER_RUNTIME=container
	elif command -v docker &>/dev/null; then
		CONTAINER_RUNTIME=docker
	else
		echo "error: no container runtime found (install 'container' or 'docker')" >&2
		exit 1
	fi
fi
echo "==> Using container runtime: $CONTAINER_RUNTIME"

mkdir -p "$WORK"

# 1. Ghostty source at the pinned commit.
if [ ! -d "$WORK/ghostty/.git" ]; then
	git clone "$GHOSTTY_REPO" "$WORK/ghostty"
fi
git -C "$WORK/ghostty" fetch --depth 1 origin "$GHOSTTY_COMMIT" 2>/dev/null || true
git -C "$WORK/ghostty" checkout -q "$GHOSTTY_COMMIT"

# 2. Linux Zig toolchain (matches the container arch).
ZIG_DIR="$WORK/zig-${ARCH}-linux-${ZIG_VERSION}"
if [ ! -x "$ZIG_DIR/zig" ]; then
	curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-${ARCH}-linux-${ZIG_VERSION}.tar.xz" \
		| tar -xJ -C "$WORK"
fi

# 3. Build in a Linux container (ReleaseSmall).
"$CONTAINER_RUNTIME" run --rm \
	-v "$WORK/ghostty:/src" \
	-v "$ZIG_DIR:/zig:ro" \
	-w /src \
	debian:bookworm-slim bash -lc '
		set -e
		apt-get update -qq >/dev/null && apt-get install -y -qq git ca-certificates xz-utils >/dev/null
		export ZIG_GLOBAL_CACHE_DIR=/src/.docker-zig-cache
		/zig/zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
	'

cp "$WORK/ghostty/zig-out/bin/ghostty-vt.wasm" "$OUT"
echo "Generated $(du -h "$OUT" | cut -f1) -> $OUT"
