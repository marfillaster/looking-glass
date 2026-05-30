import type { AppLoadContext } from "react-router";

// Runtime-neutral load context. Each runtime adapter (the Cloudflare Worker in
// workers/app.ts, the Node/Express server in server/index.js) builds this shape
// and hands it to the request handler, so nothing under app/ knows or cares
// which runtime it's on. `waitUntil` is optional — only edge runtimes provide
// one; on Node it's simply absent.
declare module "react-router" {
	interface AppLoadContext {
		env: LookingGlassEnv;
		waitUntil?: (promise: Promise<unknown>) => void;
	}
}

// Runtime config for the looking glass. Non-secret values come from the
// runtime's env (wrangler.json `vars` on Workers, process.env on Node);
// secrets (CF_ACCESS_CLIENT_ID/SECRET) are injected the same way and never
// committed.
export interface LookingGlassEnv {
	// Tunneled wrapper API base URL, e.g. https://lg-api.example.com. Used as the
	// single default vantage when LG_VANTAGE_POINTS is unset.
	LG_API_BASE_URL: string;
	// Optional multi-vantage map: a JSON object of display label -> that
	// vantage's origin API base URL, e.g.
	//   {"Fremont, CA":"https://us-west.example.com","Amsterdam":"https://eu.example.com"}
	// The URLs stay server-side; the browser only ever receives the labels and
	// selects one, which the Worker resolves against this allow-list.
	LG_VANTAGE_POINTS?: string;
	// Cloudflare Access service token — how the Worker authenticates to the
	// tunnel. Public users never see these.
	CF_ACCESS_CLIENT_ID?: string;
	CF_ACCESS_CLIENT_SECRET?: string;

	// Public UI copy — all placeholders in the repo, set per deploy.
	LG_SITE_TITLE?: string;
	LG_SITE_DESCRIPTION?: string;
	LG_AS_NUMBER?: string;
	LG_OPERATOR_NAME?: string;
	LG_REPO_URL?: string;
	// Optional blog/news URL shown in the footer; link is hidden when unset.
	LG_BLOG_URL?: string;
	// Public canonical URL of this looking glass, e.g. https://lg.example.com.
	// Used for canonical / Open Graph tags; safe to omit (tags are then skipped).
	LG_SITE_URL?: string;
	// Comma list of enabled BGP query types: prefix,as-path,community
	LG_ENABLED_QUERIES?: string;
	// Address-family policy: ipv4,ipv6 (dual), ipv4, ipv6, or dual.
	LG_ADDRESS_FAMILIES?: string;
	// Routing daemon the wrapper queries: frr (default) or bird. UI-only — it
	// switches the as-path input model (FRR POSIX regex vs BIRD path mask) and
	// example copy. Must match the wrapper's LG_ROUTING_BACKEND.
	LG_ROUTING_BACKEND?: string;
}

export function getEnv(context: AppLoadContext): LookingGlassEnv {
	return context.env;
}

// A query vantage point. `baseUrl` is server-only and never sent to the browser.
export interface Vantage {
	id: string;
	label: string;
	baseUrl: string;
}

// Parse the configured vantage points. LG_VANTAGE_POINTS is a JSON object of
// label -> origin API base URL; the label doubles as the id the client sends
// back. Falls back to a single vantage built from LG_API_BASE_URL when the var
// is unset, malformed, or empty.
export function vantages(env: LookingGlassEnv): Vantage[] {
	const raw = env.LG_VANTAGE_POINTS?.trim();
	if (raw) {
		try {
			const map = JSON.parse(raw) as Record<string, unknown>;
			const list: Vantage[] = [];
			for (const [label, url] of Object.entries(map)) {
				const trimmedUrl = typeof url === "string" ? url.trim() : "";
				if (label.trim() && trimmedUrl) {
					list.push({ id: label, label, baseUrl: trimmedUrl });
				}
			}
			if (list.length > 0) return list;
		} catch {
			/* malformed JSON — fall through to the single-vantage default */
		}
	}
	return [{ id: "edge", label: "Edge", baseUrl: env.LG_API_BASE_URL }];
}

// Resolve a client-supplied vantage id to a configured vantage. Returns the
// default (first) vantage when no id is given, or null when the id is not in the
// allow-list — callers must reject in that case (never trust a client URL).
export function resolveVantage(
	env: LookingGlassEnv,
	id?: string | null,
): Vantage | null {
	const list = vantages(env);
	if (!id) return list[0] ?? null;
	return list.find((v) => v.id === id) ?? null;
}

// Public, non-secret config safe to send to the browser for UI rendering.
export interface PublicConfig {
	title: string;
	description: string;
	asNumber: string;
	operator: string;
	repoUrl: string;
	blogUrl: string;
	siteUrl: string;
	enabledQueries: string[];
	addressFamilies: AddressFamily[];
	routingBackend: RoutingBackend;
	// Label-only vantage list for the picker; origin URLs are never exposed.
	vantages: { id: string; label: string }[];
}

export type AddressFamily = "ipv4" | "ipv6";
export type RoutingBackend = "frr" | "bird";

export function publicConfig(env: LookingGlassEnv): PublicConfig {
	const enabled = (env.LG_ENABLED_QUERIES ?? "prefix,as-path,community")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		title: env.LG_SITE_TITLE ?? "Looking Glass",
		description:
			env.LG_SITE_DESCRIPTION ?? "BGP route and reachability lookups from the network edge.",
		asNumber: env.LG_AS_NUMBER ?? "AS65000",
		operator: env.LG_OPERATOR_NAME ?? "Example Network",
		repoUrl: env.LG_REPO_URL ?? "https://github.com/marfillaster/looking-glass",
		blogUrl: (env.LG_BLOG_URL ?? "").replace(/\/+$/, ""),
		siteUrl: (env.LG_SITE_URL ?? "").replace(/\/+$/, ""),
		enabledQueries: enabled,
		addressFamilies: addressFamilies(env),
		routingBackend: routingBackend(env),
		vantages: vantages(env).map((v) => ({ id: v.id, label: v.label })),
	};
}

// The routing daemon the wrapper queries. UI-only: it selects the as-path input
// model and example copy. Anything other than "bird" is treated as FRR.
export function routingBackend(env: LookingGlassEnv): RoutingBackend {
	return (env.LG_ROUTING_BACKEND ?? "").trim().toLowerCase() === "bird"
		? "bird"
		: "frr";
}

export function addressFamilies(env: LookingGlassEnv): AddressFamily[] {
	const enabled = new Set<AddressFamily>();
	for (const part of (env.LG_ADDRESS_FAMILIES ?? "ipv4,ipv6").split(",")) {
		switch (part.trim().toLowerCase()) {
			case "dual":
			case "dual-stack":
			case "all":
			case "both":
				enabled.add("ipv4");
				enabled.add("ipv6");
				break;
			case "ipv4":
			case "4":
			case "v4":
				enabled.add("ipv4");
				break;
			case "ipv6":
			case "6":
			case "v6":
				enabled.add("ipv6");
				break;
		}
	}
	return enabled.size > 0 ? [...enabled] : ["ipv4", "ipv6"];
}
