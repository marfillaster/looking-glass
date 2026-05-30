import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";

import { GhosttyTerminal } from "~/lib/ghostty/terminal";
import { TerminalView, type ScrollInfo } from "~/lib/ghostty/renderer";
import { cn } from "~/lib/utils";

// Import the wasm as a URL asset (`?url`) so Vite emits it under /assets/ with a
// content hash — letting it ride the immutable cache like every other build
// artifact. The `?url` suffix is deliberate: a bare `.wasm` import would be
// rewritten by the Cloudflare Vite plugin into a Workers CompiledWasm module
// (a WebAssembly.Module, not a URL) that breaks the client-side streaming fetch.
import WASM_URL from "../lib/ghostty/ghostty-vt.wasm?url";

// Ghostty-default monospace stack (JetBrains Mono is preloaded in root.tsx).
const FONT_FAMILY =
	'"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const EMPTY_SCROLL: ScrollInfo = { total: 0, offset: 0, len: 0, atBottom: true };

export interface TerminalOutputProps {
	/** The command line shown in the title bar. */
	command: string;
	/** Full output text to display (re-derived; appends stream efficiently). */
	text: string;
	/** Health indicator for the upstream wrapper. */
	health?: "checking" | "ok" | "fail";
	/** Shows in-place command progress in the title bar. */
	busy?: boolean;
	/** Called for terminal-style interrupt shortcuts, such as Ctrl+C. */
	onInterrupt?: () => void;
	/**
	 * Monotonic counter bumped on each new command. A change re-pins the view to
	 * the bottom and resumes auto-follow, even if the user had scrolled back.
	 */
	followSignal?: number;
	/** Fill the available vertical space instead of growing to output length. */
	fill?: boolean;
	/** Optional controls rendered inside the terminal chrome above output. */
	controls?: ReactNode | ((api: { copy: () => void; copied: boolean }) => ReactNode);
	className?: string;
}

/**
 * Terminal-style output pane backed by the libghostty-vt WebAssembly renderer.
 * Renders both BGP results and streamed ping/traceroute output. Client-only:
 * the wasm terminal is created in an effect and never touched during SSR.
 */
