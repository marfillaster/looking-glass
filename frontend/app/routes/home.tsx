import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
	Activity,
	Check,
	Copy,
	Globe,
	LoaderCircle,
	Network,
	Route as RouteIcon,
	Search,
	Trash2,
} from "lucide-react";

import type { Route } from "./+types/home";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { TerminalOutput } from "~/components/terminal";
import { cn } from "~/lib/utils";
import {
	getEnv,
	publicConfig,
	type AddressFamily,
	type PublicConfig,
	type RoutingBackend,
} from "~/lib/env.server";

const MAX_TERMINAL_LINES = 1000;
const HEALTH_CHECK_INTERVAL_MS = 60000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;
const HEALTH_CHECK_MAX_BACKOFF_MS = 15 * 60000;
// The router-side HAProxy maxconn gate (and the Cloudflare rate-limit courtesy
// throttle) answer 503/429 when every query slot is busy. Rather than fail the
// command, the UI shows a countdown and retries: two retries, 5s then 10s.
const BUSY_RETRY_DELAYS_MS = [5000, 10000];
const BUSY_STATUSES = new Set([429, 503]);

type CommandKind = "bgp" | "ping" | "traceroute";
type BGPQueryType = "prefix" | "as-path" | "community";
type QueryFamily = AddressFamily | "auto";

interface QueryDetection {
	label: string;
	bgpType: BGPQueryType | null;
	canProbe: boolean;
	commandQuery: string;
	family: AddressFamily | null;
}

// Wait `ms`, ticking `onTick(secondsLeft)` once per second, rejecting with an
// AbortError if `signal` fires — so Ctrl+C interrupts the retry wait too.
function waitWithCountdown(
	ms: number,
	signal: AbortSignal,
	onTick: (secondsLeft: number) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => new DOMException("Aborted", "AbortError");
		if (signal.aborted) return reject(abort());
		let remaining = Math.ceil(ms / 1000);
		onTick(remaining);
		const tick = window.setInterval(() => {
			remaining -= 1;
			if (remaining <= 0) {
				cleanup();
				resolve();
			} else {
				onTick(remaining);
			}
		}, 1000);
		const onAbort = () => {
			cleanup();
			reject(abort());
		};
		const cleanup = () => {
			window.clearInterval(tick);
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort);
	});
}

