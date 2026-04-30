/**
 * Auto-Tagger — wire types.
 *
 * Auto-Tagger applies tags/labels to LibraryCache items matching a
 * criteria-based rule. Shares the criteria DSL with Library Cleanup
 * (rule types, conditions, composite operator) — the differences are
 * the action (apply tag vs. delete/unmonitor) and the absence of
 * cleanup-specific concerns (retentionMode, excludeTitles, …).
 *
 * Companion to the Label Sync feature: Auto-Tagger seeds tags on the
 * source service; Label Sync optionally propagates them to other
 * services. See `memory/auto-tagger-arc.md`.
 */

import { z } from "zod";
import { getRegexSafetyError, REGEX_MAX_LENGTH } from "./regex-safety.js";
import {
	type CompositeOperator,
	type Condition,
	compositeOperatorSchema,
	conditionSchema,
	type RuleType,
	ruleTypeSchema,
} from "./rule-criteria.js";

export type AutoTagRunStatus = "success" | "partial" | "failed";

// ============================================================================
// Wire shape (returned by GET /api/auto-tag/rules)
// ============================================================================

export interface AutoTagRule {
	id: string;
	userId: string;
	name: string;
	enabled: boolean;

	// Criteria DSL
	ruleType: RuleType;
	parameters: Record<string, unknown>;
	operator: CompositeOperator | null;
	conditions: Condition[] | null;

	// Scope filters
	serviceFilter: string[] | null;
	instanceFilter: string[] | null;
	excludeTags: number[] | null;
	excludeTitles: string[] | null;
	plexLibraryFilter: string[] | null;

	// Action
	tagName: string;

	// Run telemetry
	lastRunAt: string | null;
	lastRunStatus: AutoTagRunStatus | null;
	lastRunMessage: string | null;

	createdAt: string;
	updatedAt: string;
}

// ============================================================================
// Request schemas
// ============================================================================

const baseRuleSchema = z.object({
	name: z.string().trim().min(1).max(120),
	enabled: z.boolean().optional(),
	ruleType: ruleTypeSchema,
	parameters: z.record(z.string(), z.unknown()),
	operator: compositeOperatorSchema.nullable().optional(),
	conditions: z.array(conditionSchema).nullable().optional(),
	serviceFilter: z.array(z.string()).nullable().optional(),
	instanceFilter: z.array(z.string()).nullable().optional(),
	excludeTags: z.array(z.number()).nullable().optional(),
	excludeTitles: z
		.array(
			z
				.string()
				.max(REGEX_MAX_LENGTH)
				.refine((p) => getRegexSafetyError(p) === null, {
					message: "Invalid or unsafe regular expression pattern",
				}),
		)
		.nullable()
		.optional(),
	plexLibraryFilter: z.array(z.string()).nullable().optional(),
	tagName: z.string().trim().min(1).max(120),
});

export const createAutoTagRuleSchema = baseRuleSchema.superRefine((data, ctx) => {
	if (data.operator != null && (!data.conditions || data.conditions.length === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Composite rules must have at least one condition",
			path: ["conditions"],
		});
	}
});

export const updateAutoTagRuleSchema = baseRuleSchema.partial().superRefine((data, ctx) => {
	if (data.operator != null && (!data.conditions || data.conditions.length === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Composite rules must have at least one condition",
			path: ["conditions"],
		});
	}
});

export type CreateAutoTagRuleRequest = z.infer<typeof createAutoTagRuleSchema>;
export type UpdateAutoTagRuleRequest = z.infer<typeof updateAutoTagRuleSchema>;

// ============================================================================
// Response shapes
// ============================================================================

export interface AutoTagRulesResponse {
	rules: AutoTagRule[];
}

export interface AutoTagRuleResponse {
	rule: AutoTagRule;
}
