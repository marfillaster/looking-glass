import { createRequestHandler } from "react-router";

import type { LookingGlassEnv } from "~/lib/env.server";
import { durableObjectGate } from "~/lib/gate.server";

export { CommandGate } from "./command-gate";

// Build-time constant injected by Vite (`define` in vite.config.ts). Namespaces
// the HTML edge cache per deploy so a cached shell never references stale assets.
declare const __LG_BUILD_ID__: string;

// The neutral AppLoadContext augmentation (env + optional waitUntil) lives in
// app/lib/env.server.ts and merges globally, so this adapter just populates it.

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// Edge-cache GET HTML navigations through Cloudflare's Cache API. A plain
// Cache-Control header does NOT make Cloudflare store a Worker's own response —
// Worker output sits in front of the edge cache — so we put/match explicitly.
// Only documents the route opts into (via its `headers` Cache-Control) are
// stored; /api/* probe streams and POST lookups are never cached.
async function handleRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
	const cacheable =
		request.method === "GET" && !url.pathname.startsWith("/api/");

	const context = {
		env: env as unknown as LookingGlassEnv,
		gate: durableObjectGate(env as unknown as LookingGlassEnv, ctx.waitUntil.bind(ctx)),
		waitUntil: ctx.waitUntil.bind(ctx),
	};

	if (!cacheable) {
		return requestHandler(request, context);
	}

	// `caches.default` is a Workers extension; the ambient DOM `CacheStorage`
	// type doesn't declare it.
	const cache = (caches as unknown as { default: Cache }).default;
	// Versioned, header-free key: a new deploy → new namespace → old entries
	// fall out of reach; no Vary/cookie ambiguity since the page is identical
	// for every visitor.
	const keyUrl = new URL(url.toString());
	keyUrl.searchParams.set("__lg_v", __LG_BUILD_ID__);
	const cacheKey = new Request(keyUrl.toString(), { method: "GET" });

	// Cache-API hits aren't reflected in `cf-cache-status` (that's only for the
	// CDN layer), so stamp our own `X-LG-Cache: hit|miss` for observability.
	const hit = await cache.match(cacheKey);
	if (hit) {
		const marked = new Response(hit.body, hit);
		marked.headers.set("X-LG-Cache", "hit");
		return marked;
	}

	const response = await requestHandler(request, context);

	const contentType = response.headers.get("content-type") ?? "";
	const cacheControl = response.headers.get("cache-control") ?? "";
	const storable =
		response.status === 200 &&
		contentType.includes("text/html") &&
		/(?:^|,)\s*public/.test(cacheControl) &&
		/s-maxage=\d|max-age=[1-9]/.test(cacheControl) &&
		!/no-store/.test(cacheControl);

	if (!storable) return response;

	// Store the unmarked response (clone() before its body is streamed out), then
	// serve this request a `miss`-stamped copy.
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	const marked = new Response(response.body, response);
	marked.headers.set("X-LG-Cache", "miss");
	return marked;
}

export default {
	fetch(request, env, ctx) {
		return handleRequest(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