export function TerminalOutput({
	command,
	text,
	health = "checking",
	busy,
	onInterrupt,
	followSignal,
	fill,
	controls,
	className,
}: TerminalOutputProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const viewRef = useRef<TerminalView | null>(null);
	const pendingText = useRef(text);
	const touchY = useRef<number | null>(null);
	const touchAccum = useRef(0);
	const [scroll, setScroll] = useState<ScrollInfo>(EMPTY_SCROLL);
	const [copied, setCopied] = useState(false);

	pendingText.current = text;

	// Create the terminal + renderer once, client-side.
	useEffect(() => {
		const canvas = canvasRef.current;
		const container = scrollRef.current;
		if (!canvas || !container) return;

		let view: TerminalView | null = null;
		let disposed = false;
		let observer: ResizeObserver | null = null;

		(async () => {
			const term = await GhosttyTerminal.create(WASM_URL, { maxScrollback: 1000 });
			if (disposed) {
				term.dispose();
				return;
			}
			const styles = getComputedStyle(container);
			view = new TerminalView(canvas, term, {
				fontFamily: FONT_FAMILY,
				foreground: styles.color || "#e5e5e5",
				background: opaque(styles.backgroundColor) ?? "#0a0a0a",
				fitToContainer: fill,
				onScroll: setScroll,
			});
			viewRef.current = view;

			const relayout = () => {
				if (!view) return;
				const s = getComputedStyle(container);
				const horizontal =
					parseFloat(s.paddingLeft || "0") + parseFloat(s.paddingRight || "0");
				const vertical =
					parseFloat(s.paddingTop || "0") + parseFloat(s.paddingBottom || "0");
				view.layout(
					Math.max(0, container.clientWidth - horizontal),
					Math.max(0, container.clientHeight - vertical),
				);
			};
			relayout();
			view.setContent(pendingText.current);

			// Re-measure once the web font is ready (fallback metrics differ).
			document.fonts?.ready.then(() => {
				if (!disposed) relayout();
			});

			observer = new ResizeObserver(relayout);
			observer.observe(container);
		})();

		return () => {
			disposed = true;
			observer?.disconnect();
			viewRef.current = null;
			view?.dispose();
		};
	}, [fill]);

	// Feed content changes to the renderer.
	useEffect(() => {
		viewRef.current?.setContent(text);
	}, [text]);

	// A new command re-pins to the bottom and resumes auto-follow. Runs after the
	// text effect above, so the freshly appended command line is already written.
	useEffect(() => {
		viewRef.current?.scrollToBottom();
	}, [followSignal]);

	const copy = useCallback(async () => {
		const view = viewRef.current;
		if (!view) return;
		try {
			await navigator.clipboard.writeText(view.getPlainText());
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard unavailable */
		}
	}, []);

	const onWheel = useCallback((e: React.WheelEvent) => {
		const view = viewRef.current;
		if (!view) return;
		const rows = Math.max(1, Math.round(Math.abs(e.deltaY) / view.cellHeight));
		const before = view.rows;
		view.scrollByRows(Math.sign(e.deltaY) * rows);
		void before;
		// Prevent page scroll only when the pane actually has history to move.
		if (view.rows >= 1) e.stopPropagation();
	}, []);

	// Touch drag scrolls the terminal history, not the page. The container sets
	// `touch-action: none` so the browser never starts its own scroll/pan from
	// this element; we translate the drag into row scrolls ourselves.
	const onTouchStart = useCallback((e: React.TouchEvent) => {
		touchY.current = e.touches[0]?.clientY ?? null;
		touchAccum.current = 0;
	}, []);

	const onTouchMove = useCallback((e: React.TouchEvent) => {
		const view = viewRef.current;
		const y = e.touches[0]?.clientY;
		if (!view || y == null || touchY.current == null) return;
		// Natural scrolling: dragging down (positive delta) reveals older rows.
		touchAccum.current += touchY.current - y;
		touchY.current = y;
		const rows = touchAccum.current / view.cellHeight;
		const whole = Math.trunc(rows);
		if (whole !== 0) {
			view.scrollByRows(whole);
			touchAccum.current -= whole * view.cellHeight;
		}
	}, []);

	const onTouchEnd = useCallback(() => {
		touchY.current = null;
		touchAccum.current = 0;
	}, []);

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			const view = viewRef.current;
			if (!view) return;
			if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
				if (e.ctrlKey && !e.metaKey && busy && onInterrupt) {
					e.preventDefault();
					e.stopPropagation();
					onInterrupt();
					return;
				}
				// Only hijack copy when there's no native text selection.
				if (!window.getSelection()?.toString()) {
					e.preventDefault();
					void copy();
				}
				return;
			}
			switch (e.key) {
				case "ArrowUp":
					view.scrollByRows(-1);
					break;
				case "ArrowDown":
					view.scrollByRows(1);
					break;
				case "PageUp":
					view.scrollByRows(-Math.max(1, view.rows - 1));
					break;
				case "PageDown":
					view.scrollByRows(Math.max(1, view.rows - 1));
					break;
				case "Home":
					view.scrollToTop();
					break;
				case "End":
					view.scrollToBottom();
					break;
				default:
					return;
			}
			e.preventDefault();
		},
		[busy, copy, onInterrupt],
	);

	const scrollable = scroll.total > scroll.len;
	const renderedControls =
		typeof controls === "function" ? controls({ copy, copied }) : controls;
	const latestLine = text.trimEnd().split("\n").at(-1) ?? "";
	const healthLabel =
		health === "ok"
			? "Wrapper healthy"
			: health === "fail"
				? "Wrapper unavailable"
				: "Checking wrapper health";

	return (
		<div
			role="region"
			aria-label="Looking glass terminal"
			className={cn(
				"flex min-h-0 overflow-hidden rounded-lg border bg-card",
				fill ? "h-full flex-1 flex-col" : "flex-col",
				className,
			)}
		>
			<div className="flex shrink-0 items-center gap-2 border-b bg-muted/60 px-3 py-2">
				<code className="truncate font-mono text-xs text-muted-foreground">
					{command}
				</code>
				<div className="ml-auto flex items-center gap-3">
					{busy ? (
						<span
							role="status"
							aria-live="polite"
							className="size-3 shrink-0 animate-spin rounded-full border-2 border-yellow-500/30 border-t-yellow-400"
							title="command running"
						>
							<span className="sr-only">Command running</span>
						</span>
					) : (
						<span
							role="status"
							aria-live="polite"
							className={cn(
								"size-2.5 shrink-0 rounded-full",
								health === "ok" &&
									"animate-pulse bg-emerald-500 [animation-duration:2.4s]",
								health === "fail" && "bg-destructive",
								health === "checking" &&
									"animate-pulse bg-muted-foreground/40 [animation-duration:1.5s]",
							)}
							title={`wrapper ${health}`}
						>
							<span className="sr-only">{healthLabel}</span>
						</span>
					)}
				</div>
			</div>
			{renderedControls && (
				<div className="shrink-0 border-b bg-card px-3 py-3">
					{renderedControls}
				</div>
			)}
			<div className="relative min-h-0 flex-1">
				<div
					ref={scrollRef}
					tabIndex={0}
					onWheel={onWheel}
					onKeyDown={onKeyDown}
					onTouchStart={onTouchStart}
					onTouchMove={onTouchMove}
					onTouchEnd={onTouchEnd}
					onTouchCancel={onTouchEnd}
					role="region"
					aria-label="Terminal visual output"
					className="h-full touch-none overflow-hidden px-3 py-3 outline-none"
				>
					<canvas ref={canvasRef} className="block" aria-hidden="true" />
				</div>
				<pre className="sr-only" aria-label="Terminal output transcript">
					{text}
				</pre>
				<div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
					{busy ? latestLine : ""}
				</div>
				{scrollable && <Scrollbar info={scroll} view={viewRef} />}
			</div>
		</div>
	);
}

