import { afterEach, describe, expect, it, vi } from "vitest";
import { TautulliClient } from "../tautulli-client.js";

const log = { warn: vi.fn() } as never;

function historyResponse(): Response {
	return new Response(
		JSON.stringify({
			response: {
				result: "success",
				message: null,
				data: { data: [], recordsFiltered: 0, recordsTotal: 0 },
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("TautulliClient authoritative history completeness", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("declares row_id through DataTables json_data for stable paging", async () => {
		const fetchMock = vi.fn().mockResolvedValue(historyResponse());
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.test", "api-key", log);

		await client.getHistory({
			section_id: "2",
			start: 200,
			length: 200,
			order_column: "row_id",
			order_dir: "asc",
			grouping: 0,
			include_activity: 0,
		});

		const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
		expect(requestedUrl.searchParams.get("order_column")).toBeNull();
		expect(requestedUrl.searchParams.get("order_dir")).toBeNull();
		expect(requestedUrl.searchParams.get("start")).toBeNull();
		expect(requestedUrl.searchParams.get("length")).toBeNull();
		expect(JSON.parse(requestedUrl.searchParams.get("json_data")!)).toEqual({
			draw: 1,
			columns: [{ data: "row_id", orderable: true, searchable: false }],
			order: [{ column: 0, dir: "asc" }],
			start: 200,
			length: 200,
			search: { value: "" },
		});
		expect(requestedUrl.searchParams.get("section_id")).toBe("2");
		expect(requestedUrl.searchParams.get("grouping")).toBe("0");
		expect(requestedUrl.searchParams.get("include_activity")).toBe("0");
	});

	it("separates the refresh trigger from cached catalog pagination", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						response: {
							result: "success",
							message: null,
							data: { data: [], recordsFiltered: 0, recordsTotal: 0, last_refreshed: null },
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						response: {
							result: "success",
							message: null,
							data: {
								data: [],
								recordsFiltered: 0,
								recordsTotal: 0,
								last_refreshed: 1_777_000_000,
							},
						},
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.test", "api-key", log);

		await client.refreshLibraryMediaInfo("2");
		await client.getLibraryMediaInfo({ sectionId: "2", start: 250, length: 250 });

		const trigger = new URL(fetchMock.mock.calls[0]![0] as string);
		const page = new URL(fetchMock.mock.calls[1]![0] as string);
		expect(trigger.searchParams.get("cmd")).toBe("get_library_media_info");
		expect(trigger.searchParams.get("section_id")).toBe("2");
		expect(trigger.searchParams.get("refresh")).toBe("true");
		expect(page.searchParams.get("refresh")).toBe("false");
		expect(page.searchParams.get("start")).toBe("250");
		expect(page.searchParams.get("length")).toBe("250");
	});
});
