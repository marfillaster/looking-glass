/**
 * Canvas renderer for a {@link GhosttyTerminal}.
 *
 * Framework-agnostic: it owns a `<canvas>` and a terminal, draws the visible
 * viewport grid each update, grows the pane with content (up to a cap, then
 * scrolls), and serves "copy" from the terminal's own plain-text serializer.
 * The React wrapper in `~/components/terminal` drives it.
 */
import type { GhosttyTerminal, Rgb, Viewport } from "./terminal";

export interface TerminalViewOptions {
	/** Monospace CSS font-family stack (Ghostty-default, JetBrains Mono-led). */
	fontFamily: string;
	/** Font size in CSS px. */
	fontSize?: number;
	/** Line height as a multiple of font size. */
	lineHeight?: number;
	/** Default foreground (CSS color) for cells with no explicit fg. */
	foreground: string;
	/** Canvas background (CSS color); also the implicit cell background. */
	background: string;
	/** Smallest number of visible rows (pane never collapses below this). */
	minRows?: number;
	/** Largest number of visible rows before content scrolls into history. */
	maxRows?: number;
	/** Size visible rows from the container height instead of content length. */
	fitToContainer?: boolean;
	/** Called after any change to scroll geometry (drives the scrollbar UI). */
	onScroll?: (info: ScrollInfo) => void;
}

export interface ScrollInfo {
	/** Total rows of content (scrollback + active). */
	total: number;
	/** Top row of the viewport within `total`. */
	offset: number;
	/** Visible rows. */
	len: number;
	/** True when pinned to the bottom (following live output). */
	atBottom: boolean;
}

const DEFAULT_FONT_SIZE = 13;
const DEFAULT_LINE_HEIGHT = 1.35;
const DEFAULT_MIN_ROWS = 4;
const DEFAULT_MAX_ROWS = 24;
// Scrolling down to within this many rows of the bottom counts as reaching it,
// so auto-follow re-engages even when streaming output keeps moving the bottom.
const FOLLOW_BOTTOM_SLOP_ROWS = 1;

