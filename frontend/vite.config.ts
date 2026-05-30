import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// DEPLOY_TARGET selects the runtime adapter the build emits for. Default
// "cloudflare" loads @cloudflare/vite-plugin and produces the Worker bundle
// (byte-for-byte the original behaviour). "node" omits that plugin so React
// Router emits a plain Node server build at build/server/index.js, which
// server/index.js serves via @react-router/express.
const deployTarget = process.env.DEPLOY_TARGET ?? "cloudflare";
const isCloudflare = deployTarget === "cloudflare";

// WRANGLER_CONFIG lets a deploy build against a non-default Wrangler config
// (e.g. a gitignored prod config carrying real vars/routes) while the repo
// default stays the committed placeholder wrangler.json. Unset = default.
const wranglerConfigPath = process.env.WRANGLER_CONFIG;

// A per-build identifier baked into the bundle. The Worker namespaces its HTML
// edge cache by this value, so every deploy starts a fresh cache namespace and a
// cached page shell can never outlive the content-hashed assets it references.
const buildId = process.env.LG_BUILD_ID ?? Date.now().toString(36);

export default defineConfig({
	define: {
		__LG_BUILD_ID__: JSON.stringify(buildId),
	},
	plugins: [
		...(isCloudflare
			? [
					cloudflare({
						viteEnvironment: { name: "ssr" },
						...(wranglerConfigPath ? { configPath: wranglerConfigPath } : {}),
					}),
				]
			: []),
		tailwindcss(),
		reactRouter(),
		tsconfigPaths(),
	],
});
