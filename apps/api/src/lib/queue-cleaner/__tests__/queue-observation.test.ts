import { once } from "node:events";
import { createServer } from "node:http";
import { NotFoundError, RadarrClient, SonarrClient } from "arr-sdk";
import { expect, it, vi } from "vitest";
import { readCurrentQueueItem } from "../queue-observation.js";

it.each([
	{ service: "SONARR", Client: SonarrClient, media: { seriesId: 101 }, includeUnknown: null },
	{ service: "RADARR", Client: RadarrClient, media: { movieId: 101 }, includeUnknown: "true" },
])(
	"finds an exact $service target on a witnessed later page using the installed SDK",
	async ({ service, Client, media, includeUnknown }) => {
		const requests: string[] = [];
		const includeUnknownRequests: Array<string | null> = [];
		let targetReads = 0;
		const target = { id: 88, downloadId: "target-download", ...media, protocol: "usenet" };
		const currentTarget = { ...target, title: "Current title" };
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
			const record =
				page === 1
					? { ...target, id: 1, downloadId: "other-download" }
					: ++targetReads === 1
						? target
						: currentTarget;
			response.end(
				JSON.stringify({
					page,
					pageSize: 1,
					totalRecords: 2,
					records: [record],
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
			await expect(readCurrentQueueItem(client, service, target.id)).resolves.toEqual(
				currentTarget,
			);
			expect(requests).toEqual(["/api/v3/queue/88", "1", "2", "1", "2"]);
			expect(includeUnknownRequests).toEqual(Array(4).fill(includeUnknown));
		} finally {
			server.close();
			server.closeAllConnections();
			await once(server, "close");
		}
	},
);

it.each([
	{ lastPage: [{ id: 2, downloadId: "changed-other" }], error: /changed between observations/ },
	{ lastPage: [], error: /truncated or inconsistent/ },
])("withholds a found target when a later queue page is $error", async ({ lastPage, error }) => {
	const client = new SonarrClient({ baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-test-key" });
	const target = { id: 1, downloadId: "target" };
	const other = { id: 2, downloadId: "other" };
	const page = (number: number, records: Array<typeof target>) => ({
		page: number,
		pageSize: 1,
		totalRecords: 2,
		records,
	});
	const read = vi
		.spyOn(client.queue, "get")
		.mockResolvedValueOnce(page(1, [target]))
		.mockResolvedValueOnce(page(2, [other]))
		.mockResolvedValueOnce(page(1, [target]))
		.mockResolvedValueOnce(page(2, lastPage));

	await expect(readCurrentQueueItem(client, "SONARR", target.id)).rejects.toThrow(error);

	expect(read.mock.calls.map(([options]) => options?.page)).toEqual([1, 2, 1, 2]);
});
