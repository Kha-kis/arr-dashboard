import { once } from "node:events";
import { createServer } from "node:http";
import { NotFoundError, RadarrClient, SonarrClient } from "arr-sdk";
import { expect, it } from "vitest";
import { readCurrentQueueItem } from "../queue-observation.js";

it.each([
	{ service: "SONARR", Client: SonarrClient, media: { seriesId: 101 }, includeUnknown: null },
	{ service: "RADARR", Client: RadarrClient, media: { movieId: 101 }, includeUnknown: "true" },
])(
	"finds an exact $service target on a witnessed later page using the installed SDK",
	async ({ service, Client, media, includeUnknown }) => {
		const requests: string[] = [];
		const includeUnknownRequests: Array<string | null> = [];
		const target = { id: 88, downloadId: "target-download", ...media, protocol: "usenet" };
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			response.setHeader("content-type", "application/json");
			if (request.method !== "GET" || url.pathname !== "/api/v3/queue") {
				requests.push(url.pathname);
				response.statusCode = 404;
				response.end("{}");
				return;
			}

			const page = Number(url.searchParams.get("page"));
			requests.push(String(page));
			includeUnknownRequests.push(url.searchParams.get("includeUnknownMovieItems"));
			response.end(
				JSON.stringify({
					page,
					pageSize: 1,
					totalRecords: 2,
					records: [page === 1 ? { ...target, id: 1, downloadId: "other-download" } : target],
				}),
			);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const address = server.address();
			if (typeof address !== "object" || address === null) throw new Error("Missing fixture port");
			const baseUrl = `http://127.0.0.1:${address.port}`;
			const client = new Client({ baseUrl, apiKey: "synthetic-test-key" });

			await expect(client.queue.getById(target.id)).rejects.toBeInstanceOf(NotFoundError);
			await expect(readCurrentQueueItem(client, service, target.id)).resolves.toEqual(target);
			expect(requests).toEqual(["/api/v3/queue/88", "1", "2", "1", "2"]);
			expect(includeUnknownRequests).toEqual(Array(4).fill(includeUnknown));
		} finally {
			server.close();
			server.closeAllConnections();
			await once(server, "close");
		}
	},
);
