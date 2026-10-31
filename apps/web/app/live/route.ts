export const dynamic = "force-dynamic";

export async function GET() {
	// The supervisor catches process death; this bounded probe also catches an
	// unresponsive API event loop without making database readiness a liveness gate.
	// Allow a transient SQLite busy wait while staying below Docker's 10s probe timeout.
	try {
		const apiHost = process.env.API_HOST ?? "http://127.0.0.1:3001";
		const response = await fetch(new URL("/live", apiHost), {
			method: "HEAD",
			cache: "no-store",
			signal: AbortSignal.timeout(8_000),
		});
		if (response.ok) return Response.json({ status: "ok" });
	} catch {
		// Only a generic status is exposed; provider or network details stay private.
	}
	return Response.json({ status: "unavailable" }, { status: 503 });
}