// Parse a wrapper SSE stream (`event: line|fail|done`) from a fetch body and
// dispatch each event. Resolves when the stream ends (the server closes after
// `done`); rejects with AbortError if the underlying fetch is aborted. Reading
// the stream via fetch rather than EventSource is what lets the caller see the
// HTTP status (e.g. a 503 from the maxconn gate) and drive the busy-retry.
async function consumeEventStream(
	body: ReadableStream<Uint8Array>,
	handlers: { onLine: (data: string) => void; onFail: (data: string) => void },
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const dispatch = (block: string) => {
		let event = "message";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		const payload = data.join("\n");
		if (event === "line") handlers.onLine(payload);
		else if (event === "fail") handlers.onFail(payload);
		// `done` (and anything else) produces no output; the server closes after it.
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
			let sep: number;
			while ((sep = buffer.indexOf("\n\n")) !== -1) {
				const block = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				if (block.trim()) dispatch(block);
			}
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}

export function meta({ data }: Route.MetaArgs) {
	const cfg = data?.config;
	const title = cfg ? `${cfg.title} · ${cfg.asNumber}` : "Looking Glass";
	const description = cfg?.description ?? "";
	const url = cfg?.siteUrl || undefined;
	const tags: ReturnType<Route.MetaFunction> = [
		{ title },
		{ name: "description", content: description },
		// Explicitly invite indexing — search engines and AI crawlers welcome.
		{ name: "robots", content: "index, follow, max-image-preview:large" },
		{ property: "og:type", content: "website" },
		{ property: "og:title", content: title },
		{ property: "og:description", content: description },
		{ property: "og:site_name", content: cfg?.title ?? "Looking Glass" },
		{ name: "twitter:card", content: "summary" },
		{ name: "twitter:title", content: title },
		{ name: "twitter:description", content: description },
	];
	if (url) {
		tags.push(
			{ tagName: "link", rel: "canonical", href: url },
			{ property: "og:url", content: url },
		);
	}
	return tags;
}

export async function loader({ context }: Route.LoaderArgs) {
	const env = getEnv(context);
	return { config: publicConfig(env) };
}

// The page is an identical, public app shell (config baked at build/deploy time;
// all live data is fetched client-side from /api/*), so it's safe to cache.
//
// `/` is a *mutable* URL (its content changes every deploy), so the page can't
// be browser-immutable — that would pin returning visitors to a stale shell that
// references asset hashes a later deploy removed. Hence `max-age=0,
// must-revalidate` for browsers. The shared/edge cache, however, is effectively
// immutable: the Worker keys it by build id (workers/app.ts), so a one-year
// `s-maxage` is safe — each deploy writes a fresh key and old entries age out.
export function headers(): Record<string, string> {
	return {
		"Cache-Control": "public, max-age=0, s-maxage=31536000, must-revalidate",
	};
}

export default function Home({ loaderData }: Route.ComponentProps) {
	const { config } = loaderData;
	const loginBanner = buildLoginBanner(config);
	const [query, setQuery] = useState("");
	const [terminalText, setTerminalText] = useState(() => loginBanner);
	// Ephemeral status line shown beneath the committed log (the busy-retry
	// countdown). Kept out of terminalText so it rewrites/clears in place without
	// editing history.
	const [transient, setTransient] = useState("");
	// Coarse status announced to assistive tech on transitions only (busy-retry),
	// kept separate from `transient` so the per-second countdown isn't read aloud.
	const [announce, setAnnounce] = useState("");
	const [running, setRunning] = useState<CommandKind | null>(null);
	// Bumped whenever a new command is issued, so the terminal re-pins to the
	// bottom and resumes auto-follow even if the user had scrolled into history.
	const [followSignal, setFollowSignal] = useState(0);
	// Selected vantage point (origin the Worker proxies to). Defaults to the
	// first configured vantage; the picker only appears when there's >1.
	const [vantage, setVantage] = useState(() => config.vantages[0]?.id ?? "");
	const [family, setFamily] = useState<QueryFamily>(() =>
		config.addressFamilies.length === 1 ? config.addressFamilies[0] : "auto",
	);
	const multiVantage = config.vantages.length > 1;
	const vantageLabel =
		config.vantages.find((v) => v.id === vantage)?.label ?? "";
	const activeFamily =
		config.addressFamilies.length === 1 ? config.addressFamilies[0] : family;
	// Tag each command line with its vantage when more than one is available.
	const commandPrefix = multiVantage && vantageLabel ? `[${vantageLabel}] ` : "";
	const [health, setHealth] = useState<"checking" | "ok" | "fail">("checking");

	const abortRef = useRef<AbortController | null>(null);
	const probeRunning = running === "ping" || running === "traceroute";
	const detection = detectQuery(query, config.routingBackend);
	const bgpEnabled =
		detection.bgpType !== null &&
		config.enabledQueries.includes(detection.bgpType) &&
		familyCompatible(detection.family, activeFamily, config.addressFamilies);
	const probeEnabled =
		detection.canProbe &&
		familyCompatible(detection.family, activeFamily, config.addressFamilies);

	const append = useCallback((chunk: string) => {
		setTerminalText((prev) => clampLines(prev + chunk));
	}, []);

	const appendCommand = useCallback(
		(label: string) => {
			setTerminalText((prev) =>
				clampLines(`${prev}${prev ? "\n" : ""}$ ${label}\n`),
			);
			setFollowSignal((n) => n + 1);
		},
		[],
	);

	const finish = useCallback(() => {
		abortRef.current = null;
		setTransient("");
		setRunning(null);
	}, []);

	const cancel = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setTransient("");
		setAnnounce("");
		append("^C\n");
		setRunning(null);
	}, [append]);

	// Run an attempt; if the backend signals busy (HAProxy maxconn / CF rate
	// limit → 503/429), show a TUI-style countdown and retry. `attempt` returns
	// "busy" to request a retry, or "done" once it has produced output (a
	// success or a non-busy error). Delays come from BUSY_RETRY_DELAYS_MS.
	const withBusyRetry = useCallback(
		async (
			controller: AbortController,
			attempt: () => Promise<"busy" | "done">,
		) => {
			const total = BUSY_RETRY_DELAYS_MS.length;
			for (let i = 0; ; i++) {
				if ((await attempt()) === "done") return;
				if (i >= total) {
					setTransient("");
					setAnnounce(
						"Backend busy — all query slots are in use. Please try again shortly.",
					);
					append(
						"! backend busy — all query slots are in use. Please try again shortly.\n",
					);
					return;
				}
				const attemptNo = i + 1;
				// ±20% jitter so a burst of clients that all hit the gate at the same
				// instant don't retry in lockstep and re-collide (thundering herd).
				const delay = Math.round(
					BUSY_RETRY_DELAYS_MS[i] * (0.8 + Math.random() * 0.4),
				);
				const seconds = Math.ceil(delay / 1000);
				// Announce once per attempt (not per tick), so screen readers get the
				// retry state without a second-by-second countdown read aloud.
				setAnnounce(
					`Backend busy. Retrying in ${seconds} seconds (attempt ${attemptNo} of ${total}).`,
				);
				try {
					await waitWithCountdown(
						delay,
						controller.signal,
						(secondsLeft) =>
							setTransient(
								`  backend busy — retrying in ${secondsLeft}s… (attempt ${attemptNo} of ${total})`,
							),
					);
				} finally {
					setTransient("");
				}
			}
		},
		[append],
	);

	useEffect(
		() => () => {
			abortRef.current?.abort();
		},
		[],
	);

	useEffect(() => {
		if (!probeRunning) return;

		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.repeat ||
				!event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				event.shiftKey ||
				event.key.toLowerCase() !== "c"
			) {
				return;
			}

			const target = event.target;
			if (target instanceof HTMLElement) {
				const editable =
					target.isContentEditable ||
					target.closest("input, textarea, select") !== null;
				if (editable && !target.closest("[disabled]")) return;
			}

			event.preventDefault();
			cancel();
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [cancel, probeRunning]);

	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let controller: AbortController | null = null;
		let failedChecks = 0;
		// Re-check from scratch whenever the selected vantage changes.
		setHealth("checking");

		const isWindowActive = () =>
			document.visibilityState === "visible" && document.hasFocus();

		const clearTimer = () => {
			if (timer) window.clearTimeout(timer);
			timer = null;
		};

		const stopCheck = () => {
			clearTimer();
			controller?.abort();
			controller = null;
		};

		const scheduleCheck = () => {
			clearTimer();
			if (!stopped && isWindowActive()) {
				const interval = Math.min(
					HEALTH_CHECK_INTERVAL_MS * 2 ** Math.max(0, failedChecks - 1),
					HEALTH_CHECK_MAX_BACKOFF_MS,
				);
				timer = window.setTimeout(check, interval);
			}
		};

		const check = async () => {
			if (stopped || !isWindowActive()) return;
			clearTimer();
			const currentController = new AbortController();
			controller = currentController;
			const timeout = window.setTimeout(
				() => currentController.abort(),
				HEALTH_CHECK_TIMEOUT_MS,
			);
			try {
				const res = await fetch(
					`/api/healthz?vantage=${encodeURIComponent(vantage)}`,
					{ cache: "no-store", signal: currentController.signal },
				);
				if (!stopped && controller === currentController) {
					setHealth(res.ok ? "ok" : "fail");
					failedChecks = res.ok ? 0 : failedChecks + 1;
				}
			} catch {
				if (!stopped && controller === currentController) {
					setHealth("fail");
					failedChecks += 1;
				}
			} finally {
				window.clearTimeout(timeout);
				if (controller === currentController) controller = null;
				scheduleCheck();
			}
		};

		const handleActiveChange = () => {
			if (isWindowActive()) {
				if (!controller) scheduleCheck();
				return;
			}
			stopCheck();
		};

		if (isWindowActive()) void check();
		document.addEventListener("visibilitychange", handleActiveChange);
		window.addEventListener("focus", handleActiveChange);
		window.addEventListener("blur", handleActiveChange);

		return () => {
			stopped = true;
			document.removeEventListener("visibilitychange", handleActiveChange);
			window.removeEventListener("focus", handleActiveChange);
			window.removeEventListener("blur", handleActiveChange);
			stopCheck();
		};
	}, [vantage]);

	async function runBGP() {
		if (running === "bgp") {
			cancel();
			return;
		}
		if (running || !query.trim() || !bgpEnabled || !detection.bgpType) return;

		const label = `${commandPrefix}bgp${familyFlag(activeFamily)} ${detection.bgpType} ${query.trim()}`;
		const controller = new AbortController();
		abortRef.current = controller;
		setRunning("bgp");
		setAnnounce("");
		appendCommand(label);

		try {
			await withBusyRetry(controller, async () => {
				const res = await fetch("/api/bgp", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						type: detection.bgpType,
						family: activeFamily,
						query: detection.commandQuery,
						vantage,
					}),
					signal: controller.signal,
				});
				if (BUSY_STATUSES.has(res.status)) return "busy";
				if (!res.ok) {
					const msg = await res.text().catch(() => res.statusText);
					append(`! lookup failed (${res.status}) ${msg}\n`);
					return "done";
				}
				const result = (await res.json()) as { command: string; output: string };
				append(`${result.command}\n${ensureTrailingNewline(result.output)}`);
				return "done";
			});
		} catch (error) {
			if ((error as Error).name !== "AbortError") {
				append("! lookup failed\n");
			}
		} finally {
			if (abortRef.current === controller) finish();
		}
	}

	async function runProbe(kind: Exclude<CommandKind, "bgp">) {
		if (running === kind) {
			cancel();
			return;
		}
		if (running || !query.trim() || !probeEnabled) return;

		const params = new URLSearchParams({
			target: query.trim(),
			vantage,
			family: activeFamily,
		});
		const label = `${commandPrefix}${kind}${familyFlag(activeFamily)} ${query.trim()}`;
		const controller = new AbortController();
		abortRef.current = controller;
		setRunning(kind);
		setAnnounce("");
		appendCommand(label);

		try {
			await withBusyRetry(controller, async () => {
				const res = await fetch(`/api/${kind}?${params}`, {
					headers: { Accept: "text/event-stream" },
					signal: controller.signal,
				});
				if (BUSY_STATUSES.has(res.status)) return "busy";
				if (!res.ok || !res.body) {
					const msg = await res.text().catch(() => res.statusText);
					append(`! ${kind} failed (${res.status}) ${msg || "stream error"}\n`);
					return "done";
				}
				await consumeEventStream(res.body, {
					onLine: (data) => append(`${data}\n`),
					onFail: (data) => append(`! ${data}\n`),
				});
				return "done";
			});
		} catch (error) {
			if ((error as Error).name !== "AbortError") {
				append(`! ${kind} stream closed\n`);
			}
		} finally {
			if (abortRef.current === controller) finish();
		}
	}

	const clearTerminal = () => {
		setTerminalText(loginBanner);
	};

	return (
		<div className="flex h-screen w-full flex-col gap-4 overflow-hidden px-4 py-4 sm:px-6">
			<a
				href="#lg-console"
				className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
			>
				Skip to console
			</a>
			<Header config={config} />
			<main id="lg-console" className="min-h-0 flex-1">
				<TerminalOutput
					command="ready"
					text={terminalText}
					transient={transient}
					status={announce}
					health={health}
					busy={running !== null}
					onInterrupt={probeRunning ? cancel : undefined}
					followSignal={followSignal}
					fill
					className="min-h-[16rem] w-full flex-1"
					controls={({ copy, copied }) => (
						<CommandPanel
							config={config}
							query={query}
							setQuery={setQuery}
							detection={detection}
							bgpEnabled={bgpEnabled}
							probeEnabled={probeEnabled}
							running={running}
							runBGP={runBGP}
							runProbe={runProbe}
							copyOutput={copy}
							copied={copied}
							clearTerminal={clearTerminal}
							vantage={vantage}
							setVantage={setVantage}
							family={activeFamily}
							setFamily={setFamily}
						/>
					)}
				/>
			</main>
			<FooterBar config={config} />
		</div>
	);
}

