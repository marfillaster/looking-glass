interface AcquireRequest {
	max?: number;
	ttlMs?: number;
	token?: string;
}

interface ReleaseRequest {
	token?: string;
}

const DEFAULT_MAX = 4;
const DEFAULT_TTL_MS = 30_000;

export class CommandGate {
	private readonly state: DurableObjectState;
	private readonly slots = new Map<string, number>();

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST") {
			return new Response("method not allowed", { status: 405 });
		}

		if (url.pathname === "/acquire") {
			const body = (await request.json().catch(() => ({}))) as AcquireRequest;
			return this.acquire(body);
		}

		if (url.pathname === "/release") {
			const body = (await request.json().catch(() => ({}))) as ReleaseRequest;
			if (body.token) this.slots.delete(body.token);
			return Response.json({ ok: true });
		}

		return new Response("not found", { status: 404 });
	}

	async alarm(): Promise<void> {
		this.purgeExpired(Date.now());
		if (this.slots.size > 0) {
			await this.state.storage.setAlarm(this.nextAlarmAt());
		}
	}

	private acquire(body: AcquireRequest): Response {
		const now = Date.now();
		this.purgeExpired(now);

		const max = positiveInt(body.max, DEFAULT_MAX);
		const ttlMs = positiveInt(body.ttlMs, DEFAULT_TTL_MS);
		if (this.slots.size >= max) {
			void this.state.storage.setAlarm(this.nextAlarmAt()).catch(() => undefined);
			return Response.json({ ok: false });
		}

		const token = body.token || crypto.randomUUID();
		this.slots.set(token, now + ttlMs);
		void this.state.storage.setAlarm(this.nextAlarmAt()).catch(() => undefined);
		return Response.json({ ok: true, token });
	}

	private purgeExpired(now: number): void {
		for (const [token, expiresAt] of this.slots) {
			if (expiresAt <= now) this.slots.delete(token);
		}
	}

	private nextAlarmAt(): number {
		let next = Date.now() + DEFAULT_TTL_MS;
		for (const expiresAt of this.slots.values()) {
			next = Math.min(next, expiresAt + 1000);
		}
		return next;
	}
}

function positiveInt(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.floor(value);
}
