const GEOFEED_CSV = "2a14:7583:eff9::/48,PH,PH-CAV,Cavite City,4100\n";

export function loader() {
	return new Response(GEOFEED_CSV, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Cache-Control": "public, max-age=86400",
		},
	});
}