function css(rgb: Rgb): string {
	return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

/** Collapse any newline convention to CRLF so the VT parser advances columns. */
function normalizeNewlines(text: string): string {
	return text.replace(/\r?\n/g, "\r\n");
}

export class TerminalView {
	readonly #canvas: HTMLCanvasElement;
	readonly #ctx: CanvasRenderingContext2D;
	readonly #term: GhosttyTerminal;
	readonly #opts: Required<Omit<TerminalViewOptions, "onScroll">> &
		Pick<TerminalViewOptions, "onScroll">;

	#cellWidth = 8;
	#cellHeight = 18;
	#cols = 80;
	#rows: number;
	#follow = true;
	/** The CRLF-normalized text already written to the terminal. */
	#written = "";

	constructor(
		canvas: HTMLCanvasElement,
		term: GhosttyTerminal,
		options: TerminalViewOptions,
	) {
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("2d canvas context unavailable");
		this.#canvas = canvas;
		this.#ctx = ctx;
		this.#term = term;
		this.#opts = {
			fontFamily: options.fontFamily,
			fontSize: options.fontSize ?? DEFAULT_FONT_SIZE,
			lineHeight: options.lineHeight ?? DEFAULT_LINE_HEIGHT,
			foreground: options.foreground,
			background: options.background,
			minRows: options.minRows ?? DEFAULT_MIN_ROWS,
			maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
			fitToContainer: options.fitToContainer ?? false,
			onScroll: options.onScroll,
		};
		this.#rows = this.#opts.minRows;
		this.#cols = term.cols;
		this.#measureCell();
	}

	get cols(): number {
		return this.#cols;
	}
	get rows(): number {
		return this.#rows;
	}
	get cellWidth(): number {
		return this.#cellWidth;
	}
	get cellHeight(): number {
		return this.#cellHeight;
	}

	#fontString(weight: number, italic: boolean): string {
		return `${italic ? "italic " : ""}${weight} ${this.#opts.fontSize}px ${this.#opts.fontFamily}`;
	}

	#measureCell(): void {
		this.#ctx.font = this.#fontString(400, false);
		// Monospace: every glyph shares the advance width of "0".
		this.#cellWidth = this.#ctx.measureText("0").width || this.#opts.fontSize * 0.6;
		this.#cellHeight = Math.round(this.#opts.fontSize * this.#opts.lineHeight);
	}

	/**
	 * Recompute the column/row count for the available CSS pixel size and resize
	 * the grid + canvas. Call on mount and whenever the container resizes.
	 */
	layout(cssWidth: number, cssHeight?: number): void {
		this.#measureCell();
		const cols = Math.max(1, Math.floor(cssWidth / this.#cellWidth));
		const rows = this.#opts.fitToContainer
			? Math.max(
					this.#opts.minRows,
					Math.floor(Math.max(0, cssHeight ?? 0) / this.#cellHeight),
				)
			: this.#rows;
		if (cols !== this.#cols || rows !== this.#rows) {
			this.#cols = cols;
			this.#rows = rows;
			this.#term.resize(cols, rows);
			if (this.#follow) this.#term.scrollToBottom();
		}
		this.#resizeCanvas();
		this.draw();
		this.#emitScroll();
	}

	#resizeCanvas(): void {
		const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
		const cssWidth = this.#cols * this.#cellWidth;
		const cssHeight = this.#rows * this.#cellHeight;
		this.#canvas.style.width = `${cssWidth}px`;
		this.#canvas.style.height = `${cssHeight}px`;
		this.#canvas.width = Math.max(1, Math.round(cssWidth * dpr));
		this.#canvas.height = Math.max(1, Math.round(cssHeight * dpr));
		this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		// Canvas resize resets context state; restore text settings.
		this.#ctx.textBaseline = "middle";
	}

	/** Grow/shrink the visible rows to fit the content, within the bounds. */
	#syncRows(): void {
		if (this.#opts.fitToContainer) return;
		const { total } = this.#term.getScrollbar();
		const desired = Math.min(
			this.#opts.maxRows,
			Math.max(this.#opts.minRows, total),
		);
		if (desired !== this.#rows) {
			this.#rows = desired;
			this.#term.resize(this.#cols, desired);
			this.#resizeCanvas();
		}
	}

	/**
	 * Set the full output text. Appends only the new suffix when possible,
	 * otherwise resets and rewrites. Auto-follows the bottom when pinned.
	 */
	setContent(text: string): void {
		const next = normalizeNewlines(text);
		if (next === this.#written) return;
		if (this.#written.length > 0 && next.startsWith(this.#written)) {
			this.#term.write(next.slice(this.#written.length));
		} else {
			this.#term.reset();
			this.#follow = true;
			if (next.length > 0) this.#term.write(next);
		}
		this.#written = next;
		this.#syncRows();
		if (this.#follow) this.#term.scrollToBottom();
		this.draw();
		this.#emitScroll();
	}

	/** Clear all content and history. */
	clear(): void {
		this.#term.reset();
		this.#written = "";
		this.#follow = true;
		this.#rows = this.#opts.minRows;
		this.#term.resize(this.#cols, this.#rows);
		this.#resizeCanvas();
		this.draw();
		this.#emitScroll();
	}

	/** Scroll by a number of rows (negative = up into history). */
	scrollByRows(delta: number): void {
		this.#term.scrollByRows(delta);
		// A downward scroll that lands within a row of the bottom snaps fully to it
		// and re-engages follow — so a near-miss while output streams still latches.
		// Upward scrolls stay exact, so leaving the bottom always stops follow.
		if (delta > 0) {
			const sb = this.#term.getScrollbar();
			if (sb.offset + sb.len >= sb.total - FOLLOW_BOTTOM_SLOP_ROWS) {
				this.#term.scrollToBottom();
			}
		}
		this.#afterScroll();
	}

	scrollToTop(): void {
		this.#term.scrollToTop();
		this.#afterScroll();
	}

	scrollToBottom(): void {
		this.#term.scrollToBottom();
		this.#afterScroll();
	}

	/** Scroll so a fractional position [0,1] is at the top of the viewport. */
	scrollToFraction(fraction: number): void {
		const { total } = this.#term.getScrollbar();
		const target = Math.round(fraction * Math.max(0, total - this.#rows));
		this.#term.scrollToTop();
		if (target > 0) this.#term.scrollByRows(target);
		this.#afterScroll();
	}

	#afterScroll(): void {
		const sb = this.#term.getScrollbar();
		this.#follow = sb.offset + sb.len >= sb.total;
		this.draw();
		this.#emitScroll();
	}

	#emitScroll(): void {
		if (!this.#opts.onScroll) return;
		const sb = this.#term.getScrollbar();
		this.#opts.onScroll({
			total: sb.total,
			offset: sb.offset,
			len: sb.len,
			atBottom: sb.offset + sb.len >= sb.total,
		});
	}

	/** Full plain-text contents (scrollback + screen) for clipboard copy. */
	getPlainText(): string {
		return this.#term.toPlainText();
	}

	/** Redraw the visible viewport. */
	draw(): void {
		const vp = this.#term.readViewport();
		const ctx = this.#ctx;
		const cw = this.#cellWidth;
		const ch = this.#cellHeight;

		ctx.fillStyle = this.#opts.background;
		ctx.fillRect(0, 0, this.#cols * cw, this.#rows * ch);

		for (let y = 0; y < this.#rows; y++) {
			const row = vp.cells[y];
			if (!row) continue;
			const max = Math.min(row.length, this.#cols);
			for (let x = 0; x < max; x++) {
				this.#drawCell(vp, row[x], x, y, cw, ch);
			}
		}
	}

	#drawCell(
		vp: Viewport,
		cell: Viewport["cells"][number][number],
		x: number,
		y: number,
		cw: number,
		ch: number,
	): void {
		const ctx = this.#ctx;
		if (cell.invisible) return;

		// Resolve colors (null => terminal default), honoring inverse.
		let fg = cell.fg ? css(cell.fg) : this.#opts.foreground;
		let bg = cell.bg ? css(cell.bg) : null;
		if (cell.inverse) {
			const newBg = cell.fg ? css(cell.fg) : this.#opts.foreground;
			const newFg = cell.bg ? css(cell.bg) : this.#opts.background;
			fg = newFg;
			bg = newBg;
		}

		const px = x * cw;
		const py = y * ch;
		if (bg) {
			ctx.fillStyle = bg;
			// +1 width avoids hairline seams between adjacent bg cells.
			ctx.fillRect(Math.floor(px), py, Math.ceil(cw) + 1, ch);
		}

		if (cell.text && cell.text !== " ") {
			ctx.globalAlpha = cell.faint ? 0.6 : 1;
			ctx.fillStyle = fg;
			ctx.font = this.#fontString(cell.bold ? 700 : 400, cell.italic);
			ctx.fillText(cell.text, px, py + ch / 2);
			ctx.globalAlpha = 1;
		}

		if (cell.underline || cell.strikethrough) {
			ctx.strokeStyle = fg;
			ctx.lineWidth = Math.max(1, Math.round(this.#opts.fontSize / 12));
			if (cell.underline) {
				const uy = Math.round(py + ch - 2) + 0.5;
				ctx.beginPath();
				ctx.moveTo(px, uy);
				ctx.lineTo(px + cw, uy);
				ctx.stroke();
			}
			if (cell.strikethrough) {
				const sy = Math.round(py + ch / 2) + 0.5;
				ctx.beginPath();
				ctx.moveTo(px, sy);
				ctx.lineTo(px + cw, sy);
				ctx.stroke();
			}
		}
	}

	dispose(): void {
		this.#term.dispose();
	}
}
