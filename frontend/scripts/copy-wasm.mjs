// Verify the generated ghostty-vt wasm exists before a dev/build run.
//
// The artifact is built by ../../scripts/build-ghostty-vt.sh and is intentionally
// gitignored. It is imported in app/components/terminal.tsx via `?url`, so Vite
// emits it under /assets/ with a content hash (cached immutably) — we no longer
// stage a second, unhashed copy into public/. This step just fails fast with a
// clear message if the source artifact is missing.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const src = fileURLToPath(new URL("app/lib/ghostty/ghostty-vt.wasm", root));

if (!existsSync(src)) {
	console.error(
		"missing app/lib/ghostty/ghostty-vt.wasm; run ./scripts/build-ghostty-vt.sh from the repo root first",
	);
	process.exit(1);
}

console.log("ghostty-vt.wasm present (emitted with a content hash by Vite)");
