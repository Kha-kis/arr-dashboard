/**
 * `field_match` — notifications' condition style as one kind in the
 * unified vocabulary (docs/design/unified-rule-grammar.md §2.1).
 *
 * Operator semantics are the notification engine's EXACT 2.x behavior
 * and must not be "harmonized" (§1.3.5):
 *   - `equals` / `not_equals` are case-SENSITIVE
 *   - `contains` is case-INsensitive
 *   - `greater_than` compares numerically after Number() coercion
 *   - `in` matches against a string array
 *   - a missing field coerces via String(undefined) → the literal
 *     "undefined" (documented sharp edge, §5.2 — preserved and
 *     parity-tested; fixing it is a future document-version bump)
 */

import { z } from "zod";

export const FIELD_MATCH_KIND = "field_match";

export const fieldMatchOperatorSchema = z.enum([
	"equals",
	"not_equals",
	"contains",
	"greater_than",
	"in",
]);
export type FieldMatchOperator = z.infer<typeof fieldMatchOperatorSchema>;

/** Well-known top-level payload fields; metadata.* is open-ended (§5.2). */
export const fieldMatchFieldSchema = z
	.string()
	.min(1)
	.refine((f) => f === "eventType" || f === "title" || f === "body" || f.startsWith("metadata."), {
		message: "Field must be eventType, title, body, or metadata.<key>",
	});

export const fieldMatchParamsSchema = z.object({
	field: fieldMatchFieldSchema,
	operator: fieldMatchOperatorSchema,
	value: z.union([z.string(), z.number(), z.array(z.string())]),
});
export type FieldMatchParams = z.infer<typeof fieldMatchParamsSchema>;
