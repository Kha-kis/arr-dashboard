/**
 * Automation rule aggregation — the composer's read surface (charter §5.1).
 *
 * Loads every domain's stored rules (owned by `userId`) and normalizes each to
 * the v1 grammar so the API serves only v1 and the frontend carries zero legacy
 * knowledge. All v0→v1 conversion is delegated to the existing mappers — the
 * SAME ones the live evaluators use (`cleanup-adapter`), so the viewer shows
 * exactly what the engine evaluates.
 *
 * Surfaces with user-authored rule documents: library-cleanup, auto-tag,
 * notifications. Queue-cleaner and hunting register as contexts but have no
 * user-authored documents (empty kind sets), so they contribute nothing here.
 *
 * Robustness mirrors the engine's discipline: a structurally unparseable row is
 * surfaced honestly (`unparseable: true`, `document: null`) rather than dropped
 * or 500'd — the operator sees the rule exists and needs attention.
 */

import type { AutomationRuleSummary, RuleContextId, RuleDocument } from "@arr/shared";
import { CONTEXT_KINDS } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import { listUnavailableKinds, normalizeDocument } from "../rules/engine.js";
import { mapCriteriaV0ToDocument, mapNotificationsV0ToDocument } from "../rules/v0-mappers.js";

/** Fields both criteria tables (library-cleanup, auto-tag) share. */
const criteriaSelect = {
	id: true,
	name: true,
	enabled: true,
	ruleType: true,
	parameters: true,
	operator: true,
	conditions: true,
} as const;

interface RuleBase {
	id: string;
	name: string;
	enabled: boolean;
}

/**
 * Build a summary by running `build()` (the v0→v1 mapper) under the context's
 * legal-kind set. A throw from the mapper (or JSON.parse) → unparseable.
 */
function summarize(
	context: RuleContextId,
	base: RuleBase,
	build: () => RuleDocument,
	log: FastifyBaseLogger,
): AutomationRuleSummary {
	const legalKinds = CONTEXT_KINDS[context];
	try {
		const doc = build();
		return {
			id: base.id,
			name: base.name,
			enabled: base.enabled,
			context,
			document: normalizeDocument(doc, legalKinds),
			unavailableKinds: listUnavailableKinds(doc, legalKinds),
			unparseable: false,
		};
	} catch (err) {
		// The `unparseable` flag is the operator-facing signal; log the
		// underlying error too so "why is this rule broken?" is diagnosable
		// server-side (the row is surfaced, never silently dropped).
		log.warn({ err, ruleId: base.id, context }, "automation: rule could not be parsed to v1");
		return {
			id: base.id,
			name: base.name,
			enabled: base.enabled,
			context,
			document: null,
			unavailableKinds: [],
			unparseable: true,
		};
	}
}

export async function collectAutomationRules(
	prisma: PrismaClient,
	userId: string,
	log: FastifyBaseLogger,
): Promise<AutomationRuleSummary[]> {
	const [cleanupRules, autoTagRules, notificationRules, crossDomainRules] = await Promise.all([
		// Cleanup rules are owned through their config (no direct userId column).
		prisma.libraryCleanupRule.findMany({
			where: { config: { userId } },
			select: criteriaSelect,
			orderBy: { name: "asc" },
		}),
		prisma.autoTagRule.findMany({
			where: { userId },
			select: criteriaSelect,
			orderBy: { name: "asc" },
		}),
		prisma.notificationRule.findMany({
			where: { userId },
			select: { id: true, name: true, enabled: true, conditions: true },
			orderBy: { name: "asc" },
		}),
		prisma.crossDomainRule.findMany({
			where: { userId },
			select: { id: true, name: true, deployedAt: true, document: true },
			orderBy: { name: "asc" },
		}),
	]);

	const summaries: AutomationRuleSummary[] = [];

	for (const r of cleanupRules) {
		summaries.push(summarize("library-cleanup", r, () => mapCriteriaV0ToDocument(r), log));
	}
	for (const r of autoTagRules) {
		summaries.push(summarize("auto-tag", r, () => mapCriteriaV0ToDocument(r), log));
	}
	for (const r of notificationRules) {
		// conditions is a JSON array string; JSON.parse may throw → unparseable.
		summaries.push(
			summarize(
				"notifications",
				r,
				() => mapNotificationsV0ToDocument(JSON.parse(r.conditions)),
				log,
			),
		);
	}
	for (const r of crossDomainRules) {
		summaries.push(
			summarize(
				"cross-domain",
				{ id: r.id, name: r.name, enabled: r.deployedAt !== null },
				() => JSON.parse(r.document) as RuleDocument,
				log,
			),
		);
	}

	return summaries;
}
