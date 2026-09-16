import { afterEach, describe, expect, it, vi } from "vitest";
import { TautulliClient } from "../tautulli-client.js";

const log = { warn: vi.fn() } as never;

function response(data: unknown): Response {
	return new Response(JSON.stringify({ response: { result: "success", message: null, data } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("TautulliClient target history", () => {
	it("normalizes provider numeric IDs and accepts movies without ancestors or a returned section", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					data: [
						{
							row_id: 7,
							reference_id: 6,
							rating_key: 42,
							parent_rating_key: null,
							grandparent_rating_key: "",
							guid: "plex://movie/1",
							stopped: 1_700_000_000,
							media_type: "movie",
						},
					],
					recordsFiltered: 1,
					recordsTotal: 1,
				}),
			),
		);
		const client = new TautulliClient("http://tautulli.test", "key", log);
		await expect(
			client.getTargetHistory({ rating_key: "42", section_id: "1" }),
		).resolves.toMatchObject({ data: [{ reference_id: "6", rating_key: "42" }] });
	});

	it.each([null, true, {}, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects an invalid historical reference ID (%s)",
		async (reference_id) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					response({
						data: [
							{
								row_id: 7,
								reference_id,
								rating_key: 42,
								guid: "plex://movie/1",
								stopped: 1_700_000_000,
								media_type: "movie",
							},
						],
						recordsFiltered: 1,
						recordsTotal: 1,
					}),
				),
			);
			const client = new TautulliClient("http://tautulli.test", "key", log);
			await expect(
				client.getTargetHistory({ rating_key: "42", section_id: "1" }),
			).rejects.toThrow();
		},
	);

	it("requests an exact ungrouped key with bounded row ordering", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			response({
				data: [
					{
						row_id: 7,
						reference_id: "ref-7",
						rating_key: "movie-1",
						parent_rating_key: "0",
						grandparent_rating_key: "0",
						guid: "plex://movie/1",
						stopped: 1_700_000_000,
						section_id: "movies",
						media_type: "movie",
					},
				],
				recordsFiltered: 1,
				recordsTotal: 1,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.test", "key", log);

		await expect(
			client.getTargetHistory({ rating_key: "movie-1", section_id: "movies", length: 500 }),
		).resolves.toMatchObject({ data: [{ row_id: 7, reference_id: "ref-7" }] });
		const url = new URL(fetchMock.mock.calls[0]![0] as string);
		expect(url.searchParams.get("cmd")).toBe("get_history");
		expect(url.searchParams.get("rating_key")).toBe("movie-1");
		expect(url.searchParams.get("section_id")).toBe("movies");
		expect(url.searchParams.get("grouping")).toBe("0");
		expect(url.searchParams.get("include_activity")).toBe("0");
		expect(url.searchParams.get("order_column")).toBe("row_id");
		expect(url.searchParams.get("order_dir")).toBe("desc");
		expect(url.searchParams.get("length")).toBe("500");
	});

	it("rejects an ambiguous pair of target keys before making a request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.test", "key", log);

		await expect(
			client.getTargetHistory({
				rating_key: "movie-1",
				grandparent_rating_key: "show-1",
				section_id: "movies",
			}),
		).rejects.toThrow("exactly one item key");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
