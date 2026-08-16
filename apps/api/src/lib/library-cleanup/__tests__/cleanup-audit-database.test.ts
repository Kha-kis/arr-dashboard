import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import {
	appendCleanupAuditEvent,
	appendCleanupTerminalAuditEvent,
	createCleanupTerminalAuditState,
	CleanupAuditTerminalStateConflictError,
	listCleanupAuditEvents,
} from "../cleanup-audit.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const execFileAsync = promisify(execFile);

function eventInput(index: number) {
	return {
		userId: "audit-user",
		configId: "audit-config",
		eventKey: `event-${index}`,
		actionId: "approval-a",
		correlationId: "run-a",
		actorType: "system" as const,
		actorId: null,
		eventType: "claim" as const,
		trigger: "approval" as const,
		target: { kind: "approval", id: "approval-a" },
		outcome: "success" as const,
		evidence: { verified: true },
		details: { attempt: index },
	};
}

(RUN_DB_TESTS ? describe : describe.skip)("cleanup audit writer (SQLite)", () => {
	let prisma: PrismaClient;
	let databaseDir: string;

	beforeAll(async () => {
		databaseDir = await mkdtemp(path.join(os.tmpdir(), "arr-cleanup-audit-"));
		const databasePath = path.join(databaseDir, "audit.db");
		const schemaPath = path.resolve(import.meta.dirname, "../../../../prisma/schema.prisma");
		const prismaCli = path.resolve(
			import.meta.dirname,
			"../../../../node_modules/prisma/build/index.js",
		);
		await execFileAsync(process.execPath, [
			prismaCli,
			"db",
			"push",
			"--schema",
			schemaPath,
			"--url",
			`file:${databasePath}`,
		]);
		prisma = createTestPrismaClient(databasePath);
	});

	beforeEach(async () => {
		await prisma.libraryCleanupAuditEvent.deleteMany();
		await prisma.libraryCleanupConfig.deleteMany();
		await prisma.user.deleteMany();
		await prisma.user.create({ data: { id: "audit-user", username: "audit-user" } });
		await prisma.libraryCleanupConfig.create({
			data: { id: "audit-config", userId: "audit-user" },
		});
	});

	afterAll(async () => {
		await prisma.$disconnect();
		await rm(databaseDir, { recursive: true, force: true });
	});

	it("keeps concurrent action appends contiguous, unique, and globally database ordered", async () => {
		const appended = await Promise.all(
			Array.from({ length: 12 }, (_, index) => appendCleanupAuditEvent(prisma, eventInput(index))),
		);
		const page = await listCleanupAuditEvents(prisma, {
			userId: "audit-user",
			configId: "audit-config",
			limit: 20,
		});

		expect(new Set(appended.map((event) => event.order)).size).toBe(12);
		expect(page.events.map((event) => event.actionSequence)).toEqual(
			Array.from({ length: 12 }, (_, index) => index + 1),
		);
		expect(page.events.map((event) => event.order)).toEqual(
			[...page.events.map((event) => event.order)].sort((left, right) => left - right),
		);
	});

	it("commits one canonical terminal event and its marker atomically", async () => {
		const terminalInput = {
			...eventInput(99),
			eventKey: "terminal-success",
			eventType: "succeeded" as const,
			actorType: "operator" as const,
			actorId: "audit-user",
			trigger: "approval" as const,
			outcome: "success" as const,
			summary: { reason: "Cleanup action completed successfully." },
		};
		await prisma.libraryCleanupApproval.create({
			data: {
				id: "approval-a",
				configId: "audit-config",
				instanceId: "radarr-a",
				arrItemId: 42,
				itemType: "movie",
				title: "Example Movie",
				matchedRuleId: "rule-a",
				matchedRuleName: "Old media",
				reason: "Matched cleanup policy",
				sizeOnDisk: 1n,
				status: "executed",
				expiresAt: new Date("2026-08-13T00:00:00.000Z"),
				...createCleanupTerminalAuditState(terminalInput),
			},
		});

		await appendCleanupTerminalAuditEvent(prisma, terminalInput, {
			approvalId: "approval-a",
			status: "executed",
		});

		const approval = await prisma.libraryCleanupApproval.findUniqueOrThrow({
			where: { id: "approval-a" },
		});
		expect(approval.terminalAuditRecordedAt).toBeInstanceOf(Date);
		expect(await prisma.libraryCleanupAuditEvent.count()).toBe(1);

		await appendCleanupTerminalAuditEvent(prisma, terminalInput, {
			approvalId: "approval-a",
			status: "executed",
		});
		expect(await prisma.libraryCleanupAuditEvent.count()).toBe(1);
	});

	it("rolls back a terminal event when the authoritative terminal envelope does not match", async () => {
		const terminalInput = {
			...eventInput(100),
			eventKey: "terminal-mismatch",
			eventType: "failed" as const,
			trigger: "approval" as const,
			outcome: "blocked" as const,
			summary: { reason: "Current policy blocked this action." },
		};
		await prisma.libraryCleanupApproval.create({
			data: {
				id: "approval-a",
				configId: "audit-config",
				instanceId: "radarr-a",
				arrItemId: 42,
				itemType: "movie",
				title: "Example Movie",
				matchedRuleId: "rule-a",
				matchedRuleName: "Old media",
				reason: "Matched cleanup policy",
				sizeOnDisk: 1n,
				status: "expired",
				expiresAt: new Date("2026-08-13T00:00:00.000Z"),
				...createCleanupTerminalAuditState({
					...terminalInput,
					correlationId: "different-terminal-attempt",
				}),
			},
		});

		await expect(
			appendCleanupTerminalAuditEvent(prisma, terminalInput, {
				approvalId: "approval-a",
				status: "expired",
			}),
		).rejects.toBeInstanceOf(CleanupAuditTerminalStateConflictError);
		expect(await prisma.libraryCleanupAuditEvent.count()).toBe(0);
	});
});
