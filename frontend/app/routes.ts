import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("geofeed.csv", "routes/geofeed.csv.ts"),
	// Streaming probe endpoints — the browser opens these (not the SSR loader),
	// so a long traceroute can't block page render or hit a subrequest timeout.
	route("api/bgp", "routes/api.bgp.ts"),
	route("api/healthz", "routes/api.healthz.ts"),
	route("api/ping", "routes/api.ping.ts"),
	route("api/traceroute", "routes/api.traceroute.ts"),
] satisfies RouteConfig;
