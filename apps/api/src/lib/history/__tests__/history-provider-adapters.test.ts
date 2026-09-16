import type { HistoryService } from "@arr/shared";
import { LidarrClient, ProwlarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArrClient } from "../../arr/client-factory.js";
import { fetchHistoryProviderPage } from "../history-provider-adapters.js";
import { HISTORY_COLLECTION_PAGE_SIZE } from "../history-source-contract.js";

type ClientFactory = () => ArrClient;

const config = { baseUrl: "http://history-test.invalid", apiKey: "not-a-secret" };

const providers: readonly {
	service: HistoryService;
	create: ClientFactory;
	flags: Readonly<Record<string, true>>;
}[] = [
	{
		service: "sonarr",
		create: () => new SonarrClient(config),
		flags: { includeEpisode: true, includeSeries: true },
	},
	{ service: "radarr", create: () => new RadarrClient(config), flags: { includeMovie: true } },
	{ service: "prowlarr", create: () => new ProwlarrClient(config), flags: {} },
	{
		service: "lidarr",
		create: () => new LidarrClient(config),
		flags: { includeArtist: true, includeAlbum: true, includeTrack: true },
	},
	{
		service: "readarr",
		create: () => new ReadarrClient(config),
		flags: { includeAuthor: true, includeBook: true },
	},
];

