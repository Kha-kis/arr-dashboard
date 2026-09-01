import type { HistoryItem } from "@arr/shared";
import { describe, expect, it, vi } from "vitest";
import {
	HistoryCursorStaleError,
	type HistoryPageOptions,
	type HistoryProviderStream,
	MAX_HISTORY_PROVIDERS,
	MAX_HISTORY_REQUEST_RECORDS,
	MAX_HISTORY_UPSTREAM_REQUESTS,
	paginateHistoryStreams,
} from "./history-utils.js";

const options = (overrides: Partial<HistoryPageOptions> = {}): HistoryPageOptions => ({
	pageSize: 2,
	sortDirection: "descending",
	...overrides,
});

const rawItem = (id: string, date: string, eventType = "grabbed") => ({ id, date, eventType });

const normalizedItem = (
	instanceId: string,
	instanceName: string,
	service: HistoryItem["service"],
	record: unknown,
): HistoryItem => {
	const value = record as { id: string; date: string; eventType?: string };
	return {
		id: value.id,
		date: value.date,
		eventType: value.eventType,
		instanceId,
		instanceName,
		service,
	};
};

const stream = ({
	instanceId,
	service = "sonarr",
	records,
	totalRecords = records.length,
}: {
	instanceId: string;
	service?: HistoryItem["service"];
	records: unknown[];
	totalRecords?: number | null;
}): HistoryProviderStream => ({
	instanceId,
	instanceName: instanceId,
	service,
	fetchPage: vi.fn(async ({ page, pageSize }) => ({
		records: records.slice((page - 1) * pageSize, page * pageSize),
		...(totalRecords === null ? {} : { totalRecords }),
	})),
	normalize: (record) => normalizedItem(instanceId, instanceId, service, record),
});

