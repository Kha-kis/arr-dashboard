import { afterEach, describe, expect, it, vi } from "vitest";
import {
	toggleAlbumMonitoring,
	toggleBookMonitoring,
	toggleEpisodeMonitoring,
	toggleLibraryMonitoring,
} from "../index";

const cases = [
	{
		name: "top",
		path: "/api/library/monitor",
		invoke: () =>
			toggleLibraryMonitoring({
				instanceId: "owned",
				service: "radarr",
				itemId: 41,
				monitored: true,
			}),
	},
	{
		name: "episode",
		path: "/api/library/episode/monitor",
		invoke: () =>
			toggleEpisodeMonitoring({
				instanceId: "owned",
				seriesId: 41,
				episodeIds: [51],
				monitored: true,
			}),
	},
	{
		name: "album",
		path: "/api/library/album/monitor",
		invoke: () =>
			toggleAlbumMonitoring({ instanceId: "owned", artistId: 41, albumIds: [51], monitored: true }),
	},
	{
		name: "book",
		path: "/api/library/book/monitor",
		invoke: () =>
			toggleBookMonitoring({ instanceId: "owned", authorId: 41, bookIds: [51], monitored: true }),
	},
];
afterEach(() => vi.unstubAllGlobals());
describe.each(cases)("$name monitor exact success contract", ({ path, invoke }) => {
	it.each([200, 201, 202])(
		"rejects unexpected successful %s before consuming body",
		async (status) => {
			let consumed = false,
				calls = 0;
			const response = new Response("private unexpected body", { status });
			response.text = async () => {
				consumed = true;
				throw Error("Unexpected body consumed");
			};
			response.json = async () => {
				consumed = true;
				throw Error("Unexpected body consumed");
			};
			vi.stubGlobal("fetch", async (input: string, options: RequestInit) => {
				calls++;
				expect(input).toBe(path);
				expect(options.method).toBe("POST");
				return response;
			});
			await expect(invoke()).rejects.toThrow();
			expect(consumed).toBe(false);
			expect(calls).toBe(1);
		},
	);
	it("accepts exact empty204 with one unchanged POST", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async (input: string, options: RequestInit) => {
			calls++;
			expect(input).toBe(path);
			expect(options.method).toBe("POST");
			expect(JSON.parse(String(options.body))).toMatchObject({
				instanceId: "owned",
				monitored: true,
			});
			return new Response(null, { status: 204 });
		});
		await expect(invoke()).resolves.toBeUndefined();
		expect(calls).toBe(1);
	});
});
