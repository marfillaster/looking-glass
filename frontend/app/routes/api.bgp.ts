import type { ActionFunctionArgs } from "react-router";

import { queryBGP } from "~/lib/api.server";
import { getEnv, resolveVantage } from "~/lib/env.server";
import { acquireOr429 } from "~/lib/gate.server";

// Resource route: the browser posts BGP lookups here so the main page can keep
// one terminal history and one command lifecycle. The wrapper remains the
// validation authority; this route only forwards the fixed request shape.
export async function action({ request, context }: ActionFunctionArgs) {
	const body = (await request.json().catch(() => null)) as
		| { type?: string; family?: string; query?: string; vantage?: string }
		| null;

	if (!body) {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}

	const env = getEnv(context);
	const vantage = resolveVantage(env, body.vantage);
	if (!vantage) {
		return Response.json({ error: "unknown vantage" }, { status: 400 });
	}

	const slot = await acquireOr429(context.gate, request.signal);
	if (slot instanceof Response) return slot;

	try {
		const result = await queryBGP(
			env,
			vantage.baseUrl,
			{
				type: body.type ?? "",
				family: body.family ?? "auto",
				query: body.query ?? "",
			},
			request.signal,
		);

		return Response.json(result);
	} catch (error) {
		if (error instanceof Response) return error;
		return Response.json({ error: "upstream error" }, { status: 502 });
	} finally {
		slot.release();
	}
}
