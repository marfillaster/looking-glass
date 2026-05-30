/**
 * High-level binding around a single libghostty-vt terminal instance.
 *
 * Non-interactive: we only *write* a VT byte stream (program output) and *read*
 * the resulting cell grid back for rendering. There is no PTY and no input
 * encoding. One {@link GhosttyTerminal} owns one wasm terminal + render state +
 * formatter, all backed by the same module instance.
 *
 * ABI constants (enum values, struct field offsets, by-pointer struct passing)
 * are pinned to the build documented in `ghostty/README.md` and were verified
 * empirically — do not assume they survive a pin bump.
 */
import { instantiateGhostty, type GhosttyExports, type GhosttyModule } from "./wasm.ts";

// ---- Result codes (types.h: GhosttyResult) ----
const SUCCESS = 0;

// ---- render.h: GhosttyRenderStateData ----
const RS_DATA_COLS = 1;
const RS_DATA_ROWS = 2;
const RS_DATA_ROW_ITERATOR = 4;

// ---- render.h: GhosttyRenderStateRowData ----
const RS_ROW_DATA_CELLS = 3;

// ---- render.h: GhosttyRenderStateRowCellsData ----
const RS_CELL_STYLE = 2;
const RS_CELL_BG_COLOR = 5;
const RS_CELL_FG_COLOR = 6;
const RS_CELL_HAS_STYLING = 8;
const RS_CELL_GRAPHEMES_UTF8 = 9;

// ---- terminal.h: GhosttyTerminalData ----
const TERM_DATA_SCROLLBAR = 9;

// ---- terminal.h: GhosttyTerminalScrollViewportTag ----
const SCROLL_TOP = 0;
const SCROLL_BOTTOM = 1;
const SCROLL_DELTA = 2;

// ---- types.h: GhosttyFormatterFormat ----
const FORMAT_PLAIN = 0;

// ---- Struct sizes / field offsets (from ghostty_type_json on this target) ----
const SIZEOF_OPTIONS = 8; // {cols u16@0, rows u16@2, max_scrollback u32@4}
const SIZEOF_COLORS = 784; // {size u32@0, bg@4, fg@7, cursor@10, has@13, palette[256]@14}
const COLORS_BG_OFF = 4;
const COLORS_FG_OFF = 7;
const SIZEOF_BUFFER = 12; // {ptr@0, cap@4, len@8}
const SIZEOF_STYLE = 72;
const STYLE_BOLD = 56;
const STYLE_ITALIC = 57;
const STYLE_FAINT = 58;
const STYLE_INVERSE = 60;
const STYLE_INVISIBLE = 61;
const STYLE_STRIKETHROUGH = 62;
const STYLE_UNDERLINE = 64; // i32: 0 == none
const SIZEOF_SCROLL_VIEWPORT = 24; // {tag enum@0, value@8 (16)}
const SCROLL_DELTA_OFF = 8; // intptr_t delta (low 4 bytes on wasm32)
const SIZEOF_SCROLLBAR = 24; // {total u64@0, offset u64@8, len u64@16}
const SIZEOF_FMT_OPTIONS = 40; // {size@0, emit@4, unwrap@8, trim@9, extra@12(24), selection@36}

const TEXT_BUF_CAP = 256; // max bytes for one cell's grapheme cluster

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** One rendered cell. `fg`/`bg` are null when the cell uses the default. */
export interface TermCell {
	/** Grapheme cluster, or "" for a blank / wide-char spacer cell. */
	text: string;
	fg: Rgb | null;
	bg: Rgb | null;
	bold: boolean;
	faint: boolean;
	italic: boolean;
	underline: boolean;
	strikethrough: boolean;
	inverse: boolean;
	invisible: boolean;
}

/** A snapshot of the visible viewport grid. */
export interface Viewport {
	cols: number;
	rows: number;
	defaultFg: Rgb;
	defaultBg: Rgb;
	/** rows-major: `cells[y][x]`. Each row has up to `cols` entries. */
	cells: TermCell[][];
}

