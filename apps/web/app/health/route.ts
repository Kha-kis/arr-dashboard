export const dynamic = "force-dynamic";

export async function GET() {
	const apiHost = process.env.API_HOST || "http://localhost:3001";
	const healthUrl = `${apiHost}/health`;
	try {
		const res = await fetch(healthUrl, {
			signal: AbortSignal.timeout(2000),
			cache: "no-store",
		});
		if (res.ok) {
			return Response.json({ status: "ok" });
		}

		// Attempt to read upstream reason for better diagnostics
		let upstreamReason = `API returned ${res.status}`;
		try {
			const body = await res.json();
			if (body?.reason) {
				upstreamReason = `API returned ${res.status}: ${body.reason}`;
			}
		} catch {
			// Response body wasn't JSON — use the status code alone
		}

		console.error(`[health] ${upstreamReason}`);
		return Response.json({ status: "error", reason: upstreamReason }, { status: 503 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[health] API health check failed: ${message}`);
		return Response.json({ status: "error", reason: "API unreachable" }, { status: 503 });
	}
}
