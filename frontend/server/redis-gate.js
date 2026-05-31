import { randomUUID } from "node:crypto";

const ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
if n < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[4])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) + 1000)
  return 1
else
  return 0
end
`;

const noOpHandle = { release() {} };
const noOpGate = {
	async acquire() {
		return noOpHandle;
	},
};

const clients = new Map();

export function makeRedisGate(env) {
	const url = env.LG_REDIS_URL?.trim();
	if (!url) return noOpGate;

	const key = env.LG_REDIS_GATE_KEY?.trim() || "looking-glass:command-gate";
	const max = positiveInt(env.LG_MAX_CONCURRENT, 4);
	const ttlMs = positiveInt(env.LG_GATE_TTL_SEC, 30) * 1000;
	const timeoutMs = positiveInt(env.LG_GATE_TIMEOUT_MS, 500);
	void redisClient(url, timeoutMs).catch(() => undefined);

	return {
		async acquire() {
			const token = randomUUID();
			try {
				const redis = await redisClient(url, timeoutMs);
				const now = Date.now();
				const result = await withTimeout(
					redis.eval(ACQUIRE_SCRIPT, 1, key, now, ttlMs, max, token),
					timeoutMs,
				);
				if (Number(result) === 1) {
					return redisHandle(url, key, token, timeoutMs);
				}
				if (Number(result) === 0) return null;
				return noOpHandle;
			} catch {
				return noOpHandle;
			}
		},
	};
}

function redisHandle(url, key, token, timeoutMs) {
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			void releaseRedisToken(url, key, token, timeoutMs);
		},
	};
}

async function releaseRedisToken(url, key, token, timeoutMs) {
	try {
		const redis = await redisClient(url, timeoutMs);
		await withTimeout(redis.zrem(key, token), timeoutMs);
	} catch {
		// Best effort. The sorted-set expiry score reaps leaked slots.
	}
}

async function redisClient(url, timeoutMs) {
	let entry = clients.get(url);
	if (!entry) {
		entry = import("ioredis").then(({ default: Redis }) => {
			const client = new Redis(url, {
				connectTimeout: Math.max(timeoutMs, 100),
				commandTimeout: timeoutMs,
				enableOfflineQueue: false,
				maxRetriesPerRequest: 0,
			});
			client.on("error", () => {});
			return client;
		});
		clients.set(url, entry);
	}
	return entry;
}

function positiveInt(value, fallback) {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("redis gate timeout")), ms);
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