/** Scroll geometry for a scrollbar (terminal.h: GhosttyTerminalScrollbar). */
export interface Scrollbar {
	/** Total scrollable rows. */
	total: number;
	/** Row offset of the top of the viewport into `total`. */
	offset: number;
	/** Visible rows. */
	len: number;
}

export interface TerminalOptions {
	cols?: number;
	rows?: number;
	maxScrollback?: number;
}

/** A blank cell (used to pad short rows up to `cols`). */
export function blankCell(): TermCell {
	return {
		text: "",
		fg: null,
		bg: null,
		bold: false,
		faint: false,
		italic: false,
		underline: false,
		strikethrough: false,
		inverse: false,
		invisible: false,
	};
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class GhosttyTerminal {
	readonly #ex: GhosttyExports;
	readonly #mem: WebAssembly.Memory;

	#term: number;
	#state: number;
	#iter: number;
	#cells: number;
	#formatter: number;

	// Scratch allocations (stable wasm addresses; freed in dispose()).
	readonly #allocs: Array<[ptr: number, len: number]> = [];
	readonly #u16Ptr: number;
	readonly #colorsPtr: number;
	readonly #bufStructPtr: number;
	readonly #textBufPtr: number;
	readonly #fgPtr: number;
	readonly #bgPtr: number;
	readonly #stylePtr: number;
	readonly #hasStylingPtr: number;
	readonly #scrollPtr: number;
	readonly #scrollbarPtr: number;
	readonly #usizePtr: number;
	readonly #iterHandlePtr: number;
	readonly #cellsHandlePtr: number;

	cols: number;
	rows: number;

	private constructor(module: GhosttyModule, options: TerminalOptions) {
		this.#ex = module.exports;
		this.#mem = module.memory;
		const ex = this.#ex;

		this.cols = options.cols ?? 80;
		this.rows = options.rows ?? 24;
		const maxScrollback = options.maxScrollback ?? 5000;

		// --- scratch arena ---
		this.#u16Ptr = this.#alloc(4);
		this.#colorsPtr = this.#alloc(SIZEOF_COLORS);
		this.#bufStructPtr = this.#alloc(SIZEOF_BUFFER);
		this.#textBufPtr = this.#alloc(TEXT_BUF_CAP);
		this.#fgPtr = this.#alloc(4);
		this.#bgPtr = this.#alloc(4);
		this.#stylePtr = this.#alloc(SIZEOF_STYLE);
		this.#hasStylingPtr = this.#alloc(4);
		this.#scrollPtr = this.#alloc(SIZEOF_SCROLL_VIEWPORT);
		this.#scrollbarPtr = this.#alloc(SIZEOF_SCROLLBAR);
		this.#usizePtr = this.#alloc(8);
		this.#iterHandlePtr = this.#alloc(4);
		this.#cellsHandlePtr = this.#alloc(4);
		const termHandlePtr = this.#alloc(4);
		const stateHandlePtr = this.#alloc(4);
		const fmtHandlePtr = this.#alloc(4);

		// --- terminal ---
		const optsPtr = this.#alloc(SIZEOF_OPTIONS);
		let dv = this.#dv();
		dv.setUint16(optsPtr + 0, this.cols, true);
		dv.setUint16(optsPtr + 2, this.rows, true);
		dv.setUint32(optsPtr + 4, maxScrollback, true);
		if (ex.ghostty_terminal_new(0, termHandlePtr, optsPtr) !== SUCCESS) {
			throw new Error("ghostty_terminal_new failed");
		}
		this.#term = this.#dv().getUint32(termHandlePtr, true);

		// --- render state + iterators ---
		if (ex.ghostty_render_state_new(0, stateHandlePtr) !== SUCCESS) {
			throw new Error("ghostty_render_state_new failed");
		}
		this.#state = this.#dv().getUint32(stateHandlePtr, true);
		ex.ghostty_render_state_row_iterator_new(0, this.#iterHandlePtr);
		this.#iter = this.#dv().getUint32(this.#iterHandlePtr, true);
		ex.ghostty_render_state_row_cells_new(0, this.#cellsHandlePtr);
		this.#cells = this.#dv().getUint32(this.#cellsHandlePtr, true);

		// --- formatter (plain text, trimmed; reads current state each call) ---
		dv = this.#dv();
		const o = this.#alloc(SIZEOF_FMT_OPTIONS);
		new Uint8Array(this.#mem.buffer).fill(0, o, o + SIZEOF_FMT_OPTIONS);
		dv = this.#dv();
		dv.setUint32(o + 0, SIZEOF_FMT_OPTIONS, true);
		dv.setUint32(o + 4, FORMAT_PLAIN, true);
		dv.setUint8(o + 8, 1); // unwrap soft-wrapped lines (logical lines for copy)
		dv.setUint8(o + 9, 1); // trim trailing whitespace
		// extra struct @12 stays zero; selection @36 = NULL
		this.#formatter =
			ex.ghostty_formatter_terminal_new(0, fmtHandlePtr, this.#term, o) === SUCCESS
				? this.#dv().getUint32(fmtHandlePtr, true)
				: 0;
	}

	/** Load the module and create a terminal in one step. */
	static async create(
		wasmSource: string | BufferSource | WebAssembly.Module,
		options: TerminalOptions = {},
	): Promise<GhosttyTerminal> {
		const module = await instantiateGhostty(wasmSource);
		return new GhosttyTerminal(module, options);
	}

	/** Create a terminal on an already-instantiated module. */
	static fromModule(
		module: GhosttyModule,
		options: TerminalOptions = {},
	): GhosttyTerminal {
		return new GhosttyTerminal(module, options);
	}

	#alloc(len: number): number {
		const ptr = this.#ex.ghostty_alloc(0, len);
		if (!ptr) throw new Error(`ghostty_alloc(${len}) failed`);
		this.#allocs.push([ptr, len]);
		return ptr;
	}

	/** Fresh DataView over current memory (the buffer detaches when it grows). */
	#dv(): DataView {
		return new DataView(this.#mem.buffer);
	}

	#u8(): Uint8Array {
		return new Uint8Array(this.#mem.buffer);
	}

	#rgb(dv: DataView, off: number): Rgb {
		return { r: dv.getUint8(off), g: dv.getUint8(off + 1), b: dv.getUint8(off + 2) };
	}

	/** Feed VT-encoded bytes (or a string) into the terminal. Never throws. */
	write(data: string | Uint8Array): void {
		const bytes = typeof data === "string" ? encoder.encode(data) : data;
		if (bytes.length === 0) return;
		const ptr = this.#ex.ghostty_alloc(0, bytes.length);
		if (!ptr) return;
		this.#u8().set(bytes, ptr);
		this.#ex.ghostty_terminal_vt_write(this.#term, ptr, bytes.length);
		this.#ex.ghostty_free(0, ptr, bytes.length);
	}

	/** Full reset (RIS): clears screen, scrollback, modes; keeps dimensions. */
	reset(): void {
		this.#ex.ghostty_terminal_reset(this.#term);
	}

	/**
	 * Resize the grid. `cellWidthPx`/`cellHeightPx` only feed size reports
	 * (no image protocols here), so any positive values are fine.
	 */
	resize(cols: number, rows: number, cellWidthPx = 1, cellHeightPx = 1): void {
		if (cols < 1 || rows < 1) return;
		if (cols === this.cols && rows === this.rows) return;
		this.#ex.ghostty_terminal_resize(this.#term, cols, rows, cellWidthPx, cellHeightPx);
		this.cols = cols;
		this.rows = rows;
	}

	#scroll(tag: number, delta: number): void {
		const u8 = this.#u8();
		u8.fill(0, this.#scrollPtr, this.#scrollPtr + SIZEOF_SCROLL_VIEWPORT);
		const dv = this.#dv();
		dv.setUint32(this.#scrollPtr, tag, true);
		if (tag === SCROLL_DELTA) {
			dv.setInt32(this.#scrollPtr + SCROLL_DELTA_OFF, delta | 0, true);
		}
		this.#ex.ghostty_terminal_scroll_viewport(this.#term, this.#scrollPtr);
	}

	/** Pin the viewport to the active (bottom) area. */
	scrollToBottom(): void {
		this.#scroll(SCROLL_BOTTOM, 0);
	}

	/** Scroll to the top of the scrollback. */
	scrollToTop(): void {
		this.#scroll(SCROLL_TOP, 0);
	}

	/** Scroll by `delta` rows (negative = up into history). */
	scrollByRows(delta: number): void {
		if (delta === 0) return;
		this.#scroll(SCROLL_DELTA, delta);
	}

	/** Current scroll geometry, for driving a scrollbar. */
	getScrollbar(): Scrollbar {
		this.#ex.ghostty_terminal_get(this.#term, TERM_DATA_SCROLLBAR, this.#scrollbarPtr);
		const dv = this.#dv();
		return {
			total: Number(dv.getBigUint64(this.#scrollbarPtr, true)),
			offset: Number(dv.getBigUint64(this.#scrollbarPtr + 8, true)),
			len: Number(dv.getBigUint64(this.#scrollbarPtr + 16, true)),
		};
	}

	/**
	 * Snapshot the visible viewport grid. Refreshes the render state from the
	 * terminal, then reads every visible cell (text + resolved colors + style).
	 */
	readViewport(): Viewport {
		const ex = this.#ex;
		ex.ghostty_render_state_update(this.#state, this.#term);

		let dv = this.#dv();
		ex.ghostty_render_state_get(this.#state, RS_DATA_COLS, this.#u16Ptr);
		const cols = this.#dv().getUint16(this.#u16Ptr, true);
		ex.ghostty_render_state_get(this.#state, RS_DATA_ROWS, this.#u16Ptr);
		const rows = this.#dv().getUint16(this.#u16Ptr, true);

		dv = this.#dv();
		dv.setUint32(this.#colorsPtr, SIZEOF_COLORS, true);
		ex.ghostty_render_state_colors_get(this.#state, this.#colorsPtr);
		dv = this.#dv();
		const defaultBg = this.#rgb(dv, this.#colorsPtr + COLORS_BG_OFF);
		const defaultFg = this.#rgb(dv, this.#colorsPtr + COLORS_FG_OFF);

		// Populate the row iterator. For the ITERATOR/CELLS "populate" data
		// kinds, `out` is a pointer to the handle (verified empirically).
		ex.ghostty_render_state_get(this.#state, RS_DATA_ROW_ITERATOR, this.#iterHandlePtr);

		const cells: TermCell[][] = [];
		while (ex.ghostty_render_state_row_iterator_next(this.#iter)) {
			const row: TermCell[] = [];
			if (
				ex.ghostty_render_state_row_get(
					this.#iter,
					RS_ROW_DATA_CELLS,
					this.#cellsHandlePtr,
				) === SUCCESS
			) {
				while (ex.ghostty_render_state_row_cells_next(this.#cells)) {
					row.push(this.#readCell());
				}
			}
			cells.push(row);
		}

		return { cols, rows, defaultFg, defaultBg, cells };
	}

	#readCell(): TermCell {
		const ex = this.#ex;
		const cell = blankCell();

		// Grapheme cluster as UTF-8 into our reusable GhosttyBuffer.
		let dv = this.#dv();
		dv.setUint32(this.#bufStructPtr + 0, this.#textBufPtr, true);
		dv.setUint32(this.#bufStructPtr + 4, TEXT_BUF_CAP, true);
		dv.setUint32(this.#bufStructPtr + 8, 0, true);
		if (
			ex.ghostty_render_state_row_cells_get(
				this.#cells,
				RS_CELL_GRAPHEMES_UTF8,
				this.#bufStructPtr,
			) === SUCCESS
		) {
			const len = this.#dv().getUint32(this.#bufStructPtr + 8, true);
			if (len > 0) {
				cell.text = decoder.decode(
					this.#u8().subarray(this.#textBufPtr, this.#textBufPtr + len),
				);
			}
		}

		// Skip the (more expensive) style/color reads for plain cells.
		ex.ghostty_render_state_row_cells_get(
			this.#cells,
			RS_CELL_HAS_STYLING,
			this.#hasStylingPtr,
		);
		if (this.#dv().getUint8(this.#hasStylingPtr) === 0) return cell;

		// Resolved colors: these legitimately return non-SUCCESS when the cell
		// has no explicit color, in which case we keep the null default.
		if (
			ex.ghostty_render_state_row_cells_get(this.#cells, RS_CELL_FG_COLOR, this.#fgPtr) ===
			SUCCESS
		) {
			cell.fg = this.#rgb(this.#dv(), this.#fgPtr);
		}
		if (
			ex.ghostty_render_state_row_cells_get(this.#cells, RS_CELL_BG_COLOR, this.#bgPtr) ===
			SUCCESS
		) {
			cell.bg = this.#rgb(this.#dv(), this.#bgPtr);
		}
		if (
			ex.ghostty_render_state_row_cells_get(this.#cells, RS_CELL_STYLE, this.#stylePtr) ===
			SUCCESS
		) {
			dv = this.#dv();
			const s = this.#stylePtr;
			cell.bold = dv.getUint8(s + STYLE_BOLD) !== 0;
			cell.italic = dv.getUint8(s + STYLE_ITALIC) !== 0;
			cell.faint = dv.getUint8(s + STYLE_FAINT) !== 0;
			cell.inverse = dv.getUint8(s + STYLE_INVERSE) !== 0;
			cell.invisible = dv.getUint8(s + STYLE_INVISIBLE) !== 0;
			cell.strikethrough = dv.getUint8(s + STYLE_STRIKETHROUGH) !== 0;
			cell.underline = dv.getInt32(s + STYLE_UNDERLINE, true) !== 0;
		}
		return cell;
	}

	/**
	 * The entire screen + scrollback as plain text (escape sequences stripped,
	 * trailing whitespace trimmed). This is the canonical source for "copy".
	 */
	toPlainText(): string {
		if (!this.#formatter) return "";
		const ex = this.#ex;

		// Size query (NULL buffer).
		ex.ghostty_formatter_format_buf(this.#formatter, 0, 0, this.#usizePtr);
		const need = this.#dv().getUint32(this.#usizePtr, true);
		if (need === 0) return "";

		const buf = this.#ex.ghostty_alloc(0, need);
		if (!buf) return "";
		let out = "";
		if (
			ex.ghostty_formatter_format_buf(this.#formatter, buf, need, this.#usizePtr) === SUCCESS
		) {
			const n = this.#dv().getUint32(this.#usizePtr, true);
			out = decoder.decode(this.#u8().subarray(buf, buf + n));
		}
		this.#ex.ghostty_free(0, buf, need);
		return out;
	}

	/** Release all wasm-side resources owned by this terminal. */
	dispose(): void {
		const ex = this.#ex;
		if (this.#formatter) ex.ghostty_formatter_free(this.#formatter);
		ex.ghostty_render_state_row_cells_free(this.#cells);
		ex.ghostty_render_state_row_iterator_free(this.#iter);
		ex.ghostty_render_state_free(this.#state);
		ex.ghostty_terminal_free(this.#term);
		this.#formatter = 0;
		this.#cells = 0;
		this.#iter = 0;
		this.#state = 0;
		this.#term = 0;
		for (const [ptr, len] of this.#allocs) ex.ghostty_free(0, ptr, len);
		this.#allocs.length = 0;
	}
}
