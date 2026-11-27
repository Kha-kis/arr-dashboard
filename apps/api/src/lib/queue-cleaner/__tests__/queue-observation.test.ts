import { once } from "node:events";
import { createServer } from "node:http";
import { NotFoundError, SonarrClient } from "arr-sdk";
import { expect, it } from "vitest";
import { readCurrentQueueItem } from "../queue-observation.js";

it("finds an exact Sonarr target on a witnessed later page using the installed SDK", async () => {
	const requests: string[] = [];
	const target = { id: 88, downloadId: "target-download", seriesId: 101, protocol: "usenet" };
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
		const client = new SonarrClient({ baseUrl, apiKey: "synthetic-test-key" });

		await expect(client.queue.getById(target.id)).rejects.toBeInstanceOf(NotFoundError);
		await expect(readCurrentQueueItem(client, "SONARR", target.id)).resolves.toEqual(target);
		expect(requests).toEqual(["/api/v3/queue/88", "1", "2", "1", "2"]);
	} finally {
		server.close();
		server.closeAllConnections();
		await once(server, "close");
	}
});
