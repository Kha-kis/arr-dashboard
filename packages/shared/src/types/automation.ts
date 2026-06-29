import { z } from "zod";
import { RULE_CONTEXT_IDS } from "../rules/contexts.js";
import { ruleDocumentSchema } from "../rules/grammar.js";

/**
 * Automation rule — read surface for the Operator Console composer.
 *
 * The composer reads every domain's stored rule normalized to the v1 grammar
 * (charter §5.1: "the API serves only v1"). Each domain's rows are parsed and
 * mapped to a {@link RuleDocument} server-side via the v0 mappers; the frontend
 * carries zero legacy knowledge. Retired / drifted kinds are annotated
 * (`unavailableKinds`) rather than dropped, and a rule whose stored shape can't
 * be parsed is surfaced honestly (`unparseable`) rather than hidden or 500'd.
 */
export const automationRuleSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	enabled: z.boolean(),
	/** Which engine surface owns the rule (its legal-kind context). */
	context: z.enum(RULE_CONTEXT_IDS),
	/** Normalized v1 document, or null when the stored rule is unparseable. */
	document: ruleDocumentSchema.nullable(),
	/**
	 * Kinds in the document not legal for the context — retired (`tautulli_*`)
	 * or vocabulary drift. The UI badges these; evaluation no-matches them.
	 */
	unavailableKinds: z.array(z.string()),
	/** The stored rule could not be parsed into a v1 document. */
	unparseable: z.boolean(),
});
export type AutomationRuleSummary = z.infer<typeof automationRuleSummarySchema>;

export const automationRulesResponseSchema = z.object({
	rules: z.array(automationRuleSummarySchema),
});
export type AutomationRulesResponse = z.infer<typeof automationRulesResponseSchema>;
