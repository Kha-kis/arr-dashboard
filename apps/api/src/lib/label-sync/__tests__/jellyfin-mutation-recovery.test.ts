import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	deriveActiveOperationKey,
	MAX_STARTUP_RECOVERY_ROWS,
	recoverLabelSyncMutationAttempts,
} from "../jellyfin-mutation-repository.js";

const date = new Date("2026-09-05T00:00:00.000Z");

function record(overrides: Record<string, unknown> = {}) {
	const base = {
		id: "attempt-1",
		userId: "owner-1",
		ruleId: "rule-1",
		destinationInstanceId: "destination-1",
		provider: "jellyfin",
		mediaType: "movie",
		tmdbId: 42,
		connectionGeneration: 1,
		identityGeneration: 2,
		targetItemId: "target-1",
		libraryId: "library-1",
		intentFingerprint: "intent-1",
		ruleFingerprint: "rule-1",
		destinationTag: "managed",
		activeOperationKey: null as string | null,
		claimToken: null as string | null,
		sendAttemptCount: 0,
		reconcileAttemptCount: 0,
		requestStartedAt: null as Date | null,
		lastObservedAt: null as Date | null,
		completedAt: date,
		status: "verified",
		reasonCode: "applied",
		createdAt: date,
		updatedAt: date,
	};
	return { ...base, ...overrides };
}

function activeKey(row: ReturnType<typeof record>): string {
	return deriveActiveOperationKey({
		userId: row.userId,
		ruleId: row.ruleId,
		destinationInstanceId: row.destinationInstanceId,
		provider: row.provider as "jellyfin",
		mediaType: row.mediaType as "movie",
		tmdbId: row.tmdbId,
		connectionGeneration: row.connectionGeneration,
		identityGeneration: row.identityGeneration,
		targetItemId: row.targetItemId,
		libraryId: row.libraryId,
		intentFingerprint: row.intentFingerprint,
		ruleFingerprint: row.ruleFingerprint,
		destinationTag: row.destinationTag,
	});
}

function harness(rows: Array<Record<string, unknown>>) {
	let updates = 0;
	const terminalStatuses = new Set(["verified", "noop", "failed", "blocked"]);
	const tx = {
		labelSyncMutationAttempt: {
			findMany: vi.fn(
				async (args: {
					where: { status: { notIn: string[] } };
					take: number;
					orderBy: unknown;
				}) => {
					expect(args.where.status.notIn).toEqual(["verified", "noop", "failed", "blocked"]);
					expect(args.take).toBe(10_001);
					expect(args.orderBy).toEqual({ id: "asc" });
					return rows.filter((row) => !terminalStatuses.has(String(row.status)));
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
					const found = rows.find((row) => row.id === where.id && row.userId === where.userId);
					if (!found || found.status !== where.status) return { count: 0 };
					Object.assign(found, data);
					updates += 1;
					return { count: 1 };
				},
			),
		},
	};
	const prisma = {
		$transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx),
	};
	return {
		prisma,
		rows,
		tx,
		get updates() {
			return updates;
		},
	};
}

