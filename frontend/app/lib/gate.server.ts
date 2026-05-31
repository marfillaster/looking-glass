import type { LookingGlassEnv } from "./env.server";

// A global concurrency gate. Implementations: Durable Object (Worker) and Redis
// (Node). Implementations fail open: backend errors return a no-op handle.
export interface CommandGate {
	acquire(signal?: AbortSignal): Promise<GateHandle | null>;
}

export interface GateHandle {
	release(): void;
}

const noOpHandle: GateHandle = { release() {} };

export const noOpGate: CommandGate = {
	async acquire() {
		return noOpHandle;
	},
};

export async function acquireOr429(
	gate: CommandGate | undefined,
	signal?: AbortSignal,
): Promise<GateHandle | Response> {
	const slot = await (gate ?? noOpGate).acquire(signal).catch(() => noOpHandle);
	if (slot) return slot;
	return Response.json(
		{ error: "all query slots are in use" },
		{
			status: 429,
			headers: { "Retry-After": "5" },
		},
	);
}

export function streamWithGateRelease(
	body: ReadableStream<Uint8Array> | null,
	slot: GateHandle,
): ReadableStream<Uint8Array> | null {
	if (!body) {
		slot.release();
		return null;
	}

	const reader = body.getReader();
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		slot.release();
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					release();
					controller.close();
					return;
				}
				controller.enqueue(result.value);
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		async cancel(reason) {
			release();
			await reader.cancel(reason).catch(() => undefined);
		},
	});
}

export function durableObjectGate(
	env: LookingGlassEnv,
	waitUntil?: (promise: Promise<unknown>) => void,
): CommandGate {
	if (!env.COMMAND_GATE) return noOpGate;

	const namespace = env.COMMAND_GATE;
	const max = positiveInt(env.LG_MAX_CONCURRENT, 4);
	const ttlMs = positiveInt(env.LG_GATE_TTL_SEC, 30) * 1000;
	const timeoutMs = positiveInt(env.LG_GATE_TIMEOUT_MS, 500);

	return {
		async acquire(signal?: AbortSignal) {
			const id = namespace.idFromName("global");
			const stub = namespace.get(id);
			const token = crypto.randomUUID();
			try {
				const response = await withTimeout(
					stub.fetch("https://command-gate/acquire", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ max, ttlMs, token }),
						signal,
					}),
					timeoutMs,
				);
				if (!response.ok) return noOpHandle;
				const data = (await response.json().catch(() => null)) as
					| { ok?: boolean; token?: string }
					| null;
				if (data?.ok === true && data.token) {
					return durableObjectHandle(stub, data.token, waitUntil);
				}
				if (data?.ok === false) return null;
				return noOpHandle;
			} catch {
				return noOpHandle;
			}
		},
	};
}

function durableObjectHandle(
	stub: DurableObjectStubLike,
	token: string,
	waitUntil?: (promise: Promise<unknown>) => void,
): GateHandle {
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			const done = stub
				.fetch("https://command-gate/release", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ token }),
				})
				.catch(() => undefined)
				.then(() => undefined);
			if (waitUntil) {
				waitUntil(done);
			} else {
				void done;
			}
		},
	};
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("gate timeout")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export interface DurableObjectNamespaceLike {
	idFromName(name: string): unknown;
	get(id: unknown): DurableObjectStubLike;
}

interface DurableObjectStubLike {
	fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
