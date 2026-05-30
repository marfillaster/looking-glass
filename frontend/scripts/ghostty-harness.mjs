// Empirical ABI harness for ghostty-vt.wasm.
// 1. Parses the wasm type section to print exact signatures of the exports we
//    care about (resolves the by-value struct calling convention).
// 2. Dumps ghostty_type_json() (struct field offsets for this target).
// 3. Drives a tiny terminal end-to-end and reads the grid back.
//
// Run: node frontend/scripts/ghostty-harness.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(
  new URL("../app/lib/ghostty/ghostty-vt.wasm", import.meta.url),
);
const bytes = readFileSync(wasmPath);

// ---- Minimal wasm parser: type, import, function, export sections ----
function parseSignatures(buf) {
  const u8 = new Uint8Array(buf);
  let p = 8; // skip magic + version
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  function uleb() {
    let result = 0, shift = 0, b;
    do {
      b = u8[p++];
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return result >>> 0;
  }
  const VT = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64" };
  const types = []; // [params[], results[]]
  const importedFuncs = []; // typeidx
  const funcs = []; // typeidx for module-defined funcs
  const exports = []; // {name, kind, index}
  while (p < u8.length) {
    const id = u8[p++];
    const size = uleb();
    const end = p + size;
    if (id === 1) {
      const n = uleb();
      for (let i = 0; i < n; i++) {
        const form = u8[p++]; // 0x60 func
        void form;
        const np = uleb();
        const params = [];
        for (let j = 0; j < np; j++) params.push(VT[u8[p++]] ?? "?");
        const nr = uleb();
        const results = [];
        for (let j = 0; j < nr; j++) results.push(VT[u8[p++]] ?? "?");
        types.push({ params, results });
      }
    } else if (id === 2) {
      const n = uleb();
      for (let i = 0; i < n; i++) {
        const mlen = uleb(); p += mlen;
        const nlen = uleb(); p += nlen;
        const kind = u8[p++];
        if (kind === 0) importedFuncs.push(uleb());
        else if (kind === 1) { p++; const f = u8[p++]; if (f & 1) uleb(); uleb(); } // table
        else if (kind === 2) { const f = u8[p++]; if (f & 1) uleb(); uleb(); } // mem
        else if (kind === 3) { p++; p++; } // global: valtype + mut
      }
    } else if (id === 3) {
      const n = uleb();
      for (let i = 0; i < n; i++) funcs.push(uleb());
    } else if (id === 7) {
      const n = uleb();
      for (let i = 0; i < n; i++) {
        const nlen = uleb();
        const name = Buffer.from(u8.subarray(p, p + nlen)).toString("utf8");
        p += nlen;
        const kind = u8[p++];
        const index = uleb();
        exports.push({ name, kind, index });
      }
    }
    p = end;
  }
  // Map an exported function name -> signature
  const sigOf = (name) => {
    const e = exports.find((x) => x.name === name && x.kind === 0);
    if (!e) return null;
    const localIdx = e.index - importedFuncs.length;
    const typeidx = localIdx < 0 ? importedFuncs[e.index] : funcs[localIdx];
    return types[typeidx];
  };
  return { sigOf, exports };
}

const { sigOf } = parseSignatures(bytes);
const interesting = [
  "ghostty_terminal_new",
  "ghostty_terminal_free",
  "ghostty_terminal_resize",
  "ghostty_terminal_vt_write",
  "ghostty_terminal_scroll_viewport",
  "ghostty_terminal_get",
  "ghostty_render_state_new",
  "ghostty_render_state_update",
  "ghostty_render_state_get",
  "ghostty_render_state_colors_get",
  "ghostty_render_state_row_iterator_new",
  "ghostty_render_state_row_iterator_next",
  "ghostty_render_state_row_get",
  "ghostty_render_state_row_cells_new",
  "ghostty_render_state_row_cells_next",
  "ghostty_render_state_row_cells_select",
  "ghostty_render_state_row_cells_get",
  "ghostty_color_rgb_get",
  "ghostty_alloc",
  "ghostty_free",
  "ghostty_wasm_alloc_opaque",
  "ghostty_type_json",
];
console.log("=== EXPORT SIGNATURES ===");
for (const name of interesting) {
  const s = sigOf(name);
  console.log(
    `${name}(${s ? s.params.join(", ") : "??"})` +
      (s && s.results.length ? ` -> ${s.results.join(", ")}` : " -> void"),
  );
}

// ---- Instantiate ----
const logs = [];
const imports = {
  env: {
    log: (...args) => logs.push(args),
  },
};
const { instance } = await WebAssembly.instantiate(bytes, imports);
const ex = instance.exports;
const mem = ex.memory;
let dv = new DataView(mem.buffer);
const refreshDv = () => (dv = new DataView(mem.buffer));

// cstring reader for type_json
function cstr(ptr) {
  refreshDv();
  const u8 = new Uint8Array(mem.buffer);
  let end = ptr;
  while (u8[end] !== 0) end++;
  return Buffer.from(u8.subarray(ptr, end)).toString("utf8");
}

console.log("\n=== ghostty_type_json (relevant structs) ===");
const jsonPtr = ex.ghostty_type_json();
const typeJson = JSON.parse(cstr(jsonPtr));
for (const key of Object.keys(typeJson)) {
  if (
    /Terminal|Render|Color|Cell|Style|Buffer|ScrollViewport/.test(key)
  ) {
    console.log(key, JSON.stringify(typeJson[key]));
  }
}
console.log("\nALL type_json keys:", Object.keys(typeJson).join(", "));
