import type { LoaderFunctionArgs } from "react-router";

import { openProbeStream } from "~/lib/api.server";
import { getEnv, resolveVantage } from "~/lib/env.server";
import { acquireOr429, streamWithGateRelease } from "~/lib/gate.server";

// Resource route: proxies the wrapper's Server-Sent Events stream to the
// browser. The target is validated by the wrapper (the authority); we just pipe
// bytes. Called client-side via EventSource, never from the page loader.
export async function loader({ request, context }: LoaderFunctionArgs) {
	const url = new URL(request.url);
	const target = url.searchParams.get("target") ?? "";
	const family = url.searchParams.get("family") ?? undefined;

	const env = getEnv(context);
	const vantage = resolveVantage(env, url.searchParams.get("vantage"));
	if (!vantage) {
		return new Response("unknown vantage", { status: 400 });
	}

	const slot = await acquireOr429(context.gate, request.signal);
	if (slot instanceof Response) return slot;

	let upstream: Response;
	try {
		upstream = await openProbeStream(
			env,
			vantage.baseUrl,
			"ping",
			{ target, family },
			request.signal,
		);
	} catch (error) {
		slot.release();
		if (error instanceof Response) return error;
		return new Response("upstream error", { status: 502 });
	}

	const body = upstream.ok
		? streamWithGateRelease(upstream.body, slot)
		: upstream.body;
	if (!upstream.ok) slot.release();

	return new Response(body, {
		status: upstream.status,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
