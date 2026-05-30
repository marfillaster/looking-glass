// Validates the real terminal.ts bindings under Node (type-stripping).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GhosttyTerminal } from "../app/lib/ghostty/terminal.ts";

const wasm = readFileSync(
  fileURLToPath(new URL("../app/lib/ghostty/ghostty-vt.wasm", import.meta.url)),
);
const term = await GhosttyTerminal.create(wasm, { cols: 40, rows: 6, maxScrollback: 1000 });

term.write("\x1b[31mhello\x1b[0m \x1b[1;32mworld\x1b[0m\r\n");
for (let i = 1; i <= 10; i++) term.write(`line ${i}\r\n`);

const vp = term.readViewport();
console.log(`viewport ${vp.cols}x${vp.rows} fg=${JSON.stringify(vp.defaultFg)} bg=${JSON.stringify(vp.defaultBg)}`);
for (const row of vp.cells) {
  const text = row.map((c) => c.text || " ").join("").trimEnd();
  if (text) console.log(`  | ${text}`);
}
const sb = term.getScrollbar();
console.log("scrollbar", sb);

console.log("--- scroll to top ---");
term.scrollToTop();
const top = term.readViewport();
console.log("top row0:", JSON.stringify(top.cells[0].map((c) => c.text || " ").join("").trimEnd()));

console.log("--- plain text (full scrollback) ---");
console.log(term.toPlainText());

// styled-cell assertions
term.scrollToTop();
const v2 = term.readViewport();
const r0 = v2.cells[0];
const h = r0[0]; // 'h' of hello -> red
const w = r0[6]; // 'w' of world -> green bold
console.log("ASSERT h:", h.text, JSON.stringify(h.fg), "bold=", h.bold);
console.log("ASSERT w:", w.text, JSON.stringify(w.fg), "bold=", w.bold);

term.dispose();
console.log("DONE (disposed)");
