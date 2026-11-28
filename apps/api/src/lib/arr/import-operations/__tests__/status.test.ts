import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../prisma.js";
import {
	type ImportStatusSource,
	readCachedImportStatus,
	serializeImportStatus,
} from "../status.js";

const date = new Date("2026-10-01T12:00:00Z");
function source(change: Partial<ImportStatusSource> = {}): ImportStatusSource {
	return {
		id: "opaque-attempt",
		state: "pending",
		reason: null,
		selectedFileCount: 2,
		verifiedFileCount: 0,
		commandId: 51,
		commandState: "pending",
		commandTerminal: false,
		submissionStartedAt: date,
		files: ["first", "second"].map((item) => ({
			fileFingerprint: `v1:${createHash("sha256").update(item).digest("hex")}`,
			verifiedAt: null,
		})),
		...change,
	};
}

describe("sanitized cached import progress", () => {
	it("returns only the closed public contract, never operation internals", () => {
		const operation = {
			...source(),
			encryptedSources: "synthetic-secret",
			sourcesEncryptionIv: "synthetic-iv",
			error: "synthetic-private-error",
		};
		expect(serializeImportStatus(operation)).toEqual({
			operationId: "opaque-attempt",
			state: "pending",
			reason: null,
			selectedFileCount: 2,
			verifiedFileCount: 0,
			canConsiderNewAttempt: false,
		});
	});
	it("shows verified partial progress with explicit reconsideration, not automatic replay", () => {
		const operation = source({
			state: "partial",
			commandState: "failed",
			commandTerminal: true,
			verifiedFileCount: 1,
		});
		operation.files[0]!.verifiedAt = date;
		expect(serializeImportStatus(operation)).toMatchObject({
			state: "partial",
			verifiedFileCount: 1,
			canConsiderNewAttempt: true,
		});
	});
	it("reports completion only with terminal command and every positive file proof", () => {
		const operation = source({
			state: "completed",
			commandState: "completed",
			commandTerminal: true,
			verifiedFileCount: 2,
		});
		for (const file of operation.files) file.verifiedAt = date;
		expect(serializeImportStatus(operation)).toMatchObject({
			state: "completed",
			verifiedFileCount: 2,
			canConsiderNewAttempt: false,
		});
	});
	it("does not downgrade completed historical evidence because a connection or command log changed", () => {
		const operation = source({
			state: "completed",
			commandState: "completed",
			commandTerminal: true,
			verifiedFileCount: 2,
			reason: "connection-changed",
		});
		for (const file of operation.files) file.verifiedAt = date;
		expect(serializeImportStatus(operation)).toMatchObject({
			state: "completed",
			verifiedFileCount: 2,
			canConsiderNewAttempt: false,
		});
	});
	it.each(["future-state", "completed", "failed", "not-submitted", "partial"])(
		"normalizes inconsistent %s without inventing success or permitting work",
		(state) => {
			expect(serializeImportStatus(source({ state }))).toMatchObject({
				state: "unknown",
				reason: "evidence-unavailable",
				canConsiderNewAttempt: false,
			});
		},
	);
	it("preserves positive progress in an unrecognized state while refusing reconsideration", () => {
		const operation = source({ state: "future-state", verifiedFileCount: 1 });
		operation.files[0]!.verifiedAt = date;
		expect(serializeImportStatus(operation)).toMatchObject({
			state: "unknown",
			verifiedFileCount: 1,
			reason: "evidence-unavailable",
			canConsiderNewAttempt: false,
		});
	});
	it.each(["id", "state", "marker"])("refuses incomplete terminal %s evidence", (kind) => {
		const operation = source({
			state: "unknown",
			commandState: "completed",
			commandTerminal: true,
		});
		if (kind === "id") operation.commandId = null;
		if (kind === "state") operation.commandState = "future-state";
		if (kind === "marker") operation.submissionStartedAt = null;
		expect(serializeImportStatus(operation)).toMatchObject({
			state: "unknown",
			reason: "evidence-unavailable",
			canConsiderNewAttempt: false,
		});
	});
	it("allows consideration only for a positively terminal unknown attempt", () => {
		expect(
			serializeImportStatus(
				source({ state: "unknown", commandState: "completed", commandTerminal: true }),
			),
		).toMatchObject({ state: "unknown", canConsiderNewAttempt: true });
		expect(
			serializeImportStatus(source({ state: "unknown", commandId: null, commandState: "unknown" })),
		).toMatchObject({ state: "unknown", canConsiderNewAttempt: false });
	});
	it("distinguishes cancelled preparation from an ambiguous submitted attempt", () => {
		expect(
			serializeImportStatus(
				source({
					state: "not-submitted",
					reason: "not-submitted",
					submissionStartedAt: null,
					commandId: null,
					commandState: null,
				}),
			),
		).toMatchObject({ state: "not-submitted", canConsiderNewAttempt: true });
	});
	it("normalizes unexpected private reason text instead of echoing it", () => {
		expect(
			serializeImportStatus(source({ reason: "synthetic-private-provider-detail" })),
		).toMatchObject({ reason: "evidence-unavailable" });
	});
	it.each(["count", "proof-count", "duplicate", "invalid-date"])(
		"surfaces %s corruption rather than silently reporting invented counts",
		(kind) => {
			const operation = source();
			if (kind === "count") operation.selectedFileCount = 3;
			if (kind === "proof-count") operation.verifiedFileCount = 1;
			if (kind === "duplicate") operation.files[1] = operation.files[0]!;
			if (kind === "invalid-date") operation.files[0]!.verifiedAt = new Date("invalid");
			expect(() => serializeImportStatus(operation)).toThrow(
				"Cached import progress is unavailable",
			);
		},
	);
	it("reads only the owned cached projection, with no provider or credential lookup", async () => {
		const findFirst = vi.fn().mockResolvedValue(source());
		const prisma = { arrImportOperation: { findFirst } } as unknown as Pick<
			PrismaClient,
			"arrImportOperation"
		>;
		expect(await readCachedImportStatus(prisma, "owner", "opaque-attempt")).toMatchObject({
			state: "pending",
		});
		expect(findFirst).toHaveBeenCalledWith({
			where: { id: "opaque-attempt", userId: "owner" },
			select: {
				id: true,
				state: true,
				reason: true,
				selectedFileCount: true,
				verifiedFileCount: true,
				commandId: true,
				commandState: true,
				commandTerminal: true,
				submissionStartedAt: true,
				files: { take: 1001, select: { fileFingerprint: true, verifiedAt: true } },
			},
		});
	});
	it("returns no operation when the owner-scoped cached lookup misses", async () => {
		const findFirst = vi.fn().mockResolvedValue(null);
		const prisma = { arrImportOperation: { findFirst } } as unknown as Pick<
			PrismaClient,
			"arrImportOperation"
		>;
		expect(await readCachedImportStatus(prisma, "foreign", "opaque-attempt")).toBeNull();
		expect(findFirst.mock.calls[0]?.[0].where.userId).toBe("foreign");
	});
});
