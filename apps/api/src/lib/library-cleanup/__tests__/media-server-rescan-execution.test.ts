import { describe, expect, it, vi } from "vitest";
import {
	retryAllPendingMediaServerRescans,
	retryPendingMediaServerRescans,
	triggerCoalescedMediaServerRescans,
} from "../media-server-rescan.js";

const log = { warn: vi.fn(), error: vi.fn() };

function scan(id: string, approvalId: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		approvalId,
		instanceId: "jellyfin-1",
		service: "JELLYFIN",
		serverIdentity: "JELLYFIN:server-1",
		mediaType: "movie",
		plannedSectionIds: null,
		targetKey: `JELLYFIN:jellyfin-1:movie:${id}`,
		status: "pending",
		executionToken: null,
		attemptCount: 0,
		completedSectionIds: "[]",
		lastError: null,
		nextAttemptAt: null,
		requestStartedAt: null,
		triggeredAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function approval(id: string, terminalAuditRecordedAt: Date | null = new Date()) {
	return { id, status: "executed", terminalAuditRecordedAt, config: { userId: "user-1" } };
}

function fixture(
	rows: ReturnType<typeof scan>[],
	options: {
		approvals?: ReturnType<typeof approval>[];
		serverId?: string;
		refresh?: () => Promise<void>;
		heartbeatMs?: number;
	} = {},
) {
	const approvals = options.approvals ?? [approval("approval-1"), approval("approval-2")];
	const leases = new Map<string, { executionToken: string; updatedAt: Date }>();
	const refreshLibrary = vi.fn(options.refresh ?? (async () => undefined));
	const jellyfin = {
		getPublicInfo: vi.fn().mockResolvedValue({ id: options.serverId ?? "server-1" }),
		getServerInfo: vi.fn().mockResolvedValue({ id: options.serverId ?? "server-1" }),
		refreshLibrary,
	};
	const prisma = {
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue({
				id: "jellyfin-1",
				userId: "user-1",
				service: "JELLYFIN",
				enabled: true,
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
			}),
		},
		libraryCleanupApproval: {
			findFirst: vi.fn(
				async ({ where }: { where: { id: string; terminalAuditRecordedAt?: unknown } }) => {
					const candidate = approvals.find((entry) => entry.id === where.id) ?? null;
					return where.terminalAuditRecordedAt && candidate?.terminalAuditRecordedAt === null
						? null
						: candidate;
				},
			),
		},
		libraryCleanupMediaServerScan: {
			findMany: vi.fn(
				async ({
					where = {},
					select,
				}: {
					where?: Record<string, unknown>;
					select?: { approval?: unknown; approvalId?: boolean };
				} = {}) => {
					const wantedStatuses = (where.status as { in?: string[] } | undefined)?.in;
					const wantedApprovalIds = (where.approvalId as { in?: string[] } | undefined)?.in;
					const matching = rows.filter(
						(row) =>
							(!wantedStatuses || wantedStatuses.includes(row.status)) &&
							(!wantedApprovalIds || wantedApprovalIds.includes(row.approvalId)),
					);
					if (select?.approval) {
						return matching.map((row) => ({
							...row,
							approval: {
								config: { userId: "user-1", enabled: false, nextRunAt: new Date("2099-01-01") },
							},
						}));
					}
					if (select?.approvalId) {
						return matching.map((row) => ({ approvalId: row.approvalId }));
					}
					return matching;
				},
			),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}) => {
					const ids = (where.id as { in?: string[] } | undefined)?.in;
					const status = where.status as string | { in?: string[] } | undefined;
					const matched = rows.filter((row) => {
						const statusMatches =
							!status ||
							(typeof status === "string"
								? row.status === status
								: status.in?.includes(row.status));
						return (
							(!ids || ids.includes(row.id)) &&
							statusMatches &&
							(!("executionToken" in where) || row.executionToken === where.executionToken)
						);
					});
					for (const row of matched) {
						const { attemptCount, ...rest } = data;
						Object.assign(row, rest, { updatedAt: new Date() });
						if (attemptCount && typeof attemptCount === "object") row.attemptCount += 1;
					}
					return { count: matched.length };
				},
			),
		},
		libraryCleanupMediaServerScanLease: {
			create: vi.fn(
				async ({ data }: { data: { operationKey: string; executionToken: string } }) => {
					if (leases.has(data.operationKey))
						throw Object.assign(new Error("duplicate"), { code: "P2002" });
					leases.set(data.operationKey, {
						executionToken: data.executionToken,
						updatedAt: new Date(),
					});
				},
			),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: {
						operationKey: string;
						executionToken?: string;
						updatedAt?: { lt: Date };
					};
					data: { executionToken?: string; updatedAt?: Date };
				}) => {
					const lease = leases.get(where.operationKey);
					if (!lease) return { count: 0 };
					if (where.executionToken && lease.executionToken !== where.executionToken) {
						return { count: 0 };
					}
					if (where.updatedAt && lease.updatedAt >= where.updatedAt.lt) return { count: 0 };
					leases.set(where.operationKey, {
						executionToken: data.executionToken ?? lease.executionToken,
						updatedAt: data.updatedAt ?? new Date(),
					});
					return { count: 1 };
				},
			),
			deleteMany: vi.fn(
				async ({ where }: { where: { operationKey: string; executionToken: string } }) => {
					const lease = leases.get(where.operationKey);
					if (!lease || lease.executionToken !== where.executionToken) return { count: 0 };
					leases.delete(where.operationKey);
					return { count: 1 };
				},
			),
		},
	};
	return {
		rows,
		leases,
		jellyfin,
		prisma,
		deps: {
			prisma,
			log,
			mediaServerRescanLeaseHeartbeatMs: options.heartbeatMs,
			jellyfinRescanClientFactory: vi.fn(() => jellyfin),
			arrClientFactory: {
				create: vi.fn(() => {
					throw new Error("ARR must not be used");
				}),
			},
		},
	};
}