function opaque(color: string): string | null {
	// Reject fully-transparent computed backgrounds (e.g. "rgba(0, 0, 0, 0)").
	if (!color) return null;
	const m = color.match(/rgba?\([^)]*?,\s*0(?:\.0+)?\)\s*$/);
	return m ? null : color;
}

function Scrollbar({
	info,
	view,
}: {
	info: ScrollInfo;
	view: React.RefObject<TerminalView | null>;
}) {
	const trackRef = useRef<HTMLDivElement>(null);
	const thumbPct = Math.max(8, (info.len / info.total) * 100);
	const topPct = (info.offset / info.total) * 100;

	const jump = useCallback(
		(clientY: number) => {
			const track = trackRef.current;
			const v = view.current;
			if (!track || !v) return;
			const rect = track.getBoundingClientRect();
			const fraction = (clientY - rect.top) / rect.height;
			v.scrollToFraction(Math.min(1, Math.max(0, fraction)));
		},
		[view],
	);

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			jump(e.clientY);
			const move = (ev: PointerEvent) => jump(ev.clientY);
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[jump],
	);

	return (
		<div
			ref={trackRef}
			onPointerDown={onPointerDown}
			aria-hidden="true"
			className="absolute top-1 right-1 bottom-1 w-1.5 cursor-pointer rounded-full"
		>
			<div
				className="absolute right-0 w-full rounded-full bg-muted-foreground/30 transition-[top] hover:bg-muted-foreground/50"
				style={{ top: `${topPct}%`, height: `${thumbPct}%` }}
			/>
		</div>
	);
}
