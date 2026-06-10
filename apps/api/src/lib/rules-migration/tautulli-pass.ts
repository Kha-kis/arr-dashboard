/**
 * Tautulli rules pass — the one semantic stored-rule migration in 3.0.
 *
 * ADR-0006 amendment 2 / ADR-0007 / docs/design/unified-rule-grammar.md §3.1.
 *
 * Tautulli support is removed in 3.0, which orphans the three
 * Tautulli-typed condition kinds (`tautulli_last_watched`,
 * `tautulli_watch_count`, `tautulli_watched_by`) stored in
 * LibraryCleanupRule and AutoTagRule documents. This pass runs once at
 * first 3.0 boot, under the ADR-0006 5-point contract:
 *
 *   1. Backup before mutation — original rows are written to
 *      `<dataDir>/rules-pre-3.0/<surface>.json` (first-write-wins so a
 *      re-run can never clobber true originals).
 *   2. Transactional per surface — all-or-nothing.
 *   3. Report — `<dataDir>/rules-pre-3.0/tautulli-pass-report.json`
 *      records every disabled/modified rule; the A2 migration dialog
 *      reads it for its disclosure ("N of your rules referenced
 *      Tautulli watch data").
 *   4. Rollback — restore the backup files + downgrade tag (documented
 *      in CHANGELOG).
 *   5. Idempotent — a second run finds no Tautulli kinds and exits
 *      without touching backup or report.
 *
 * Transform semantics (design doc §3.1):
 *   - Single rule whose ruleType is a Tautulli kind → rule DISABLED
 *     (never deleted), reported as `tautulli-orphaned`. Its document is
 *     left intact for the user to repurpose.
 *   - Composite rule (operator + conditions[]): Tautulli conditions are
 *     REMOVED; if at least one condition remains the rule stays active
 *     (reported as `tautulli-condition-dropped`); if none remain the
 *     rule is DISABLED with its original conditions left in place
 *     (reported as `tautulli-orphaned`).
 *   - No silent `tautulli_*` → `plex_*` rewrites: different data
 *     sources; silent semantic swaps violate the trust thesis.
 *   - Unparseable condition JSON: rule left untouched, reported as
 *     `unparseable` (never throw the boot).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";

export const TAUTULLI_RULE_KINDS = new Set([
	"tautulli_last_watched",
	"tautulli_watch_count",
	"tautulli_watched_by",
]);

const BACKUP_DIR_NAME = "rules-pre-3.0";
export const TAUTULLI_PASS_REPORT_FILE = "tautulli-pass-report.json";

interface RuleRow {
	id: string;
	name: string;
	enabled: boolean;
	ruleType: string;
	parameters: string;
	operator: string | null;
	conditions: string | null;
}

interface RuleChange {
	id: string;
	name: string;
	reason: "tautulli-orphaned" | "tautulli-condition-dropped" | "unparseable";
	droppedConditionKinds?: string[];
}

export interface SurfaceReport {
	rulesScanned: number;
	rulesDisabled: RuleChange[];
	rulesModified: RuleChange[];
	rulesUnparseable: RuleChange[];
}

export interface TautulliPassReport {
	ranAt: string;
	surfaces: {
		"library-cleanup": SurfaceReport;
		"auto-tag": SurfaceReport;
	};
	totalAffectedRules: number;
}

interface PlannedUpdate {
	id: string;
	data: { enabled?: boolean; conditions?: string };
}

interface SurfacePlan {
	report: SurfaceReport;
	updates: PlannedUpdate[];
}

/**
 * True when a condition's params select Tautulli as the watch-data source
 * (e.g. user_retention's `source: "tautulli"`). Post-removal these rules
 * would see an always-empty watch set — for `watched_by_none` semantics
 * that means MATCHING THE ENTIRE LIBRARY, a destructive flip rather than
 * graceful degradation. They are disabled exactly like tautulli_* kinds.
 * (`source: "either"` is safe: Plex still feeds it.)
 */
function paramsSourceIsTautulli(rawParams: string | null | undefined): boolean {
	if (!rawParams) return false;
	try {
		const params = JSON.parse(rawParams) as { source?: unknown };
		return params?.source === "tautulli";
	} catch {
		return false; // unparseable params are surfaced via the conditions path
	}
}

/** Decide the transform for one rule. Pure — unit-testable without a DB. */
export function planRuleTransform(rule: RuleRow): {
	update: PlannedUpdate | null;
	change: RuleChange | null;
} {
	// Single-condition rule with a Tautulli kind OR Tautulli-sourced params
	// → disable, keep document.
	if (TAUTULLI_RULE_KINDS.has(rule.ruleType) || paramsSourceIsTautulli(rule.parameters)) {
		if (!rule.enabled) return { update: null, change: null }; // already inert (idempotency)
		return {
			update: { id: rule.id, data: { enabled: false } },
			change: { id: rule.id, name: rule.name, reason: "tautulli-orphaned" },
		};
	}

	// Composite rule: inspect conditions array.
	if (rule.operator && rule.conditions) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rule.conditions);
		} catch {
			return {
				update: null,
				change: { id: rule.id, name: rule.name, reason: "unparseable" },
			};
		}
		if (!Array.isArray(parsed)) {
			return {
				update: null,
				change: { id: rule.id, name: rule.name, reason: "unparseable" },
			};
		}

		const conditions = parsed as Array<{ ruleType?: unknown; parameters?: unknown }>;
		const isTautulliCondition = (c: { ruleType?: unknown; parameters?: unknown }): boolean =>
			(typeof c?.ruleType === "string" && TAUTULLI_RULE_KINDS.has(c.ruleType)) ||
			(c?.parameters !== undefined &&
				(c.parameters as { source?: unknown })?.source === "tautulli");
		const dropped = conditions.filter(isTautulliCondition);
		if (dropped.length === 0) return { update: null, change: null };

		const remaining = conditions.filter((c) => !isTautulliCondition(c));
		const droppedKinds = dropped.map((c) => String(c.ruleType));

		if (remaining.length === 0) {
			// Every condition was Tautulli-typed: disable, preserve original
			// conditions in-row (the backup also has them).
			if (!rule.enabled) return { update: null, change: null };
			return {
				update: { id: rule.id, data: { enabled: false } },
				change: {
					id: rule.id,
					name: rule.name,
					reason: "tautulli-orphaned",
					droppedConditionKinds: droppedKinds,
				},
			};
		}

		return {
			update: { id: rule.id, data: { conditions: JSON.stringify(remaining) } },
			change: {
				id: rule.id,
				name: rule.name,
				reason: "tautulli-condition-dropped",
				droppedConditionKinds: droppedKinds,
			},
		};
	}

	return { update: null, change: null };
}

