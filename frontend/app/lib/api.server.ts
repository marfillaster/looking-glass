import type { LookingGlassEnv } from "./env.server";

// Server-only client for the tunneled wrapper API. Every request carries the
// Cloudflare Access service-token headers so only this Worker can reach the
// tunnel; the public never talks to the wrapper directly.

export function authHeaders(env: LookingGlassEnv, baseUrl: string): HeadersInit {
	// Edge auth only: the CF Access service token gets the Worker past Access to
	// the tunnel. The wrapper itself does no client auth — it binds loopback.
	const h: Record<string, string> = {};
	if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
		h["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
		h["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
	} else if (!isLoopbackOrigin(baseUrl) && !envFlag(env.LG_UNSAFE_NON_LOOPBACK)) {
		throw new Response(
			"Cloudflare Access service token is not configured for non-loopback origin",
			{ status: 500 },
		);
	}
	return h;
}

function envFlag(value: string | undefined): boolean {
	switch ((value ?? "").trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

function isLoopbackOrigin(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
		return host === "localhost" || host === "::1" || host.startsWith("127.");
	} catch {
		return false;
	}
}

export interface BGPResult {
	command: string;
	output: string;
}

// Fast BGP query — safe to call from an SSR loader (the wrapper bounds it).
// `baseUrl` is the resolved vantage origin (see resolveVantage in env.server).
export async function queryBGP(
	env: LookingGlassEnv,
	baseUrl: string,
	body: { type: string; family: string; query: string },
	signal?: AbortSignal,
): Promise<BGPResult> {
	const res = await fetch(new URL("/api/bgp", baseUrl), {
		method: "POST",
		headers: { ...authHeaders(env, baseUrl), "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		const msg = await res.text().catch(() => res.statusText);
		throw new Response(msg || "upstream error", { status: res.status });
	}
	return (await res.json()) as BGPResult;
}

// Open a streaming probe (ping/traceroute) against the wrapper and return the
// upstream Response so a resource route can pipe its body straight to the
// client. Long probes never sit in an SSR loader — the browser calls these.
export function openProbeStream(
	env: LookingGlassEnv,
	baseUrl: string,
	kind: "ping" | "traceroute",
	params: { target: string; family?: string },
	signal?: AbortSignal,
): Promise<Response> {
	const url = new URL(`/api/${kind}`, baseUrl);
	url.searchParams.set("target", params.target);
	if (params.family) url.searchParams.set("family", params.family);
	return fetch(url, {
		headers: { ...authHeaders(env, baseUrl), Accept: "text/event-stream" },
		signal,
	});
}
