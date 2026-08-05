import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../../jellyfin/jellyfin-client.js";
import { PlexClient } from "../../plex/plex-client.js";

const log = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
} as never;

describe("media-server rescan HTTP contracts", () => {
	const servers: ReturnType<typeof createServer>[] = [];

	afterEach(async () => {
		await Promise.all(
			servers
				.splice(0)
				.map(
					(server) =>
						new Promise<void>((resolve, reject) =>
							server.close((error) => (error ? reject(error) : resolve())),
						),
				),
		);
	});

	it("uses production-compatible Plex and Jellyfin/Emby scan endpoints and authentication", async () => {
		const requests: IncomingMessage[] = [];
		const server = createServer((request, response) => {
			requests.push(request);
			if (request.method === "GET" && request.url === "/library/sections") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Directory: [{ key: "7", title: "Movies", type: "movie" }],
						},
					}),
				);
				return;
			}
			if (
				request.method === "POST" &&
				(request.url === "/library/sections/7/refresh" || request.url === "/Library/Refresh")
			) {
				response.statusCode = 204;
				response.end();
				return;
			}
			response.statusCode = 404;
			response.end();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${port}`;

		const plex = new PlexClient(baseUrl, "plex-token", log);
		const jellyfin = new JellyfinClient(baseUrl, "jellyfin-token", log);
		const [section] = await plex.getLibrarySections();
		await plex.refreshSection(section!.key);
		await jellyfin.refreshLibrary();

		expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			"GET /library/sections",
			"POST /library/sections/7/refresh",
			"POST /Library/Refresh",
		]);
		expect(requests[0]!.headers["x-plex-token"]).toBe("plex-token");
		expect(requests[1]!.headers["x-plex-token"]).toBe("plex-token");
		expect(requests[2]!.headers.authorization).toContain('Token="jellyfin-token"');
	});
});