describe("startup Jellyfin/Emby mutation recovery", () => {
	it("maps inherited active rows and preserves terminal/tokenless rows", async () => {
		const claimed = record({
			id: "claimed",
			status: "claimed",
			activeOperationKey: "pending",
			claimToken: "send-token",
			reasonCode: null,
			completedAt: null,
		});
		claimed.activeOperationKey = activeKey(claimed as ReturnType<typeof record>);
		const sending = record({
			id: "sending",
			status: "sending",
			activeOperationKey: "pending",
			claimToken: "send-token",
			sendAttemptCount: 1,
			requestStartedAt: date,
			reasonCode: null,
			completedAt: null,
		});
		sending.activeOperationKey = activeKey(sending as ReturnType<typeof record>);
		const unknown = record({
			id: "unknown",
			status: "unknown",
			activeOperationKey: "pending",
			claimToken: "reconcile-token",
			sendAttemptCount: 1,
			reconcileAttemptCount: 1,
			requestStartedAt: date,
			reasonCode: "uncertain_send",
			completedAt: null,
		});
		unknown.activeOperationKey = activeKey(unknown as ReturnType<typeof record>);
		const tokenlessUnknown = record({
			id: "tokenless-unknown",
			status: "unknown",
			activeOperationKey: "pending",
			sendAttemptCount: 1,
			requestStartedAt: date,
			reasonCode: "uncertain_send",
			completedAt: null,
		});
		tokenlessUnknown.activeOperationKey = activeKey(tokenlessUnknown as ReturnType<typeof record>);
		const terminal = record({ id: "terminal" });
		const noop = record({ id: "noop", status: "noop", reasonCode: "already_applied" });
		const failed = record({ id: "failed", status: "failed", reasonCode: "confirmed_absent" });
		const blocked = record({ id: "blocked", status: "blocked", reasonCode: "identity_changed" });
		const terminalBytes = JSON.stringify([terminal, noop, failed, blocked]);
		const result = harness([
			claimed,
			sending,
			unknown,
			tokenlessUnknown,
			terminal,
			noop,
			failed,
			blocked,
		]);
		await expect(recoverLabelSyncMutationAttempts(result.prisma, () => date)).resolves.toBe(3);
		expect(claimed).toMatchObject({
			status: "failed",
			reasonCode: "startup_before_send",
			activeOperationKey: null,
			claimToken: null,
			completedAt: date,
		});
		expect(sending).toMatchObject({
			status: "unknown",
			reasonCode: "uncertain_send",
			activeOperationKey: expect.stringMatching(/^v1:/),
			claimToken: null,
			completedAt: null,
		});
		expect(unknown).toMatchObject({ status: "unknown", claimToken: null });
		expect(tokenlessUnknown).toMatchObject({ status: "unknown", claimToken: null });
		expect(terminal).toMatchObject({ status: "verified", reasonCode: "applied" });
		expect(JSON.stringify([terminal, noop, failed, blocked])).toBe(terminalBytes);
		await expect(recoverLabelSyncMutationAttempts(result.prisma, () => date)).resolves.toBe(0);
	});

	it("exports the exact bounded recovery maximum", () => {
		expect(MAX_STARTUP_RECOVERY_ROWS).toBe(10_000);
	});

	it("fails closed before updates for overflow, malformed, future, and query errors", async () => {
		const overflow = Array.from({ length: MAX_STARTUP_RECOVERY_ROWS + 1 }, (_, index) =>
			record({ id: `overflow-${index}`, status: "future" }),
		);
		let updates = 0;
		const overflowPrisma = {
			$transaction: async (work: (tx: any) => Promise<unknown>) =>
				work({
					labelSyncMutationAttempt: {
						findMany: async () => overflow,
						updateMany: async () => {
							updates += 1;
							return { count: 1 };
						},
					},
				}),
		};
		await expect(recoverLabelSyncMutationAttempts(overflowPrisma)).rejects.toMatchObject({
			category: "dependency-failure",
		});
		expect(updates).toBe(0);
		const malformed = record({
			status: "claimed",
			activeOperationKey: null,
			claimToken: "token",
			completedAt: null,
		});
		const malformedHarness = harness([malformed]);
		await expect(recoverLabelSyncMutationAttempts(malformedHarness.prisma)).rejects.toMatchObject({
			category: "dependency-failure",
		});
		expect(malformedHarness.updates).toBe(0);
		const future = harness([record({ status: "future" })]);
		await expect(recoverLabelSyncMutationAttempts(future.prisma)).rejects.toMatchObject({
			category: "dependency-failure",
		});
		expect(future.updates).toBe(0);
		const queryPrisma = {
			$transaction: async () => {
				throw new Error("private query detail");
			},
		};
		await expect(recoverLabelSyncMutationAttempts(queryPrisma)).rejects.toMatchObject({
			category: "dependency-failure",
		});
	});

	it("keeps privacy canaries out of recovery errors and provider code", async () => {
		const secret = "provider title https://private.example/token credential";
		const queryPrisma = {
			$transaction: async () => {
				throw new Error(secret);
			},
		};
		const error = await recoverLabelSyncMutationAttempts(queryPrisma).catch((failure) => failure);
		expect(JSON.stringify(error)).not.toContain(secret);
		const source = readFileSync(
			new URL("../jellyfin-mutation-repository.ts", import.meta.url),
			"utf8",
		);
		expect(source).not.toMatch(/jellyfin-client|emby-client|provider-client|fetch\(|axios/);
	});

	it("rolls back a later CAS failure", async () => {
		const claimed = record({
			id: "rollback-claimed",
			status: "claimed",
			activeOperationKey: "pending",
			claimToken: "send-token",
			completedAt: null,
		});
		claimed.activeOperationKey = activeKey(claimed as ReturnType<typeof record>);
		const sending = record({
			id: "rollback-sending",
			status: "sending",
			activeOperationKey: "pending",
			claimToken: "send-token",
			sendAttemptCount: 1,
			requestStartedAt: date,
			completedAt: null,
		});
		sending.activeOperationKey = activeKey(sending as ReturnType<typeof record>);
		const rows = [claimed, sending];
		const transaction = {
			labelSyncMutationAttempt: {
				findMany: async () => rows,
				updateMany: async ({
					where,
					data,
				}: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}) => {
					const found = rows.find((row) => row.id === where.id);
					if (!found || found.id === sending.id) return { count: 0 };
					Object.assign(found, data);
					return { count: 1 };
				},
			},
		};
		const before = JSON.stringify(rows);
		const prisma = {
			$transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
				try {
					return await work(transaction);
				} catch (error) {
					const restored = JSON.parse(before) as typeof rows;
					rows.splice(0, rows.length, ...restored);
					throw error;
				}
			},
		};
		await expect(recoverLabelSyncMutationAttempts(prisma)).rejects.toMatchObject({
			category: "dependency-failure",
		});
		expect(rows).toEqual(JSON.parse(before));
	});
});
