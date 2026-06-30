"use client";

/**
 * Read-only renderer for a v1 {@link RuleDocument} (charter §5.1 read surface).
 *
 * Walks the document tree with the grammar helpers and renders each predicate
 * as a humanized row. Depth is v1-limited to 1 (one group level), so the tree
 * is a root predicate OR a single all/any group of predicates.
 *
 * Empty-group honesty: the three domains' live evaluators disagree on an empty
 * group, so the annotation is context-aware — cleanup and auto-tag no-match an
 * empty composite (guard / unknown "composite" kind), while notifications
 * matches every event (vacuous-true is the real 2.x behavior).
 */

import type { RuleContextId, RuleDocument, RuleNode } from "@arr/shared";
import { groupChildren, isRulePredicate } from "@arr/shared";
import { AlertTriangle } from "lucide-react";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { describePredicate } from "../lib/describe-predicate";

function PredicateRow({
	node,
	incognito,
}: {
	node: Extract<RuleNode, { kind: string }>;
	incognito: boolean;
}) {
	const { label, summary } = describePredicate(node, incognito);
	const unavailable = node.unavailableKind === true;

	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/30 bg-card/20 px-3 py-1.5 text-sm">
			<span className="font-medium text-foreground">{label}</span>
			{summary && <span className="text-muted-foreground">{summary}</span>}
			{unavailable && (
				<span
					className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
					style={{
						backgroundColor: SEMANTIC_COLORS.warning.bg,
						color: SEMANTIC_COLORS.warning.text,
						border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
					}}
					title="This condition's kind is retired or unavailable — it no longer matches anything."
				>
					<AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
					unavailable
				</span>
			)}
		</div>
	);
}

function emptyGroupNote(context: RuleContextId): string {
	// Notifications' empty condition list matches every event (vacuous-true is
	// the live 2.x behavior). Cleanup and auto-tag both no-match an empty
	// composite (cleanup via its pre-eval guard, auto-tag via the unknown
	// "composite" kind). Other contexts don't author documents here.
	return context === "notifications"
		? "No conditions — matches every event."
		: "No conditions — this rule never matches.";
}

export function RuleDocumentView({
	document,
	context,
	incognito,
}: {
	document: RuleDocument;
	context: RuleContextId;
	incognito: boolean;
}) {
	const root = document.root;

	if (isRulePredicate(root)) {
		return <PredicateRow node={root} incognito={incognito} />;
	}

	const children = groupChildren(root);
	if (children.length === 0) {
		return <p className="text-sm italic text-muted-foreground">{emptyGroupNote(context)}</p>;
	}

	const joiner = "all" in root ? "All of" : "Any of";

	return (
		<div className="space-y-1.5">
			<span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
				{joiner}
			</span>
			<div className="space-y-1">
				{children.map((child, index) =>
					isRulePredicate(child) ? (
						// Stable enough: v1 depth-1 means children are a flat predicate
						// list rendered in document order.
						// biome-ignore lint/suspicious/noArrayIndexKey: predicates have no id; order is stable
						<PredicateRow key={index} node={child} incognito={incognito} />
					) : null,
				)}
			</div>
		</div>
	);
}
