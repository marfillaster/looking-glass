/**
 * Low-level loader for the vendored libghostty-vt WebAssembly module.
 *
 * The module is `wasm32-freestanding` (no WASI, no libc). Its only import is
 * `env.log`, a logging hook we stub out. All memory management goes through the
 * module's own allocator exports (`ghostty_alloc` / the default allocator), so
 * no JS-side heap is needed here.
 *
 * The C API surface and its exact ABI (struct offsets, by-value vs. by-pointer
 * argument passing) were verified empirically against the pinned build with the
 * harness in `frontend/scripts/` — see `ghostty/README.md`. The API is marked
 * "not yet stable" upstream, so the bindings are pinned to that commit.
 */

/** The subset of the 170 module exports that the bindings actually call. */
export interface GhosttyExports {
	memory: WebAssembly.Memory;

	// Generic allocator (default allocator when the first arg is 0/NULL).
	ghostty_alloc(allocator: number, len: number): number;
	ghostty_free(allocator: number, ptr: number, len: number): void;

	// Terminal lifecycle.
	ghostty_terminal_new(
		allocator: number,
		outHandle: number,
		options: number,
	): number;
	ghostty_terminal_free(terminal: number): void;
	ghostty_terminal_reset(terminal: number): void;
	ghostty_terminal_resize(
		terminal: number,
		cols: number,
		rows: number,
		cellWidthPx: number,
		cellHeightPx: number,
	): number;
	ghostty_terminal_vt_write(terminal: number, data: number, len: number): void;
	ghostty_terminal_scroll_viewport(terminal: number, behavior: number): void;
	ghostty_terminal_get(terminal: number, data: number, out: number): number;

	// Render state (reads the viewport grid).
	ghostty_render_state_new(allocator: number, outHandle: number): number;
	ghostty_render_state_free(state: number): void;
	ghostty_render_state_update(state: number, terminal: number): number;
	ghostty_render_state_get(state: number, data: number, out: number): number;
	ghostty_render_state_colors_get(state: number, outColors: number): number;

	ghostty_render_state_row_iterator_new(
		allocator: number,
		outHandle: number,
	): number;
	ghostty_render_state_row_iterator_free(iterator: number): void;
	ghostty_render_state_row_iterator_next(iterator: number): number;
	ghostty_render_state_row_get(
		iterator: number,
		data: number,
		out: number,
	): number;

	ghostty_render_state_row_cells_new(
		allocator: number,
		outHandle: number,
	): number;
	ghostty_render_state_row_cells_free(cells: number): void;
	ghostty_render_state_row_cells_next(cells: number): number;
	ghostty_render_state_row_cells_select(cells: number, x: number): number;
	ghostty_render_state_row_cells_get(
		cells: number,
		data: number,
		out: number,
	): number;

	// Formatter (serializes the full screen + scrollback to plain text).
	ghostty_formatter_terminal_new(
		allocator: number,
		outHandle: number,
		terminal: number,
		options: number,
	): number;
	ghostty_formatter_format_buf(
		formatter: number,
		buf: number,
		bufLen: number,
		outWritten: number,
	): number;
	ghostty_formatter_free(formatter: number): void;
}

export interface GhosttyModule {
	instance: WebAssembly.Instance;
	exports: GhosttyExports;
	memory: WebAssembly.Memory;
}

/** Optional hook for the module's internal log messages (off by default). */
export type GhosttyLogHook = (...args: number[]) => void;

function imports(onLog?: GhosttyLogHook): WebAssembly.Imports {
	return {
		env: {
			// Freestanding log sink. Signature is build-internal; we ignore the
			// arguments unless a debug hook is supplied.
			log: (...args: number[]) => onLog?.(...args),
		},
	};
}

/**
 * Instantiate the ghostty-vt module.
 *
 * @param source A URL string (e.g. from a Vite `?url` import — fetched and
 *   streamed) or the raw bytes/compiled module.
 */
export async function instantiateGhostty(
	source: string | BufferSource | WebAssembly.Module,
	onLog?: GhosttyLogHook,
): Promise<GhosttyModule> {
	const importObject = imports(onLog);

	const instance = await instantiate(source, importObject);
	const exports = instance.exports as unknown as GhosttyExports;
	return { instance, exports, memory: exports.memory };
}

async function instantiate(
	source: string | BufferSource | WebAssembly.Module,
	importObject: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
	// Compile to a Module first, then instantiate. This avoids the
	// `{ module, instance }` result-object overload, which these lib types
	// declare as returning a bare Instance.
	const module = await compile(source);
	return WebAssembly.instantiate(module, importObject);
}

async function compile(
	source: string | BufferSource | WebAssembly.Module,
): Promise<WebAssembly.Module> {
	if (source instanceof WebAssembly.Module) return source;
	if (typeof source === "string") {
		const res = await fetch(source);
		// Streaming compile needs an `application/wasm` content-type; fall back
		// to a buffered compile if it's unavailable or the MIME type is wrong.
		if (typeof WebAssembly.compileStreaming === "function") {
			try {
				return await WebAssembly.compileStreaming(res.clone());
			} catch {
				/* fall through to buffered compile */
			}
		}
		return WebAssembly.compile(await res.arrayBuffer());
	}
	return WebAssembly.compile(source);
}
