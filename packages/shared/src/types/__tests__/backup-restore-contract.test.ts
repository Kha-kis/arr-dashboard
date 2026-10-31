import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import * as backup from "../backup";

const restoreId = "12345678-1234-4234-8234-123456789abc";
const common = { restoreId, restartRequired: true, restart: "manual-required" };
const committed = { ...common, outcome: "committed", success: true, reason: null };
const notCommitted = {
	...common,
	outcome: "not-committed",
	success: false,
	reason: "state-changed",
};
const unavailable = {
	...common,
	outcome: "unavailable",
	success: false,
	reason: "closure-unverified",
};

describe("Restore outcome evidence contract", () => {
	it.each([
		committed,
		{ ...committed, restart: "automatic-requested" },
		notCommitted,
		{ ...notCommitted, restart: "automatic-requested" },
		unavailable,
		{ ...unavailable, reason: "ownership-unavailable" },
		{ ...unavailable, reason: "commit-unknown" },
	])("accepts genuine bounded publication result %j", (result) => {
		expect(backup.restoreBackupResponseSchema.parse(result)).toEqual(result);
	});

	it.each([
		{ success: true },
		{ ...committed, success: false },
		{ ...committed, reason: "commit-unknown" },
		{ ...notCommitted, success: true },
		{ ...notCommitted, reason: null },
		{ ...unavailable, success: true },
		{ ...unavailable, reason: null },
		{ ...unavailable, restart: "automatic-requested" },
		{ ...committed, restartRequired: false },
		{ ...committed, restart: "completed" },
		{ ...committed, restoreId: "not-a-uuid" },
		{ ...committed, outcome: "accepted" },
		{ ...committed, ownerBackendPid: 123 },
		{ ...committed, metadata: { version: "1.4" } },
		{ ...committed, secret: "synthetic-private-value" },
	])("rejects contradictory or unsupported result %j", (result) => {
		expect(backup.restoreBackupResponseSchema.safeParse(result).success).toBe(false);
	});

	it.each(["restoreId", "restartRequired", "restart", "outcome", "success", "reason"])(
		"rejects missing required evidence field %s",
		(field) => {
			const result: Record<string, unknown> = { ...committed };
			delete result[field];
			expect(backup.restoreBackupResponseSchema.safeParse(result).success).toBe(false);
		},
	);
});

describe("Restore request bounds and authority", () => {
	it("accepts an upload without silently adding a password", () => {
		expect(backup.restoreBackupRequestSchema.parse({ backupData: "e30=" })).toEqual({
			backupData: "e30=",
		});
	});
	it("preserves an explicitly entered password without trimming it", () => {
		expect(
			backup.restoreBackupRequestSchema.parse({ backupData: "e30=", password: " synthetic " }),
		).toEqual({ backupData: "e30=", password: " synthetic " });
	});
	it("retains the supported upload boundary and refuses overflow", () => {
		const boundary = "a".repeat(50 * 1024 * 1024);
		expect(backup.restoreBackupRequestSchema.safeParse({ backupData: boundary }).success).toBe(
			true,
		);
		expect(
			backup.restoreBackupRequestSchema.safeParse({ backupData: `${boundary}a` }).success,
		).toBe(false);
	});
	it.each([
		{ backupData: "" },
		{ backupData: "e30=", password: "" },
		{ backupData: "e30=", password: "a".repeat(1025) },
		{ backupData: "e30=", installationId: "client-authority" },
		{ backupData: "e30=", runtimeEpoch: "client-authority" },
		{ backupData: "e30=", prepared: {} },
	])("rejects invalid or authority-bearing upload %j", (request) => {
		expect(backup.restoreBackupRequestSchema.safeParse(request).success).toBe(false);
	});
	it("accepts the existing stored ID with an optional password", () => {
		const id = "a".repeat(24);
		expect(backup.restoreBackupFromFileRequestSchema.parse({ id })).toEqual({ id });
		expect(backup.restoreBackupFromFileRequestSchema.parse({ id, password: "synthetic" })).toEqual({
			id,
			password: "synthetic",
		});
	});
	it.each([
		{ id: "" },
		{ id: "../synthetic.json" },
		{ id: "A".repeat(24) },
		{ id: "a".repeat(23) },
		{ id: "a".repeat(25) },
		{ id: "a".repeat(24), path: "/synthetic/private.json" },
		{ id: "a".repeat(24), password: "" },
		{ id: "a".repeat(24), password: "a".repeat(1025) },
	])("rejects malformed stored selection %j", (request) => {
		expect(backup.restoreBackupFromFileRequestSchema.safeParse(request).success).toBe(false);
	});
});

describe("Protected latest-positive Restore status contract", () => {
	function schema(): ZodType {
		const value = Reflect.get(backup, "restoreStatusResponseSchema");
		expect(value?.safeParse).toBeTypeOf("function");
		return value as ZodType;
	}
	it("represents no positive record without claiming rollback", () => {
		expect(schema().parse({ latestCommitted: null })).toEqual({ latestCommitted: null });
	});
	it("accepts a bounded genuine positive marker", () => {
		const status = {
			latestCommitted: { restoreId, committedAt: "2026-10-09T12:00:00.000Z" },
		};
		expect(schema().parse(status)).toEqual(status);
	});
	it.each([
		{},
		{ latestCommitted: null, outcome: "not-committed" },
		{ latestCommitted: null, activeRestoreId: restoreId },
		{ latestCommitted: { restoreId: "bad-id", committedAt: "2026-10-09T12:00:00.000Z" } },
		{ latestCommitted: { restoreId, committedAt: "not-a-date" } },
		{ latestCommitted: { restoreId, committedAt: "2026-10-09T12:00:00.000Z", runtimeEpoch: "x" } },
	])("rejects fabricated or private status %j", (status) => {
		expect(schema().safeParse(status).success).toBe(false);
	});
});
