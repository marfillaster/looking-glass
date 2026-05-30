// Node/Express runtime adapter for the looking-glass frontend.
//
// This is the Node counterpart to workers/app.ts: it serves the React Router
// SSR build produced by `npm run build:node` (DEPLOY_TARGET=node), which emits
// a plain Node server bundle at build/server/index.js. Nothing under app/ is
// runtime-specific — getLoadContext below supplies the same neutral
// AppLoadContext shape ({ env }) the Worker adapter builds, so the exact same
// route code runs here.
//
// Run with: node server/index.js   (after `npm run build:node`)
// Env (LG_API_BASE_URL, LG_SITE_TITLE, the CF Access service token, ...) is read
// straight from process.env. PORT overrides the default 3000.
import { fileURLToPath } from "node:url";

import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";

// Resolve build paths relative to this file, not process.cwd(), so the server
// runs the same from anywhere. server/index.js lives one level below the
// frontend root; the build output sits at <root>/build.
const clientRoot = fileURLToPath(new URL("../build/client", import.meta.url));
const serverBuildUrl = new URL("../build/server/index.js", import.meta.url);

// Single local secret source: load frontend/.dev.vars — the same gitignored
// dotenv file `wrangler dev` reads — so locally you configure both runtimes in
// one place. loadEnvFile never overrides an already-set variable, so real
// process env (systemd, Docker, shell) always wins; in production the file is
// absent (gitignored, never deployed) and this is a harmless no-op.
try {
	process.loadEnvFile(fileURLToPath(new URL("../.dev.vars", import.meta.url)));
} catch (err) {
	if (err?.code !== "ENOENT") throw err;
}

// The server build is an output artifact (gitignored build/), so it can't be
// statically imported at lint time; load it dynamically at boot.
const build = await import(serverBuildUrl.href);

const app = express();

app.disable("x-powered-by");

// gzip everything EXCEPT Server-Sent Event streams. compression buffers to hit
// its byte threshold, which would stall ping/traceroute (text/event-stream is
// streamed token-by-token); skip those so chunks flush immediately.
app.use(
	compression({
		filter: (req, res) => {
			const type = res.getHeader("Content-Type");
			if (typeof type === "string" && type.includes("text/event-stream")) {
				return false;
			}
			return compression.filter(req, res);
		},
	}),
);

// Static assets. On Workers these caching rules come from public/_headers (which
// Node ignores), so replicate them here: content-hashed /assets/* are immutable
// for a year; everything else under build/client (favicon, robots.txt) revalidates.
app.use(
	"/assets",
	express.static(`${clientRoot}/assets`, {
		immutable: true,
		maxAge: "1y",
	}),
);
app.use(express.static(clientRoot, { maxAge: 0 }));

// The neutral AppLoadContext: env from the process environment, no waitUntil on
// Node (it's optional in the augmentation).
app.all(
	"*",
	createRequestHandler({
		build,
		getLoadContext: () => ({ env: process.env }),
	}),
);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
	console.log(`looking-glass frontend (node) listening on http://localhost:${port}`);
});
