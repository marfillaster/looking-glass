import type { LoaderFunctionArgs } from "react-router";

import { authHeaders } from "~/lib/api.server";
import { getEnv, resolveVantage } from "~/lib/env.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
	const env = getEnv(context);
	const url = new URL(request.url);
	const vantage = resolveVantage(env, url.searchParams.get("vantage"));
	if (!vantage) {
		return new Response('{"status":"unknown vantage"}', {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const upstream = await fetch(new URL("/healthz", vantage.baseUrl), {
		headers: authHeaders(env, vantage.baseUrl),
		signal: request.signal,
	});

	return new Response(upstream.body, {
		status: upstream.status,
		headers: { "Content-Type": "application/json" },
	});
}