describe("durable media-server rescan execution", () => {
	it("does not dispatch until the authoritative terminal audit marker is durable", async () => {
		const state = fixture([scan("scan-1", "approval-1")], {
			approvals: [approval("approval-1", null)],
		});

		const result = await triggerCoalescedMediaServerRescans(state.deps as never, "user-1", [
			"approval-1",
		]);

		expect(result.triggered).toBe(0);
		expect(state.jellyfin.refreshLibrary).not.toHaveBeenCalled();
		expect(state.rows[0]!.status).toBe("pending");
	});

	it("coalesces equivalent global refreshes across approvals under one operation lease", async () => {
		const state = fixture([scan("scan-1", "approval-1"), scan("scan-2", "approval-2")]);

		const result = await triggerCoalescedMediaServerRescans(state.deps as never, "user-1", [
			"approval-1",
			"approval-2",
		]);

		expect(result.triggered).toBe(2);
		expect(state.jellyfin.refreshLibrary).toHaveBeenCalledTimes(1);
		expect(state.rows.map((row) => row.status)).toEqual(["triggered", "triggered"]);
		expect(state.rows.every((row) => (row.requestStartedAt as Date | null) instanceof Date)).toBe(
			true,
		);
	});

	it("fails closed when the live server identity differs from the prepared identity", async () => {
		const state = fixture([scan("scan-1", "approval-1")], { serverId: "replacement-server" });

		const result = await triggerCoalescedMediaServerRescans(state.deps as never, "user-1", [
			"approval-1",
		]);

		expect(result.failed).toBe(1);
		expect(state.rows[0]).toMatchObject({
			status: "failed",
			executionToken: null,
			lastError: "Media-server identity changed after cleanup was prepared.",
		});
		expect(state.jellyfin.refreshLibrary).not.toHaveBeenCalled();
	});

	it("keeps an ambiguous dispatch lease and retryable state without calling ARR", async () => {
		const state = fixture([scan("scan-1", "approval-1")], {
			refresh: async () => {
				throw new Error("connection reset after request");
			},
		});

		const result = await triggerCoalescedMediaServerRescans(state.deps as never, "user-1", [
			"approval-1",
		]);

		expect(result.failed).toBe(1);
		expect(state.rows[0]).toMatchObject({
			status: "ambiguous",
			requestStartedAt: expect.any(Date),
		});
		expect(state.prisma.libraryCleanupMediaServerScanLease.deleteMany).not.toHaveBeenCalled();
		expect([...state.leases.keys()]).toEqual(["JELLYFIN:server-1:global-library-refresh"]);
		expect(
			(state.deps.arrClientFactory as { create: ReturnType<typeof vi.fn> }).create,
		).not.toHaveBeenCalled();
	});

	it("retries durable failed scan work without an ARR dependency", async () => {
		const state = fixture([
			scan("scan-1", "approval-1", {
				status: "failed",
				nextAttemptAt: new Date(Date.now() - 1_000),
			}),
		]);

		await retryPendingMediaServerRescans(state.deps as never, "user-1");

		expect(state.jellyfin.refreshLibrary).toHaveBeenCalledOnce();
		expect(
			(state.deps.arrClientFactory as { create: ReturnType<typeof vi.fn> }).create,
		).not.toHaveBeenCalled();
	});

	it("persists completed Plex sections before an ambiguous later section dispatch", async () => {
		const state = fixture([
			scan("scan-1", "approval-1", {
				instanceId: "plex-1",
				service: "PLEX",
				serverIdentity: "PLEX:plex-1",
				plannedSectionIds: '["one","two"]',
			}),
		]);
		state.prisma.serviceInstance.findFirst.mockResolvedValue({
			id: "plex-1",
			userId: "user-1",
			service: "PLEX",
			enabled: true,
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		});
		const refreshSection = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("lost response"));
		(state.deps as Record<string, unknown>).plexRescanClientFactory = vi.fn(() => ({
			getIdentity: vi.fn().mockResolvedValue({ machineIdentifier: "plex-1" }),
			getLibrarySections: vi.fn().mockResolvedValue([
				{ key: "one", type: "movie" },
				{ key: "two", type: "movie" },
			]),
			refreshSection,
		}));

		await triggerCoalescedMediaServerRescans(state.deps as never, "user-1", ["approval-1"]);

		expect(refreshSection).toHaveBeenCalledTimes(2);
		expect(state.rows[0]).toMatchObject({
			status: "ambiguous",
			completedSectionIds: '["one"]',
			lastError: "Media-server scan response was not confirmed. Retry is scheduled.",
		});
	});

	it("refreshes sections still outstanding for any coalesced Plex approval", async () => {
		const stale = new Date(Date.now() - 11 * 60_000);
		const state = fixture([
			scan("scan-1", "approval-1", {
				instanceId: "plex-1",
				service: "PLEX",
				serverIdentity: "PLEX:plex-1",
				plannedSectionIds: '["one","two"]',
				completedSectionIds: '["one"]',
				status: "ambiguous",
				nextAttemptAt: new Date(Date.now() - 1_000),
				updatedAt: stale,
			}),
			scan("scan-2", "approval-2", {
				instanceId: "plex-1",
				service: "PLEX",
				serverIdentity: "PLEX:plex-1",
				plannedSectionIds: '["one","two"]',
			}),
		]);
		state.prisma.serviceInstance.findFirst.mockResolvedValue({
			id: "plex-1",
			userId: "user-1",
			service: "PLEX",
			enabled: true,
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		});
		const refreshSection = vi.fn().mockResolvedValue(undefined);
		(state.deps as Record<string, unknown>).plexRescanClientFactory = vi.fn(() => ({
			getIdentity: vi.fn().mockResolvedValue({ machineIdentifier: "plex-1" }),
			getLibrarySections: vi.fn().mockResolvedValue([
				{ key: "one", type: "movie" },
				{ key: "two", type: "movie" },
			]),
			refreshSection,
		}));

		const result = await triggerCoalescedMediaServerRescans(state.deps as never, "user-1", [
			"approval-1",
			"approval-2",
		]);

		expect(result).toMatchObject({ triggered: 2, failed: 0 });
		expect(refreshSection.mock.calls.map(([sectionId]) => sectionId)).toEqual(["one", "two"]);
		expect(state.rows).toEqual([
			expect.objectContaining({ status: "triggered", completedSectionIds: '["one","two"]' }),
			expect.objectContaining({ status: "triggered", completedSectionIds: '["one","two"]' }),
		]);
	});

	it("allows one concurrent worker to dispatch an operation", async () => {
		let releaseRefresh: (() => void) | undefined;
		const refresh = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const state = fixture([scan("scan-1", "approval-1")], { refresh: async () => await refresh });

		const first = triggerCoalescedMediaServerRescans(state.deps as never, "user-1", ["approval-1"]);
		await vi.waitFor(() => expect(state.jellyfin.refreshLibrary).toHaveBeenCalledOnce());
		const second = triggerCoalescedMediaServerRescans(state.deps as never, "user-1", [
			"approval-1",
		]);
		releaseRefresh?.();
		await Promise.all([first, second]);

		expect(state.jellyfin.refreshLibrary).toHaveBeenCalledOnce();
	});

	it("renews the operation lease so a slow refresh cannot be concurrently reclaimed", async () => {
		let releaseRefresh: (() => void) | undefined;
		const refresh = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const state = fixture([scan("scan-1", "approval-1")], {
			refresh: async () => await refresh,
			heartbeatMs: 5,
		});

		const first = triggerCoalescedMediaServerRescans(state.deps as never, "user-1", ["approval-1"]);
		await vi.waitFor(() => expect(state.jellyfin.refreshLibrary).toHaveBeenCalledOnce());
		await vi.waitFor(() =>
			expect(state.prisma.libraryCleanupMediaServerScanLease.updateMany).toHaveBeenCalledWith({
				where: expect.objectContaining({ executionToken: expect.any(String) }),
				data: { updatedAt: expect.any(Date) },
			}),
		);
		state.rows[0]!.updatedAt = new Date(Date.now() - 11 * 60_000);

		const second = await triggerCoalescedMediaServerRescans(state.deps as never, "user-1", [
			"approval-1",
		]);
		expect(second.triggered).toBe(0);
		expect(state.jellyfin.refreshLibrary).toHaveBeenCalledOnce();

		releaseRefresh?.();
		await first;
	});

	it("loads only outstanding jobs when retrying one owner's media-server work", async () => {
		const historical = Array.from({ length: 250 }, (_, index) =>
			scan(`triggered-${index}`, `historical-${index}`, { status: "triggered" }),
		);
		const state = fixture([scan("scan-1", "approval-1"), ...historical]);

		await retryPendingMediaServerRescans(state.deps as never, "user-1");

		expect(state.prisma.libraryCleanupMediaServerScan.findMany).toHaveBeenNthCalledWith(1, {
			where: {
				status: { in: ["pending", "failed", "triggering", "ambiguous"] },
				approval: { config: { userId: "user-1" } },
			},
			select: { approvalId: true },
		});
		expect(state.prisma.libraryCleanupApproval.findFirst).toHaveBeenCalledOnce();
	});

	it("retries ancillary work for a disabled and not-due cleanup config across all users", async () => {
		const state = fixture([
			scan("scan-1", "approval-1", { status: "failed", nextAttemptAt: new Date(Date.now() - 1) }),
		]);

		const result = await retryAllPendingMediaServerRescans(state.deps as never);

		expect(result.triggered).toBe(1);
		expect(state.jellyfin.refreshLibrary).toHaveBeenCalledOnce();
		expect(state.prisma.libraryCleanupMediaServerScan.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					approval: expect.objectContaining({ config: expect.objectContaining({}) }),
				}),
			}),
		);
	});
});