function planSurface(rules: RuleRow[]): SurfacePlan {
	const report: SurfaceReport = {
		rulesScanned: rules.length,
		rulesDisabled: [],
		rulesModified: [],
		rulesUnparseable: [],
	};
	const updates: PlannedUpdate[] = [];

	for (const rule of rules) {
		const { update, change } = planRuleTransform(rule);
		if (update) updates.push(update);
		if (!change) continue;
		if (change.reason === "tautulli-orphaned") report.rulesDisabled.push(change);
		else if (change.reason === "tautulli-condition-dropped") report.rulesModified.push(change);
		else report.rulesUnparseable.push(change);
	}

	return { report, updates };
}

/** Write a backup file only if it does not already exist (first-write-wins). */
async function writeBackupOnce(filePath: string, rows: unknown[]): Promise<void> {
	try {
		await readFile(filePath);
		return; // existing backup preserved — true originals win
	} catch {
		// not present — write it
	}
	await writeFile(filePath, JSON.stringify(rows, null, 2), "utf-8");
}

/**
 * Run the pass. Safe to call on every boot — exits without side effects
 * when no Tautulli-typed conditions remain.
 */
export async function runTautulliRulesPass(
	prisma: PrismaClient,
	dataDir: string,
	log: FastifyBaseLogger,
): Promise<TautulliPassReport | null> {
	const ruleSelect = {
		id: true,
		name: true,
		enabled: true,
		ruleType: true,
		parameters: true,
		operator: true,
		conditions: true,
	} as const;

	const [cleanupRules, autoTagRules] = await Promise.all([
		prisma.libraryCleanupRule.findMany({ select: ruleSelect }),
		prisma.autoTagRule.findMany({ select: ruleSelect }),
	]);

	const cleanupPlan = planSurface(cleanupRules);
	const autoTagPlan = planSurface(autoTagRules);

	const totalAffected =
		cleanupPlan.updates.length +
		autoTagPlan.updates.length +
		cleanupPlan.report.rulesUnparseable.length +
		autoTagPlan.report.rulesUnparseable.length;

	if (totalAffected === 0) {
		log.debug("Tautulli rules pass: nothing to migrate");
		return null;
	}

	// 1. Backup (full surface snapshots, first-write-wins)
	const backupDir = path.join(dataDir, BACKUP_DIR_NAME);
	await mkdir(backupDir, { recursive: true });
	await writeBackupOnce(path.join(backupDir, "library-cleanup.json"), cleanupRules);
	await writeBackupOnce(path.join(backupDir, "auto-tag.json"), autoTagRules);

	// 2. Transactional transform, per surface
	if (cleanupPlan.updates.length > 0) {
		await prisma.$transaction(
			cleanupPlan.updates.map((u) =>
				prisma.libraryCleanupRule.update({ where: { id: u.id }, data: u.data }),
			),
		);
	}
	if (autoTagPlan.updates.length > 0) {
		await prisma.$transaction(
			autoTagPlan.updates.map((u) =>
				prisma.autoTagRule.update({ where: { id: u.id }, data: u.data }),
			),
		);
	}

	// 3. Report (clobber is fine here — latest run with changes is the
	// truthful one; no-op runs return above without touching it)
	const report: TautulliPassReport = {
		ranAt: new Date().toISOString(),
		surfaces: {
			"library-cleanup": cleanupPlan.report,
			"auto-tag": autoTagPlan.report,
		},
		totalAffectedRules: totalAffected,
	};
	await writeFile(
		path.join(backupDir, TAUTULLI_PASS_REPORT_FILE),
		JSON.stringify(report, null, 2),
		"utf-8",
	);

	log.info(
		{
			cleanupDisabled: cleanupPlan.report.rulesDisabled.length,
			cleanupModified: cleanupPlan.report.rulesModified.length,
			autoTagDisabled: autoTagPlan.report.rulesDisabled.length,
			autoTagModified: autoTagPlan.report.rulesModified.length,
			unparseable:
				cleanupPlan.report.rulesUnparseable.length + autoTagPlan.report.rulesUnparseable.length,
			backupDir,
		},
		"Tautulli rules pass complete — originals backed up, report written",
	);

	return report;
}

/** Read the persisted report (for the migration dialog's disclosure). */
export async function readTautulliPassReport(dataDir: string): Promise<TautulliPassReport | null> {
	try {
		const raw = await readFile(
			path.join(dataDir, BACKUP_DIR_NAME, TAUTULLI_PASS_REPORT_FILE),
			"utf-8",
		);
		return JSON.parse(raw) as TautulliPassReport;
	} catch {
		return null;
	}
}
