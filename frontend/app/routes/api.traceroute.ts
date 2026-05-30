import type { LoaderFunctionArgs } from "react-router";

import { openProbeStream } from "~/lib/api.server";
import { getEnv, resolveVantage } from "~/lib/env.server";

// Resource route: proxies the wrapper's traceroute SSE stream to the browser.
// See api.ping.ts — same contract, longer-running probe.
export async function loader({ request, context }: LoaderFunctionArgs) {
	const url = new URL(request.url);
	const target = url.searchParams.get("target") ?? "";
	const family = url.searchParams.get("family") ?? undefined;

	const env = getEnv(context);
	const vantage = resolveVantage(env, url.searchParams.get("vantage"));
	if (!vantage) {
		return new Response("unknown vantage", { status: 400 });
	}

	const upstream = await openProbeStream(
		env,
		vantage.baseUrl,
		"traceroute",
		{ target, family },
		request.signal,
	);

	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