describe("request-wide History cursor", () => {
	it("uses one deterministic global order with a stable provider-stream tie breaker", async () => {
		const result = await paginateHistoryStreams({
			streams: [
				stream({
					instanceId: "z-instance",
					service: "radarr",
					records: [
						rawItem("z-1", "2026-08-31T12:00:00.000Z"),
						rawItem("z-2", "2026-08-31T11:00:00.000Z"),
					],
				}),
				stream({
					instanceId: "a-instance",
					records: [
						rawItem("a-1", "2026-08-31T12:00:00.000Z"),
						rawItem("a-2", "2026-08-31T10:00:00.000Z"),
					],
				}),
			],
			options: options({ pageSize: 4 }),
		});

		expect(result.items.map((item) => item.id)).toEqual(["a-1", "z-1", "z-2", "a-2"]);
		expect(result.incomplete).toBe(false);
		expect(result.totalCount).toBe(4);
	});

	it("never reserves more than 10,000 upstream records across concurrent providers", async () => {
		let requestedRecords = 0;
		const streams = Array.from({ length: 150 }, (_, streamIndex): HistoryProviderStream => {
			const instanceId = `instance-${String(streamIndex).padStart(3, "0")}`;
			return {
				instanceId,
				instanceName: instanceId,
				service: "sonarr",
				fetchPage: vi.fn(async ({ page, pageSize }) => {
					requestedRecords += pageSize;
					await Promise.resolve();
					return {
						records: Array.from({ length: pageSize }, (_, index) =>
							rawItem(
								`${instanceId}-${page}-${index}`,
								new Date(
									Date.UTC(2026, 7, 31, 12, 0, 0) - streamIndex * 1000 - index,
								).toISOString(),
							),
						),
						totalRecords: 1_000_000,
					};
				}),
				normalize: (record) => normalizedItem(instanceId, instanceId, "sonarr", record),
			};
		});

		const result = await paginateHistoryStreams({
			streams,
			options: options({ pageSize: 100 }),
		});

		expect(result.items).toHaveLength(100);
		expect(result.budgetUsed).toBeLessThanOrEqual(MAX_HISTORY_REQUEST_RECORDS);
		expect(requestedRecords).toBeLessThanOrEqual(MAX_HISTORY_REQUEST_RECORDS);
	});

	it("uses a bounded upstream scan window independent of the response page size", async () => {
		const provider = stream({
			instanceId: "sparse",
			records: Array.from({ length: MAX_HISTORY_REQUEST_RECORDS }, (_, index) =>
				rawItem(
					`ignored-${index}`,
					new Date(Date.UTC(2026, 7, 31, 12, 0, 0) - index * 1000).toISOString(),
					"ignored",
				),
			),
		});

		const result = await paginateHistoryStreams({
			streams: [provider],
			options: options({ pageSize: 1, status: "grabbed" }),
		});

		const fetchPage = provider.fetchPage as ReturnType<typeof vi.fn>;
		expect(result.items).toEqual([]);
		expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(MAX_HISTORY_UPSTREAM_REQUESTS);
		expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({ pageSize: 100 });
	});

	it("seeds exactly 200 configured providers without turning cardinality into an error", async () => {
		let requests = 0;
		const streams = Array.from(
			{ length: MAX_HISTORY_PROVIDERS },
			(_, streamIndex): HistoryProviderStream => {
				const instanceId = `instance-${String(streamIndex).padStart(3, "0")}`;
				return {
					instanceId,
					instanceName: instanceId,
					service: "sonarr",
					fetchPage: vi.fn(async () => {
						requests += 1;
						return {
							records: [
								rawItem(
									`${instanceId}-1`,
									new Date(Date.UTC(2026, 7, 31, 12, 0, 0) - streamIndex).toISOString(),
								),
							],
							totalRecords: 1,
						};
					}),
					normalize: (record) => normalizedItem(instanceId, instanceId, "sonarr", record),
				};
			},
		);

		const result = await paginateHistoryStreams({
			streams,
			options: options({ pageSize: 1 }),
		});

		expect(result.items).toHaveLength(1);
		expect(requests).toBe(MAX_HISTORY_PROVIDERS);
		expect(requests).toBeLessThanOrEqual(MAX_HISTORY_UPSTREAM_REQUESTS);
		expect(result.budgetUsed).toBeLessThanOrEqual(MAX_HISTORY_REQUEST_RECORDS);
	});

	it("does not publish another provider as complete when a short page precedes its declared total", async () => {
		const partial = stream({
			instanceId: "partial",
			records: [],
			totalRecords: 10,
		});
		const healthy = stream({
			instanceId: "healthy",
			records: [rawItem("healthy-1", "2026-08-31T12:00:00.000Z")],
		});

		const result = await paginateHistoryStreams({
			streams: [partial, healthy],
			options: options(),
		});

		expect(result.items).toEqual([]);
		expect(result.totalCount).toBeNull();
		expect(result.incomplete).toBe(true);
		expect(result.providers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ instanceId: "partial", status: "partial" }),
			]),
		);
	});

	it("skips malformed normalized records without consuming valid response slots", async () => {
		const records = [
			rawItem("bad", "2026-08-31T12:00:00.000Z"),
			rawItem("good-1", "2026-08-31T11:00:00.000Z"),
			rawItem("good-2", "2026-08-31T10:00:00.000Z"),
		];
		const malformed: HistoryProviderStream = {
			instanceId: "instance",
			instanceName: "Instance",
			service: "sonarr",
			fetchPage: vi.fn(async ({ page, pageSize }) => ({
				records: records.slice((page - 1) * pageSize, page * pageSize),
				totalRecords: records.length,
			})),
			normalize: (record) => {
				const value = record as (typeof records)[number];
				if (value.id === "bad") {
					return { id: "bad", date: value.date } as HistoryItem;
				}
				return normalizedItem("instance", "Instance", "sonarr", record);
			},
		};

		const result = await paginateHistoryStreams({
			streams: [malformed],
			options: options(),
		});

		expect(result.items.map((item) => item.id)).toEqual(["good-1", "good-2"]);
		expect(result.incomplete).toBe(true);
		expect(result.providers[0]).toMatchObject({ rejectedRecords: 1, status: "partial" });
	});

	it("rejects missing and unparseable timestamps without consuming valid response slots", async () => {
		const provider = stream({
			instanceId: "instance",
			records: [
				rawItem("bad-date", "not-a-date"),
				{ id: "missing-date", eventType: "grabbed" },
				rawItem("good-1", "2026-08-31T11:00:00.000Z"),
				rawItem("good-2", "2026-08-31T10:00:00.000Z"),
			],
		});

		const result = await paginateHistoryStreams({
			streams: [provider],
			options: options(),
		});

		expect(result.items.map((item) => item.id)).toEqual(["good-1", "good-2"]);
		expect(result.providers[0]).toMatchObject({ rejectedRecords: 2, status: "partial" });
		expect(result.incomplete).toBe(true);
	});

	it("applies an inclusive date-only window after provider normalization", async () => {
		const provider = stream({
			instanceId: "prowlarr",
			service: "prowlarr",
			records: [
				rawItem("after", "2026-09-01T00:00:00.000Z"),
				rawItem("end", "2026-08-31T23:59:59.999Z"),
				rawItem("start", "2026-08-31T00:00:00.000Z"),
				rawItem("before", "2026-08-30T23:59:59.999Z"),
			],
		});

		const result = await paginateHistoryStreams({
			streams: [provider],
			options: options({ pageSize: 4, startDate: "2026-08-31", endDate: "2026-08-31" }),
		});

		expect(result.items.map((item) => item.id)).toEqual(["end", "start"]);
		expect(result.totalCount).toBe(2);
	});

	it("resumes from an exact cursor without duplicating the prior page", async () => {
		const provider = stream({
			instanceId: "instance",
			records: [
				rawItem("one", "2026-08-31T12:00:00.000Z"),
				rawItem("two", "2026-08-31T11:00:00.000Z"),
				rawItem("three", "2026-08-31T10:00:00.000Z"),
				rawItem("four", "2026-08-31T09:00:00.000Z"),
			],
		});

		const first = await paginateHistoryStreams({ streams: [provider], options: options() });
		const second = await paginateHistoryStreams({
			streams: [provider],
			options: options(),
			cursor: first.nextCursor,
		});

		expect(first.items.map((item) => item.id)).toEqual(["one", "two"]);
		expect(second.items.map((item) => item.id)).toEqual(["three", "four"]);
		expect(new Set([...first.items, ...second.items].map((item) => item.id))).toHaveLength(4);
	});

	it("rejects a cursor when the anchored provider window changes", async () => {
		const provider = stream({
			instanceId: "instance",
			records: [
				rawItem("one", "2026-08-31T12:00:00.000Z"),
				rawItem("two", "2026-08-31T11:00:00.000Z"),
				rawItem("three", "2026-08-31T10:00:00.000Z"),
			],
		});
		const first = await paginateHistoryStreams({
			streams: [provider],
			options: options({ pageSize: 1 }),
		});
		const fetchPage = provider.fetchPage as ReturnType<typeof vi.fn>;
		fetchPage.mockResolvedValue({
			records: [
				rawItem("replacement", "2026-08-31T12:30:00.000Z"),
				rawItem("two", "2026-08-31T11:00:00.000Z"),
				rawItem("three", "2026-08-31T10:00:00.000Z"),
			],
			totalRecords: 3,
		});

		await expect(
			paginateHistoryStreams({
				streams: [provider],
				options: options({ pageSize: 1 }),
				cursor: first.nextCursor,
			}),
		).rejects.toBeInstanceOf(HistoryCursorStaleError);
	});

	it("retains the last verified anchor when the request budget ends at a page boundary", async () => {
		const providerRecords = Array.from({ length: 200 }, (_, index) =>
			rawItem(
				`leading-${index}`,
				new Date(Date.UTC(2026, 7, 31, 12, 0, 0) - index * 1000).toISOString(),
			),
		);
		const leading = stream({
			instanceId: "000-leading",
			records: providerRecords,
			totalRecords: providerRecords.length,
		});
		const otherStreams = Array.from({ length: 99 }, (_, streamIndex) =>
			stream({
				instanceId: `other-${String(streamIndex).padStart(3, "0")}`,
				records: Array.from({ length: 200 }, (_, index) =>
					rawItem(
						`other-${streamIndex}-${index}`,
						new Date(Date.UTC(2025, 7, 31, 12, 0, 0) - streamIndex * 100_000 - index).toISOString(),
					),
				),
			}),
		);

		const first = await paginateHistoryStreams({
			streams: [leading, ...otherStreams],
			options: options({ pageSize: 100 }),
		});
		expect(first.budgetUsed).toBeLessThanOrEqual(MAX_HISTORY_REQUEST_RECORDS);
		expect(first.items).toHaveLength(100);
		expect(first.nextCursor).not.toBeNull();

		const fetchLeading = leading.fetchPage as ReturnType<typeof vi.fn>;
		fetchLeading.mockImplementation(async ({ page, pageSize }) => {
			const shifted = [
				rawItem("inserted", "2026-08-31T12:30:00.000Z"),
				...providerRecords.slice(0, -1),
			];
			return {
				records: shifted.slice((page - 1) * pageSize, page * pageSize),
				totalRecords: providerRecords.length,
			};
		});

		await expect(
			paginateHistoryStreams({
				streams: [leading, ...otherStreams],
				options: options({ pageSize: 100 }),
				cursor: first.nextCursor,
			}),
		).rejects.toBeInstanceOf(HistoryCursorStaleError);
	});

	it("reserves enough request-wide budget for a page-boundary cursor to advance", async () => {
		const leadingRecords = Array.from({ length: 200 }, (_, index) =>
			rawItem(
				`leading-${index}`,
				new Date(Date.UTC(2026, 7, 31, 12, 0, 0) - index * 1000).toISOString(),
			),
		);
		const leading = stream({ instanceId: "000-leading", records: leadingRecords });
		const otherStreams = Array.from({ length: 99 }, (_, streamIndex) =>
			stream({
				instanceId: `other-${String(streamIndex).padStart(3, "0")}`,
				records: Array.from({ length: 200 }, (_, index) =>
					rawItem(
						`other-${streamIndex}-${index}`,
						new Date(Date.UTC(2025, 7, 31, 12, 0, 0) - streamIndex * 100_000 - index).toISOString(),
					),
				),
			}),
		);

		const first = await paginateHistoryStreams({
			streams: [leading, ...otherStreams],
			options: options({ pageSize: 100 }),
		});
		const second = await paginateHistoryStreams({
			streams: [leading, ...otherStreams],
			options: options({ pageSize: 100 }),
			cursor: first.nextCursor,
		});

		expect(first.items).toHaveLength(100);
		expect(second.items).toHaveLength(100);
		expect(second.items[0]?.id).toBe("leading-100");
		expect(second.nextCursor).not.toEqual(first.nextCursor);
	});
});