function Header({ config }: { config: PublicConfig }) {
	return (
		<header className="flex shrink-0 flex-col gap-3">
			<div className="flex items-center gap-3">
				<span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card">
					<Globe className="size-5 text-muted-foreground" aria-hidden="true" />
				</span>
				<div className="min-w-0">
					<h1 className="truncate text-xl font-semibold tracking-tight">
						{config.title}
					</h1>
					<p className="truncate text-sm text-muted-foreground">
						{config.operator}
					</p>
				</div>
				<Badge variant="secondary" className="ml-auto shrink-0 font-mono">
					{config.asNumber}
				</Badge>
			</div>
			<p className="max-w-3xl text-sm text-muted-foreground">
				{config.description}
			</p>
		</header>
	);
}

function CommandPanel({
	config,
	query,
	setQuery,
	detection,
	bgpEnabled,
	probeEnabled,
	running,
	runBGP,
	runProbe,
	copyOutput,
	copied,
	clearTerminal,
	vantage,
	setVantage,
	family,
	setFamily,
}: {
	config: PublicConfig;
	query: string;
	setQuery: (value: string) => void;
	detection: QueryDetection;
	bgpEnabled: boolean;
	probeEnabled: boolean;
	running: CommandKind | null;
	runBGP: () => void;
	runProbe: (kind: "ping" | "traceroute") => void;
	copyOutput: () => void;
	copied: boolean;
	clearTerminal: () => void;
	vantage: string;
	setVantage: (value: string) => void;
	family: QueryFamily;
	setFamily: (value: QueryFamily) => void;
}) {
	const anyRunning = running !== null;
	const disabledByRun = anyRunning && running !== "bgp";
	const dualFamily = config.addressFamilies.length > 1;

	return (
		<form
			className="grid gap-2"
			aria-label="Looking glass query"
			onSubmit={(event) => {
				event.preventDefault();
				if (bgpEnabled) runBGP();
				else if (probeEnabled) runProbe("ping");
			}}
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<div className="flex items-center gap-2">
					<span
						id="vantage-label"
						className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
					>
						<Globe aria-hidden="true" className="size-3.5" />
						Vantage
					</span>
					<Select
						value={vantage}
						onValueChange={setVantage}
						disabled={anyRunning}
					>
						<SelectTrigger
							aria-labelledby="vantage-label"
							className="h-9 w-full font-mono text-xs sm:w-72"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{config.vantages.map((v) => (
								<SelectItem
									key={v.id}
									value={v.id}
									className="font-mono text-xs"
								>
									{v.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex items-center gap-2">
					<span
						id="family-label"
						className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
					>
						<Network aria-hidden="true" className="size-3.5" />
						Family
					</span>
					{dualFamily ? (
						<Select
							value={family}
							onValueChange={(value) => setFamily(value as QueryFamily)}
							disabled={anyRunning}
						>
							<SelectTrigger
								aria-labelledby="family-label"
								className="h-9 w-full font-mono text-xs sm:w-36"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto" className="font-mono text-xs">
									Auto
								</SelectItem>
								<SelectItem value="ipv4" className="font-mono text-xs">
									IPv4
								</SelectItem>
								<SelectItem value="ipv6" className="font-mono text-xs">
									IPv6
								</SelectItem>
							</SelectContent>
						</Select>
					) : (
						<Badge variant="outline" className="h-9 px-3 font-mono text-xs">
							{familyLabel(config.addressFamilies[0] ?? "ipv4")}
						</Badge>
					)}
				</div>
			</div>
			<div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center">
				<div className="relative min-w-0 flex-1">
					<label htmlFor="q" className="sr-only">
						Query
					</label>
					<p id="q-help" className="sr-only">
						Enter an IP address, prefix, hostname, AS path expression, or BGP
						community. AS path syntax follows the configured routing backend.
					</p>
					<Input
						id="q"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={queryPlaceholder(config.routingBackend, config.addressFamilies)}
						autoComplete="off"
						spellCheck={false}
						aria-describedby={query.trim() ? "q-help q-detection" : "q-help"}
						aria-invalid={
							query.trim() && !detection.bgpType && !detection.canProbe
								? true
								: undefined
						}
						className={cn("font-mono", query.trim() ? "pr-32 sm:pr-36" : "")}
						disabled={anyRunning}
					/>
					{query.trim() && (
						<span className="pointer-events-none absolute top-1/2 right-2 flex w-24 -translate-y-1/2 justify-end sm:w-28">
							<Badge
								id="q-detection"
								variant={
									detection.bgpType || detection.canProbe
										? "secondary"
										: "outline"
								}
								className="w-full justify-center truncate"
							>
								<span className="truncate">{detection.label}</span>
							</Badge>
						</span>
					)}
				</div>
				<div className="grid min-w-0 grid-cols-5 gap-2 lg:w-[32rem] xl:w-[35rem]">
					<CommandButton
						active={running === "bgp"}
						disabled={disabledByRun || !bgpEnabled}
						onClick={runBGP}
						icon={<Search />}
						label="Lookup"
					/>
					<CommandButton
						active={running === "ping"}
						disabled={(anyRunning && running !== "ping") || !probeEnabled}
						onClick={() => runProbe("ping")}
						icon={<Activity />}
						label="Ping"
					/>
					<CommandButton
						active={running === "traceroute"}
						disabled={(anyRunning && running !== "traceroute") || !probeEnabled}
						onClick={() => runProbe("traceroute")}
						icon={<RouteIcon />}
						label="Traceroute"
					/>
					<Button
						type="button"
						variant="outline"
						onClick={copyOutput}
						aria-label={copied ? "Terminal output copied" : "Copy terminal output"}
						className="h-9 min-w-0 gap-1 px-1 text-[clamp(0.625rem,2.6vw,0.875rem)] sm:gap-1.5 sm:px-2 [&_svg]:size-[clamp(0.75rem,3vw,1rem)]"
					>
						{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
						<span className="min-w-0 truncate">
							{copied ? "Copied" : "Copy"}
						</span>
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={clearTerminal}
						aria-label="Clear terminal output"
						className="h-9 min-w-0 gap-1 px-1 text-[clamp(0.625rem,2.6vw,0.875rem)] sm:gap-1.5 sm:px-2 [&_svg]:size-[clamp(0.75rem,3vw,1rem)]"
					>
						<Trash2 aria-hidden="true" />
						<span className="min-w-0 truncate">Clear</span>
					</Button>
				</div>
			</div>
			{detection.bgpType &&
				!config.enabledQueries.includes(detection.bgpType) && (
					<p className="text-xs text-muted-foreground">
						{detection.label} queries are disabled.
					</p>
				)}
			{query.trim() &&
				detection.family &&
				!familyCompatible(detection.family, family, config.addressFamilies) && (
					<p className="text-xs text-muted-foreground">
						{familyLabel(detection.family)} is not enabled for this looking glass.
					</p>
				)}
		</form>
	);
}

function CommandButton({
	active,
	disabled,
	onClick,
	icon,
	label,
}: {
	active: boolean;
	disabled: boolean;
	onClick: () => void;
	icon: ReactNode;
	label: string;
}) {
	return (
		<Button
			type="button"
			variant={active ? "destructive" : "outline"}
			disabled={!active && disabled}
			onClick={onClick}
			aria-label={active ? `Cancel ${label.toLowerCase()}` : `Run ${label.toLowerCase()}`}
			aria-pressed={active}
			className="h-9 w-full min-w-0 gap-1 px-1 text-[clamp(0.5rem,2.5vw,0.875rem)] sm:gap-1.5 sm:px-2 [&_svg]:size-[clamp(0.7rem,3vw,1rem)]"
		>
			{active ? (
				<span className="min-w-0 truncate">Cancel</span>
			) : (
				<>
					<span aria-hidden="true">{icon}</span>
					<span className="min-w-0 truncate">{label}</span>
				</>
			)}
			{active && <LoaderCircle className="animate-spin" aria-hidden="true" />}
		</Button>
	);
}

function FooterBar({ config }: { config: PublicConfig }) {
	const asDigits = config.asNumber.replace(/\D/g, "");
	const vantageCount = config.vantages.length;
	return (
		<footer className="flex shrink-0 flex-col gap-2 border-t px-1 pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
			<p className="truncate">
				{asDigits ? (
					<a
						href={`https://bgp.tools/as/${asDigits}`}
						target="_blank"
						rel="noreferrer"
						aria-label={`View ${config.asNumber} on bgp.tools`}
						className="transition-colors hover:text-foreground"
					>
						{config.asNumber}
					</a>
					) : (
						config.asNumber
					)}{" "}
					· {vantageCount} configured {vantageCount === 1 ? "vantage" : "vantages"}
				</p>
			<nav className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{config.blogUrl && (
					<a
						href={config.blogUrl}
						aria-label="Blog"
						className="transition-colors hover:text-foreground"
					>
						Blog
					</a>
				)}
				<a
					href={config.repoUrl}
					aria-label="GitHub repository"
					className="transition-colors hover:text-foreground"
				>
					GitHub
				</a>
			</nav>
		</footer>
	);
}

function buildLoginBanner(config: PublicConfig): string {
	const { prefix, addr } = exampleTargets(config.addressFamilies);
	const lines = [
		" _      ____",
		"| |    / ___|",
		"| |   | |  _",
		"| |___| |_| |",
		"|_____|\\____|",
		"",
		"Looking Glass Edge Console",
		`login: guest@${config.asNumber.toLowerCase()}`,
		`vantage: ${config.operator}`,
		`families: ${config.addressFamilies.map(familyLabel).join("/")}`,
		`routing: ${config.routingBackend}`,
		`system: ${config.title}`,
		"",
		"Public read-only console.",
		`Try: ${prefix}, ${addr}`,
		`     host.example.com, AS64500, ${asPathExample(config.routingBackend)}, 64500:100`,
		"",
	];

	return lines.join("\n");
}

function queryPlaceholder(
	backend: RoutingBackend,
	families: AddressFamily[],
): string {
	const { prefix, addr } = exampleTargets(families);
	return `${prefix}, ${addr}, host.example.com, ${asPathExample(backend)}, 64500:100`;
}

// Concrete prefix/address examples matching the configured families, so an
// IPv6-only (or IPv4-only) deployment doesn't advertise examples in a family it
// can't query. Both ranges are documentation-only (RFC 5737 / RFC 3849).
function exampleTargets(families: AddressFamily[]): { prefix: string; addr: string } {
	const v4 = families.includes("ipv4");
	const v6 = families.includes("ipv6");
	return {
		prefix: v4 ? "192.0.2.0/24" : "2001:db8::/32",
		addr: v6 ? "2001:db8::1" : "203.0.113.1",
	};
}

function asPathExample(backend: RoutingBackend): string {
	return backend === "bird" ? "* 64500 *" : "_64500$";
}

function detectQuery(raw: string, backend: RoutingBackend): QueryDetection {
	const q = raw.trim();
	if (!q) {
		return {
			label: "Waiting",
			bgpType: null,
			canProbe: false,
			commandQuery: "",
			family: null,
		};
	}
	if (isPrefix(q)) {
		const family = addressFamilyOfPrefix(q);
		return {
			label: q.includes("/") ? "Prefix" : "Address",
			bgpType: "prefix",
			canProbe: !q.includes("/"),
			commandQuery: q,
			family,
		};
	}
	if (isCommunity(q, backend)) {
		return {
			label: "Community",
			bgpType: "community",
			canProbe: false,
			commandQuery: q,
			family: null,
		};
	}
	const prefixedASN = parsePrefixedASN(q);
	if (prefixedASN) {
		return {
			label: "AS path",
			bgpType: "as-path",
			canProbe: false,
			commandQuery:
				backend === "bird" ? `* ${prefixedASN} *` : prefixedASN,
			family: null,
		};
	}
	if (isASPath(q, backend)) {
		return {
			label: "AS path",
			bgpType: "as-path",
			canProbe: false,
			commandQuery: q,
			family: null,
		};
	}
	if (isHostname(q)) {
		return {
			label: "Host",
			bgpType: null,
			canProbe: true,
			commandQuery: q,
			family: null,
		};
	}
	return {
		label: "Not recognized",
		bgpType: null,
		canProbe: false,
		commandQuery: q,
		family: null,
	};
}

function parsePrefixedASN(value: string): string | null {
	const match = value.match(/^AS(?:N)?\s*(\d{1,10})$/i);
	return match ? match[1] : null;
}

function isPrefix(value: string): boolean {
	const [addr, bits, extra] = value.split("/");
	if (extra !== undefined) return false;
	if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return false;
	if (isIPv4(addr)) {
		return bits === undefined || Number(bits) <= 32;
	}
	if (isIPv6(addr)) {
		return bits === undefined || Number(bits) <= 128;
	}
	return false;
}

function addressFamilyOfPrefix(value: string): AddressFamily | null {
	const [addr] = value.split("/");
	if (isIPv4(addr)) return "ipv4";
	if (isIPv6(addr)) return "ipv6";
	return null;
}

function isIPv4(value: string): boolean {
	const parts = value.split(".");
	return (
		parts.length === 4 &&
		parts.every((part) => {
			if (!/^\d{1,3}$/.test(part)) return false;
			if (part.length > 1 && part.startsWith("0")) return false;
			const n = Number(part);
			return n >= 0 && n <= 255;
		})
	);
}

function isIPv6(value: string): boolean {
	if (!value.includes(":")) return false;
	if (!/^[0-9A-Fa-f:.]+$/.test(value)) return false;
	if ((value.match(/::/g) ?? []).length > 1) return false;
	const groups = value.split(":");
	return groups.every((group) => {
		if (group === "") return true;
		if (group.includes(".")) return isIPv4(group);
		return /^[0-9A-Fa-f]{1,4}$/.test(group);
	});
}

const communityRe = /^(\d{1,10}:\d{1,5}|\d{1,10}:\d{1,10}:\d{1,10})$/;
const wellKnownCommunities = new Set([
	"no-export",
	"no-advertise",
	"local-AS",
	"internet",
]);

function isCommunity(value: string, backend: RoutingBackend): boolean {
	if (backend === "bird" && value === "internet") return false;
	return wellKnownCommunities.has(value) || communityRe.test(value);
}

const frrASPathRe = /^[0-9_^$.*+()[\]| ]{1,64}$/;
const birdASPathRe = /^[0-9*? ]{1,64}$/;

function isASPath(value: string, backend: RoutingBackend): boolean {
	const re = backend === "bird" ? birdASPathRe : frrASPathRe;
	return /\d/.test(value) && re.test(value);
}

const hostnameRe =
	/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isHostname(value: string): boolean {
	return value.length <= 253 && hostnameRe.test(value);
}

function familyCompatible(
	queryFamily: AddressFamily | null,
	selected: QueryFamily,
	enabled: AddressFamily[],
): boolean {
	if (!queryFamily) return selected === "auto" || enabled.includes(selected);
	if (!enabled.includes(queryFamily)) return false;
	return selected === "auto" || selected === queryFamily;
}

function familyFlag(family: QueryFamily): string {
	switch (family) {
		case "ipv4":
			return " -4";
		case "ipv6":
			return " -6";
		default:
			return "";
	}
}

function familyLabel(family: AddressFamily): string {
	return family === "ipv4" ? "IPv4" : "IPv6";
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

function clampLines(value: string): string {
	const lines = value.split("\n");
	if (lines.length <= MAX_TERMINAL_LINES) return value;
	return lines.slice(lines.length - MAX_TERMINAL_LINES).join("\n");
}
