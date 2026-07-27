import { z } from "zod";
import { ruleDocumentSchema } from "../rules/grammar.js";

export const crossDomainRuleScopeSchema = z.object({
	serviceTypes: z.array(z.enum(["SONARR", "RADARR"])).default([]),
	instanceIds: z.array(z.string().min(1)).default([]),
});
export type CrossDomainRuleScope = z.infer<typeof crossDomainRuleScopeSchema>;

export const crossDomainActionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("apply_tag"), tagName: z.string().trim().min(1).max(100) }),
	z.object({ type: z.literal("send_notification") }),
	z.object({ type: z.literal("exempt_cleanup") }),
]);
export type CrossDomainAction = z.infer<typeof crossDomainActionSchema>;

export const crossDomainActionsSchema = z
	.array(crossDomainActionSchema)
	.min(2, "Choose at least two actions")
	.max(3)
	.superRefine((actions, ctx) => {
		const types = actions.map((action) => action.type);
		if (new Set(types).size !== types.length) {
			ctx.addIssue({ code: "custom", message: "Each action type can be selected only once" });
		}
	});

export const crossDomainRuleDraftSchema = z.object({
	name: z.string().trim().min(1).max(100),
	document: ruleDocumentSchema,
	scope: crossDomainRuleScopeSchema.default({ serviceTypes: [], instanceIds: [] }),
	actions: crossDomainActionsSchema,
});
export type CrossDomainRuleDraft = z.infer<typeof crossDomainRuleDraftSchema>;

export const crossDomainRuleSchema = crossDomainRuleDraftSchema.extend({
	id: z.string(),
	active: z.boolean(),
	deploymentVersion: z.number().int().nonnegative(),
	deployedAt: z.string().datetime().nullable(),
	hasDraftChanges: z.boolean(),
	lastRunAt: z.string().datetime().nullable(),
	lastRunStatus: z.enum(["success", "partial", "failed"]).nullable(),
	lastRunMessage: z.string().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type CrossDomainRule = z.infer<typeof crossDomainRuleSchema>;

export const crossDomainRulesResponseSchema = z.object({
	rules: z.array(crossDomainRuleSchema),
});
export type CrossDomainRulesResponse = z.infer<typeof crossDomainRulesResponseSchema>;

export const crossDomainRuleResponseSchema = z.object({ rule: crossDomainRuleSchema });
export type CrossDomainRuleResponse = z.infer<typeof crossDomainRuleResponseSchema>;

export const crossDomainDryRunMatchSchema = z.object({
	instanceId: z.string(),
	instanceName: z.string(),
	arrItemId: z.number().int(),
	itemType: z.enum(["movie", "series"]),
	title: z.string(),
	year: z.number().int().nullable(),
	reason: z.string(),
	alreadyProcessed: z.boolean(),
});

export const crossDomainDryRunResponseSchema = z.object({
	itemsEvaluated: z.number().int().nonnegative(),
	itemsMatched: z.number().int().nonnegative(),
	matches: z.array(crossDomainDryRunMatchSchema),
	truncated: z.boolean(),
	actions: z.array(crossDomainActionSchema),
});
export type CrossDomainDryRunResponse = z.infer<typeof crossDomainDryRunResponseSchema>;
