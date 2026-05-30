# Vendored libghostty-vt (WebAssembly)

`ghostty-vt.wasm` is the **libghostty-vt** terminal state machine from
[Ghostty](https://github.com/ghostty-org/ghostty), compiled to
`wasm32-freestanding`. It parses a raw terminal byte stream (VT/ANSI sequences,
including SGR colors and `\r` redraws) into a cell grid that we render to a
canvas in the browser. Non-interactive: we only *write* bytes and *read* the
grid — no PTY, no input encoding.

- **Upstream:** ghostty-org/ghostty
- **Pinned commit:** `cb36966a752982014827a9cabcf630ec3788b3d9`
- **Zig:** 0.15.2 · **target:** `wasm32-freestanding` · **optimize:** ReleaseSmall
- **License:** MIT — see [`LICENSE-ghostty`](./LICENSE-ghostty)
  (Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors).

> The libghostty-vt C API is explicitly marked *not yet stable*. If you bump the
> pinned commit, re-check the bindings against the headers.

## Bindings

- `wasm.ts` — low-level loader (compiles + instantiates; stubs the one `env.log`
  import) and the typed export surface.
- `terminal.ts` — `GhosttyTerminal`: lifecycle, `write`, `readViewport` (text +
  resolved colors + style per cell), scroll, and `toPlainText` (full
  screen + scrollback, for copy).
- `renderer.ts` — `TerminalView`: draws the viewport to a `<canvas>`, grows the
  pane with content then scrolls, DPR-aware.

The ABI (struct field offsets, enum values, by-pointer vs. by-value argument
passing) was verified empirically — `ghostty_type_json()` reports the exact
struct layout for the build. Re-verify after a pin bump:

```sh
node scripts/ghostty-harness.mjs                              # dump signatures + type_json
node --loader ./scripts/ts-resolve.mjs scripts/ghostty-binding-test.mjs  # drive terminal.ts end-to-end
```

## Serving

A bare `.wasm` import is rewritten by `@cloudflare/vite-plugin` into a Workers
`CompiledWasm` module, which breaks the client-side streaming fetch. So
`terminal.tsx` imports it with the `?url` suffix
(`import WASM_URL from "../lib/ghostty/ghostty-vt.wasm?url"`): Vite emits it
under `/assets/` with a **content hash** (so it rides the immutable asset cache)
and hands back the hashed URL, which the client fetches at runtime. The gitignored
artifact at `app/lib/ghostty/ghostty-vt.wasm` stays the source of truth;
`scripts/copy-wasm.mjs` only verifies it exists before a `predev`/`prebuild` run.

## Rebuilding

```sh
./scripts/build-ghostty-vt.sh   # Docker-based, reproducible; overwrites this .wasm
```

CI rebuilds with the same pin and fails if the result differs from the committed
binary (drift check), so the vendored artifact stays honest without requiring a
Zig toolchain to deploy.
