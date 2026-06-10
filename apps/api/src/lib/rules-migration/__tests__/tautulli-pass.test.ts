/**
 * Tautulli rules pass — unit tests for the pure planner plus an
 * integration-shaped run over a mocked Prisma + temp dir, pinning the
 * ADR-0006 5-point contract behaviors (backup first-write-wins,
 * transactional updates, report contents, idempotent no-op).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import {
	acknowledgeTautulliPassReport,
	planRuleTransform,
	readTautulliPassReport,
	runTautulliRulesPass,
	TAUTULLI_PASS_REPORT_FILE,
} from "../tautulli-pass.js";

const silentLog = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	// biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
} as any;

function rule(overrides: Partial<Parameters<typeof planRuleTransform>[0]> = {}) {
	return {
		id: "r1",
		name: "Rule",
		enabled: true,
		ruleType: "age",
		parameters: "{}",
		operator: null,
		conditions: null,
		...overrides,
	};
}

describe("planRuleTransform", () => {
	it("disables a single-condition tautulli rule, preserving the document", () => {
		const { update, change } = planRuleTransform(
			rule({ ruleType: "tautulli_last_watched", name: "Old watch rule" }),
		);
		expect(update).toEqual({ id: "r1", data: { enabled: false } });
		expect(change).toMatchObject({ reason: "tautulli-orphaned", name: "Old watch rule" });
	});

	it("is a no-op for an already-disabled tautulli rule (idempotency)", () => {
		const { update, change } = planRuleTransform(
			rule({ ruleType: "tautulli_watch_count", enabled: false }),
		);
		expect(update).toBeNull();
		expect(change).toBeNull();
	});

	it("drops tautulli conditions from a composite with surviving siblings", () => {
		const conditions = [
			{ ruleType: "tautulli_watched_by", parameters: { userNames: ["a"] } },
			{ ruleType: "size", parameters: { operator: "greater_than", sizeGb: 50 } },
		];
		const { update, change } = planRuleTransform(
			rule({ ruleType: "composite", operator: "AND", conditions: JSON.stringify(conditions) }),
		);
		expect(update?.data.conditions).toBe(
			JSON.stringify([{ ruleType: "size", parameters: { operator: "greater_than", sizeGb: 50 } }]),
		);
		expect(update?.data.enabled).toBeUndefined(); // rule stays active
		expect(change).toMatchObject({
			reason: "tautulli-condition-dropped",
			droppedConditionKinds: ["tautulli_watched_by"],
		});
	});

	it("disables a composite whose every condition is tautulli-typed, keeping conditions in-row", () => {
		const conditions = [
			{ ruleType: "tautulli_last_watched", parameters: { operator: "older_than", days: 30 } },
			{ ruleType: "tautulli_watch_count", parameters: { operator: "less_than", count: 1 } },
		];
		const { update, change } = planRuleTransform(
			rule({ ruleType: "composite", operator: "OR", conditions: JSON.stringify(conditions) }),
		);
		expect(update).toEqual({ id: "r1", data: { enabled: false } });
		expect(change).toMatchObject({
			reason: "tautulli-orphaned",
			droppedConditionKinds: ["tautulli_last_watched", "tautulli_watch_count"],
		});
	});

	it("leaves unrelated rules untouched", () => {
		const { update, change } = planRuleTransform(
			rule({
				ruleType: "composite",
				operator: "AND",
				conditions: JSON.stringify([
					{ ruleType: "plex_last_watched", parameters: { operator: "older_than", days: 14 } },
				]),
			}),
		);
		expect(update).toBeNull();
		expect(change).toBeNull();
	});

	it("disables a rule whose params select tautulli as watch source (flag-everything guard)", () => {
		// user_retention with source:"tautulli" + watched_by_none would match
		// the ENTIRE library once the tautulli watch map is gone — must be
		// disabled like the tautulli_* kinds, not left to degrade.
		const { update, change } = planRuleTransform(
			rule({
				ruleType: "user_retention",
				parameters: JSON.stringify({ operator: "watched_by_none", source: "tautulli" }),
			}),
		);
		expect(update).toEqual({ id: "r1", data: { enabled: false } });
		expect(change).toMatchObject({ reason: "tautulli-orphaned" });
	});

	it("leaves source:'either' rules active (Plex still feeds them)", () => {
		const { update, change } = planRuleTransform(
			rule({
				ruleType: "user_retention",
				parameters: JSON.stringify({ operator: "watched_by_none", source: "either" }),
			}),
		);
		expect(update).toBeNull();
		expect(change).toBeNull();
	});

	it("drops a tautulli-sourced condition from a composite (object params)", () => {
		const conditions = [
			{
				ruleType: "user_retention",
				parameters: { operator: "watched_by_none", source: "tautulli" },
			},
			{ ruleType: "age", parameters: { field: "arrAddedAt", operator: "older_than", days: 30 } },
		];
		const { update, change } = planRuleTransform(
			rule({ ruleType: "composite", operator: "AND", conditions: JSON.stringify(conditions) }),
		);
		expect(JSON.parse(update?.data.conditions ?? "[]")).toHaveLength(1);
		expect(change).toMatchObject({ reason: "tautulli-condition-dropped" });
	});

	it("reports unparseable condition JSON without planning an update", () => {
		const { update, change } = planRuleTransform(
			rule({ ruleType: "composite", operator: "AND", conditions: "not-json{{{" }),
		);
		expect(update).toBeNull();
		expect(change).toMatchObject({ reason: "unparseable" });
	});
});

describe("runTautulliRulesPass", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(path.join(tmpdir(), "tautulli-pass-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	function makePrisma(cleanupRules: unknown[], autoTagRules: unknown[]) {
		const updates: Array<{ table: string; id: string; data: unknown }> = [];
		const prisma = {
			libraryCleanupRule: {
				findMany: vi.fn().mockResolvedValue(cleanupRules),
				update: vi.fn((args: { where: { id: string }; data: unknown }) => ({
					__op: { table: "cleanup", id: args.where.id, data: args.data },
				})),
			},
			autoTagRule: {
				findMany: vi.fn().mockResolvedValue(autoTagRules),
				update: vi.fn((args: { where: { id: string }; data: unknown }) => ({
					__op: { table: "auto-tag", id: args.where.id, data: args.data },
				})),
			},
			$transaction: vi.fn(
				async (ops: Array<{ __op: { table: string; id: string; data: unknown } }>) => {
					for (const op of ops) updates.push(op.__op);
					return ops;
				},
			),
		} as unknown as PrismaClient;
		return { prisma, updates };
	}

	it("backs up, transforms transactionally, writes the report, and the report round-trips", async () => {
		const cleanupRules = [
			rule({ id: "c1", name: "Watched ages ago", ruleType: "tautulli_last_watched" }),
			rule({ id: "c2", name: "Plain age rule" }),
		];
		const autoTagRules = [
			rule({
				id: "a1",
				name: "Tag watched-by",
				ruleType: "composite",
				operator: "AND",
				conditions: JSON.stringify([
					{ ruleType: "tautulli_watched_by", parameters: { userNames: ["x"] } },
					{ ruleType: "genre", parameters: { operator: "includes_any", genres: ["anime"] } },
				]),
			}),
		];
		const { prisma, updates } = makePrisma(cleanupRules, autoTagRules);

		const report = await runTautulliRulesPass(prisma, dataDir, silentLog);

		// Transform: c1 disabled; a1 conditions filtered
		expect(updates).toHaveLength(2);
		expect(updates[0]).toMatchObject({ table: "cleanup", id: "c1", data: { enabled: false } });
		expect(updates[1]?.table).toBe("auto-tag");

		// Backups contain the ORIGINAL rows
		const backedUp = JSON.parse(
			await readFile(path.join(dataDir, "rules-pre-3.0", "library-cleanup.json"), "utf-8"),
		);
		expect(backedUp).toHaveLength(2);
		expect(backedUp[0].enabled).toBe(true); // pre-transform state preserved

		// Report shape + disclosure counts
		expect(report?.totalAffectedRules).toBe(2);
		expect(report?.surfaces["library-cleanup"].rulesDisabled).toHaveLength(1);
		expect(report?.surfaces["auto-tag"].rulesModified).toHaveLength(1);

		// Round-trip via the reader the dialog will use
		const persisted = await readTautulliPassReport(dataDir);
		expect(persisted?.totalAffectedRules).toBe(2);
	});

	it("is a no-op when no tautulli kinds exist — touches neither backup nor report", async () => {
		const { prisma, updates } = makePrisma([rule({ id: "c1" })], []);

		const report = await runTautulliRulesPass(prisma, dataDir, silentLog);

		expect(report).toBeNull();
		expect(updates).toHaveLength(0);
		await expect(
			readFile(path.join(dataDir, "rules-pre-3.0", TAUTULLI_PASS_REPORT_FILE), "utf-8"),
		).rejects.toThrow();
	});

	it("re-run preserves prior disclosure — merge, never clobber (review finding)", async () => {
		// Run 1: a tautulli rule gets disabled, report records it.
		const { prisma: p1 } = makePrisma(
			[rule({ id: "c1", name: "Watched ages ago", ruleType: "tautulli_last_watched" })],
			[],
		);
		await runTautulliRulesPass(p1, dataDir, silentLog);

		// Run 2 (e.g. next boot): c1 is now disabled (plans no change), but a
		// lingering unparseable rule keeps the pass from early-returning.
		// Without the merge this rewrite would erase c1's disclosure.
		const { prisma: p2 } = makePrisma(
			[
				rule({
					id: "c1",
					name: "Watched ages ago",
					ruleType: "tautulli_last_watched",
					enabled: false,
				}),
				rule({
					id: "c9",
					name: "Corrupt",
					ruleType: "composite",
					operator: "AND",
					conditions: "not-json{{{",
				}),
			],
			[],
		);
		const report = await runTautulliRulesPass(p2, dataDir, silentLog);

		expect(report?.surfaces["library-cleanup"].rulesDisabled).toHaveLength(1);
		expect(report?.surfaces["library-cleanup"].rulesDisabled[0]?.id).toBe("c1");
		expect(report?.surfaces["library-cleanup"].rulesUnparseable[0]?.id).toBe("c9");
	});

	it("writes the report BEFORE transactions — a transaction failure cannot lose disclosure", async () => {
		const { prisma } = makePrisma(
			[rule({ id: "c1", name: "Watched ages ago", ruleType: "tautulli_last_watched" })],
			[],
		);
		(prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("SQLITE_BUSY: database is locked"),
		);

		await expect(runTautulliRulesPass(prisma, dataDir, silentLog)).rejects.toThrow("SQLITE_BUSY");

		// The disclosure survived the failed run.
		const persisted = await readTautulliPassReport(dataDir);
		expect(persisted?.surfaces["library-cleanup"].rulesDisabled[0]?.id).toBe("c1");
	});

	it("acknowledge round-trip: stamps acknowledgedAt, preserved across re-runs", async () => {
		const { prisma } = makePrisma([rule({ id: "c1", ruleType: "tautulli_last_watched" })], []);
		await runTautulliRulesPass(prisma, dataDir, silentLog);

		await acknowledgeTautulliPassReport(dataDir, silentLog);
		const acked = await readTautulliPassReport(dataDir);
		expect(typeof acked?.acknowledgedAt).toBe("string");

		// A later run with a lingering unparseable rule must not strip the stamp.
		const { prisma: p2 } = makePrisma(
			[
				rule({ id: "c1", ruleType: "tautulli_last_watched", enabled: false }),
				rule({ id: "c9", ruleType: "composite", operator: "AND", conditions: "not-json{{{" }),
			],
			[],
		);
		await runTautulliRulesPass(p2, dataDir, silentLog);
		const after = await readTautulliPassReport(dataDir);
		expect(after?.acknowledgedAt).toBe(acked?.acknowledgedAt);
	});

	it("acknowledge is a no-op when no report exists", async () => {
		await expect(acknowledgeTautulliPassReport(dataDir, silentLog)).resolves.toBeUndefined();
		expect(await readTautulliPassReport(dataDir)).toBeNull();
	});

	it("first-write-wins: a re-run never clobbers the original backup", async () => {
		const backupDir = path.join(dataDir, "rules-pre-3.0");
		await rm(backupDir, { recursive: true, force: true });
		// Seed a pre-existing backup (as if a prior partial run wrote it)
		const { mkdir } = await import("node:fs/promises");
		await mkdir(backupDir, { recursive: true });
		await writeFile(
			path.join(backupDir, "library-cleanup.json"),
			JSON.stringify([{ marker: "true-original" }]),
			"utf-8",
		);

		const { prisma } = makePrisma([rule({ id: "c1", ruleType: "tautulli_watch_count" })], []);
		await runTautulliRulesPass(prisma, dataDir, silentLog);

		const preserved = JSON.parse(
			await readFile(path.join(backupDir, "library-cleanup.json"), "utf-8"),
		);
		expect(preserved).toEqual([{ marker: "true-original" }]); // untouched
	});
});
