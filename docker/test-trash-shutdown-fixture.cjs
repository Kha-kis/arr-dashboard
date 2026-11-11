"use strict";

// NODE_OPTIONS also preloads this in the launcher and web process. Only the
// packaged SQLite API child should receive the synthetic GitHub responses.
if (process.argv[1] === "/app/api/providers/sqlite/dist/index.js") {
	const originalFetch = globalThis.fetch;
	const originalAbort = AbortController.prototype.abort;
	const repo = "https://api.github.com/repos/TRaSH-Guides/Guides";
	console.log("TRaSH shutdown fixture loaded in packaged API");

	AbortController.prototype.abort = function (reason) {
		if (
			reason instanceof Error &&
			reason.message === "TRaSH GitHub read cancelled during shutdown"
		) {
			console.log("TRaSH shutdown fixture observed scheduler cancellation");
		}
		return originalAbort.call(this, reason);
	};

	globalThis.fetch = async (input, options) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
			return originalFetch(input, options);
		}

		const headers = new Headers(
			options?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		const anonymous = !headers.has("authorization");
		if (anonymous && url.href === `${repo}/commits/master`) {
			console.log("TRaSH shutdown fixture served the commit");
			return Response.json({
				sha: "a".repeat(40),
				commit: { author: { date: "2026-01-01T00:00:00Z" }, message: "Synthetic commit" },
				html_url: "https://example.invalid/synthetic-commit",
			});
		}
		if (anonymous && url.href.startsWith(`${repo}/contents/`)) {
			console.log("TRaSH shutdown fixture set the rate limit");
			return Response.json([], {
				headers: {
					"X-RateLimit-Limit": "60",
					"X-RateLimit-Remaining": "0",
					// Keep the real wait pending beyond startup and the Docker stop bound.
					"X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 600),
				},
			});
		}

		console.error("TRaSH shutdown fixture rejected a request");
		throw new Error("Unexpected request in the synthetic TRaSH shutdown fixture");
	};
}
