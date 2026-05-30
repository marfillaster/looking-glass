// Local stand-in for the vtysh wrapper, for browser-verifying the frontend
// without a real FRR box. RFC-documentation ranges only. NOT for production.
//
//   node scripts/stub-wrapper.mjs   # listens on 127.0.0.1:8088
import { createServer } from "node:http";

const PORT = 8088;
const R = "\x1b[31m", G = "\x1b[32m", Y = "\x1b[33m", B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";

const BGP = `${B}BGP routing table entry for 192.0.2.0/24${X}
Paths: (2 available, best #1, table default)
  Advertised to non peer-group peers:
  ${D}2001:db8::1${X}
  ${G}65001 65010${X} ${Y}i${X}
    2001:db8::1 from 2001:db8::1 (198.51.100.1)
      Origin IGP, metric 0, localpref 100, ${G}valid, external, best${X}
      Community: ${Y}65000:100 65000:200${X}
      Last update: ${D}Thu May 29 12:00:00 2026${X}
  ${R}65002 65020 65030${X} i
    2001:db8::2 from 2001:db8::2 (198.51.100.2)
      Origin IGP, localpref 100, valid, external
      Last update: Thu May 29 11:58:13 2026`;

function send(res, status, headers, body) {
	res.writeHead(status, headers);
	res.end(body);
}

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

	if (url.pathname === "/healthz") {
		send(res, 200, { "Content-Type": "application/json" }, JSON.stringify({ status: "ok" }));
		return;
	}

	if (req.method === "POST" && url.pathname === "/api/bgp") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let q = {};
			try {
				q = JSON.parse(body || "{}");
			} catch {}
			send(
				res,
				200,
				{ "Content-Type": "application/json" },
				JSON.stringify({
					command: `show bgp ${q.query ?? "192.0.2.0/24"}`,
					output: BGP,
				}),
			);
		});
		return;
	}

	if (url.pathname === "/api/traceroute" || url.pathname === "/api/ping") {
		const target = url.searchParams.get("target") ?? "203.0.113.1";
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		const kind = url.pathname.endsWith("ping") ? "ping" : "traceroute";
		const lines =
			kind === "ping"
				? Array.from({ length: 6 }, (_, i) =>
						`64 bytes from ${target}: icmp_seq=${i + 1} ttl=57 time=${(11 + Math.random() * 4).toFixed(1)} ms`,
					)
				: [
						`traceroute to ${target}, 30 hops max, 60 byte packets`,
						...Array.from({ length: 30 }, (_, i) => {
							const hop = i + 1;
							const ms = () => (hop * 1.7 + Math.random() * 5).toFixed(3);
							return ` ${String(hop).padStart(2)}  2001:db8:${hop}::1 (2001:db8:${hop}::1)  ${ms()} ms  ${ms()} ms  ${ms()} ms`;
						}),
					];
		let i = 0;
		const tick = () => {
			if (i >= lines.length) {
				res.write("event: done\ndata: ok\n\n");
				res.end();
				return;
			}
			res.write(`event: line\ndata: ${lines[i++]}\n\n`);
			setTimeout(tick, 180);
		};
		tick();
		req.on("close", () => res.end());
		return;
	}

	send(res, 404, { "Content-Type": "text/plain" }, "not found");
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`stub wrapper on http://127.0.0.1:${PORT}`);
});