function mockResponse(client: ArrClient, value: unknown): void {
	vi.spyOn(client.history, "get").mockResolvedValue(value as never);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fetchHistoryProviderPage", () => {
	it.each(providers)(
		"uses one bounded history call for $service",
		async ({ service, create, flags }) => {
			const client = create();
			const records = [{ id: 1 }];
			mockResponse(client, { records });

			const result = await fetchHistoryProviderPage({ service, client, page: 1 });

			expect(result).toEqual({
				kind: "page",
				records,
				rawRecordCount: 1,
				totalRecordsHint: null,
			});
			expect(client.history.get).toHaveBeenCalledTimes(1);
			expect(client.history.get).toHaveBeenCalledWith({
				page: 1,
				pageSize: HISTORY_COLLECTION_PAGE_SIZE,
				sortKey: "date",
				sortDirection: "descending",
				...flags,
			});
		},
	);

	it("accepts only the matching concrete SDK client", async () => {
		for (const provider of providers) {
			for (const other of providers) {
				const client = other.create();
				const get = vi.spyOn(client.history, "get");
				mockResponse(client, { records: [] });
				const result = await fetchHistoryProviderPage({
					service: provider.service,
					client,
					page: 1,
				});

				if (provider.service === other.service) {
					expect(result.kind).toBe("page");
					expect(get).toHaveBeenCalledTimes(1);
				} else {
					expect(result).toEqual({ kind: "invalid", rawRecordCount: 0 });
					expect(get).not.toHaveBeenCalled();
				}
			}
		}
	});

	it("rejects a structurally compatible impostor without calling it", async () => {
		const get = vi.fn();
		const client = { history: { get } } as unknown as ArrClient;

		const result = await fetchHistoryProviderPage({
			service: "sonarr",
			client,
			page: 1,
		});

		expect(result).toEqual({ kind: "invalid", rawRecordCount: 0 });
		expect(get).not.toHaveBeenCalled();
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"1",
		101,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid page %s without an SDK call", async (page) => {
		const client = new SonarrClient(config);
		const get = vi.spyOn(client.history, "get");

		const result = await fetchHistoryProviderPage({
			service: "sonarr",
			client,
			page: page as unknown as number,
		});

		expect(result).toEqual({ kind: "invalid", rawRecordCount: 0 });
		expect(get).not.toHaveBeenCalled();
	});

	it("accepts the first and last bounded page", async () => {
		for (const page of [1, 100]) {
			const client = new SonarrClient(config);
			mockResponse(client, { records: [] });

			const result = await fetchHistoryProviderPage({ service: "sonarr", client, page });

			expect(result.kind).toBe("page");
			expect(client.history.get).toHaveBeenCalledWith({
				page,
				pageSize: 100,
				sortKey: "date",
				sortDirection: "descending",
				includeEpisode: true,
				includeSeries: true,
			});
		}
	});

	it.each([
		{ label: "empty", records: [] },
		{ label: "short", records: [{ id: 1 }] },
		{ label: "full", records: Array.from({ length: 100 }, (_, id) => ({ id })) },
	])("returns a shallow copy and exact raw count for $label records", async ({ records }) => {
		const client = new SonarrClient(config);
		mockResponse(client, { records });

		const result = await fetchHistoryProviderPage({ service: "sonarr", client, page: 1 });

		expect(result).toEqual({
			kind: "page",
			records,
			rawRecordCount: records.length,
			totalRecordsHint: null,
		});
		expect(result.kind === "page" && result.records).not.toBe(records);
		expect(result.kind === "page" && result.records[0]).toBe(records[0]);
	});

	it.each([undefined, null, "not-an-array", {}, 0])(
		"rejects a missing or malformed records envelope (%s)",
		async (records) => {
			const client = new SonarrClient(config);
			mockResponse(client, records === undefined ? {} : { records });

			const result = await fetchHistoryProviderPage({ service: "sonarr", client, page: 1 });

			expect(result).toEqual({ kind: "invalid", rawRecordCount: 0 });
		},
	);

	it("accepts inherited records while preserving the same envelope contract", async () => {
		const client = new SonarrClient(config);
		const response = Object.create({ records: [{ id: 1 }] }) as object;
		mockResponse(client, response);

		const result = await fetchHistoryProviderPage({ service: "sonarr", client, page: 1 });

		expect(result.kind).toBe("page");
		expect(result.kind === "page" && result.rawRecordCount).toBe(1);
	});

	it("rejects an oversized array while reporting its actual raw count and no rows", async () => {
		const client = new SonarrClient(config);
		mockResponse(client, { records: Array.from({ length: 101 }, (_, id) => ({ id })) });

		const result = await fetchHistoryProviderPage({ service: "sonarr", client, page: 1 });

		expect(result).toEqual({ kind: "invalid", rawRecordCount: 101 });
	});

	it.each([undefined, null, "100", 1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
		"turns non-authoritative total hint %s into null",
		async (totalRecords) => {
			const client = new SonarrClient(config);
			const page = totalRecords === 99 ? 2 : 1;
			const records = page === 2 ? [{ id: 1 }, { id: 2 }] : [{ id: 1 }];
			mockResponse(client, { records, totalRecords });

			const result = await fetchHistoryProviderPage({ service: "sonarr", client, page });

			expect(result).toEqual({
				kind: "page",
				records,
				rawRecordCount: records.length,
				totalRecordsHint: null,
			});
		},
	);

	it.each([1, 100, Number.MAX_SAFE_INTEGER])(
		"retains a covered safe total hint %s",
		async (totalRecords) => {
			const client = new SonarrClient(config);
			mockResponse(client, { records: [{ id: 1 }], totalRecords });

			const result = await fetchHistoryProviderPage({ service: "sonarr", client, page: 1 });

			expect(result.kind === "page" && result.totalRecordsHint).toBe(totalRecords);
		},
	);

	it("uses the covered-row lower bound for later pages", async () => {
		const client = new SonarrClient(config);
		mockResponse(client, { records: [{ id: 1 }, { id: 2 }], totalRecords: 102 });

		const result = await fetchHistoryProviderPage({ service: "sonarr", client, page: 2 });

		expect(result.kind === "page" && result.totalRecordsHint).toBe(102);
	});

	it("rejects a later-page total below the rows already covered", async () => {
		const client = new SonarrClient(config);
		const records = Array.from({ length: 100 }, (_, id) => ({ id }));
		mockResponse(client, { records, totalRecords: 199 });

		const result = await fetchHistoryProviderPage({ service: "sonarr", client, page: 2 });

		expect(result.kind === "page" && result.totalRecordsHint).toBeNull();
	});

	it("ignores echoed page and pageSize fields", async () => {
		const client = new SonarrClient(config);
		mockResponse(client, { page: 999, pageSize: 1, records: [{ id: 1 }] });

		const result = await fetchHistoryProviderPage({ service: "sonarr", client, page: 1 });

		expect(result).toEqual({
			kind: "page",
			records: [{ id: 1 }],
			rawRecordCount: 1,
			totalRecordsHint: null,
		});
	});

	it("propagates the exact SDK rejection once without logging or retrying", async () => {
		const client = new SonarrClient(config);
		const error = new Error("provider failure");
		const get = vi.spyOn(client.history, "get").mockRejectedValue(error);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(fetchHistoryProviderPage({ service: "sonarr", client, page: 1 })).rejects.toBe(
			error,
		);
		expect(get).toHaveBeenCalledTimes(1);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("does not mutate provider arrays or row objects and never echoes oversized rows", async () => {
		const row = { id: 1, nested: { untouched: true } };
		const records = [row];
		const client = new SonarrClient(config);
		mockResponse(client, { records });

		const result = await fetchHistoryProviderPage({ service: "sonarr", client, page: 1 });

		expect(records).toEqual([{ id: 1, nested: { untouched: true } }]);
		expect(row).toEqual({ id: 1, nested: { untouched: true } });
		expect(result.kind === "page" && result.records).toEqual(records);

		const oversized = Array.from({ length: 101 }, (_, id) => ({ id }));
		mockResponse(client, { records: oversized });
		const invalid = await fetchHistoryProviderPage({ service: "sonarr", client, page: 1 });
		expect(invalid).toEqual({ kind: "invalid", rawRecordCount: 101 });
	});

	it("rejects an invalid service before any SDK call", async () => {
		const client = new SonarrClient(config);
		const get = vi.spyOn(client.history, "get");

		const result = await fetchHistoryProviderPage({
			service: "not-a-history-service" as HistoryService,
			client,
			page: 1,
		});

		expect(result).toEqual({ kind: "invalid", rawRecordCount: 0 });
		expect(get).not.toHaveBeenCalled();
	});
});
