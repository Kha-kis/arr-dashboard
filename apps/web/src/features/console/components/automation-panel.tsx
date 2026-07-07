"use client";

/**
 * Operator Console — Automation tab (cross-domain rule composer).
 *
 * The unified rule surface (charter §2.1 / §5.2): every domain's rules in one
 * place, normalized to v1 and rendered with {@link RuleDocumentView}. Authoring
 * lands in slices by context — library-cleanup first (create + edit via the
 * down-convert write path, PR-3b). Auto-tag and notifications authoring follow.
 *
 * Incognito: rule NAMES stay visible (ratified 2026-07-07 — consistent with the
 * rest of the app; usable in a screenshare); sensitive param VALUES are masked
 * inside RuleDocumentView. Retired kinds badge as unavailable; an unparseable
 * stored rule is shown honestly and is NOT offered for composer edit (it routes
 * to its own surface to repair).
 */

import type { AutomationRuleSummary, RuleContextId } from "@arr/shared";
import { AlertTriangle, Pencil, Plus, Workflow } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { AsyncStateView, GlassmorphicCard } from "../../../components/layout";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import { useAutomationRules } from "../../../hooks/api/useAutomation";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { RuleDocumentView } from "./rule-document-view";

const CleanupRuleComposerDialog = lazy(() =>
	import("./cleanup-rule-composer-dialog").then((m) => ({
		default: m.CleanupRuleComposerDialog,
	})),
);

const AutoTagRuleComposerDialog = lazy(() =>
	import("./auto-tag-rule-composer-dialog").then((m) => ({
		default: m.AutoTagRuleComposerDialog,
	})),
);

/** Contexts this composer can author (grows as slices land). */
type AuthorableContext = "library-cleanup" | "auto-tag";

const CONTEXT_LABELS: Record<RuleContextId, string> = {
	"library-cleanup": "Library Cleanup",
	"auto-tag": "Auto-Tag",
	notifications: "Notifications",
	"queue-cleaner": "Queue Cleaner",
	hunting: "Hunting",
};

// Display order — the three surfaces with user-authored documents first.
const CONTEXT_ORDER: RuleContextId[] = [
	"library-cleanup",
	"auto-tag",
	"notifications",
	"queue-cleaner",
	"hunting",
];

function EnabledBadge({ enabled }: { enabled: boolean }) {
	const tone = enabled ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.neutral;
	return (
		<span
			className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium"
			style={{ backgroundColor: tone.bg, color: tone.text, border: `1px solid ${tone.border}` }}
		>
			{enabled ? "Enabled" : "Disabled"}
		</span>
	);
}

function RuleCard({
	rule,
	incognito,
	onEdit,
}: {
	rule: AutomationRuleSummary;
	incognito: boolean;
	/** Provided only for rules this slice can author (parseable cleanup rules). */
	onEdit?: () => void;
}) {
	// Keyed on `document` (not a derived `broken` const) so the else branch
	// narrows document to non-null for RuleDocumentView.
	const document = rule.unparseable ? null : rule.document;
	return (
		<GlassmorphicCard className="space-y-2 p-4">
			<div className="flex items-start justify-between gap-2">
				{/* Rule name = the operator's own label; shown even in incognito so the
				    viewer stays usable. Sensitive values live in the params, masked below. */}
				<span className="font-medium text-foreground">{rule.name}</span>
				<div className="flex shrink-0 items-center gap-2">
					{onEdit && document && (
						<button
							type="button"
							onClick={onEdit}
							className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
							aria-label={`Edit ${rule.name}`}
						>
							<Pencil className="h-3 w-3" aria-hidden="true" />
							Edit
						</button>
					)}
					<EnabledBadge enabled={rule.enabled} />
				</div>
			</div>
			{document ? (
				<RuleDocumentView document={document} context={rule.context} incognito={incognito} />
			) : (
				<p
					className="flex items-center gap-1.5 text-sm"
					style={{ color: SEMANTIC_COLORS.warning.text }}
				>
					<AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					This rule could not be read from its stored definition — open its surface to repair it.
				</p>
			)}
		</GlassmorphicCard>
	);
}

export function AutomationPanel() {
	const { data, isLoading, isError, error, refetch } = useAutomationRules();
	const [incognito] = useIncognitoMode();
	// { open, editRuleId } — editRuleId null = create mode.
	// context selects which per-domain composer dialog opens; editRuleId null = create.
	const [composer, setComposer] = useState<{
		open: boolean;
		context: AuthorableContext;
		editRuleId: string | null;
	}>({ open: false, context: "library-cleanup", editRuleId: null });

	const rules = data?.rules ?? [];
	const groups = CONTEXT_ORDER.map((context) => ({
		context,
		rules: rules.filter((rule) => rule.context === context),
	})).filter((group) => group.rules.length > 0);

	const openCreate = (context: AuthorableContext) =>
		setComposer({ open: true, context, editRuleId: null });
	const openEdit = (context: AuthorableContext, id: string) =>
		setComposer({ open: true, context, editRuleId: id });

	// Only these contexts have a composer authoring dialog in this slice.
	const editableContext = (context: RuleContextId): AuthorableContext | null =>
		context === "library-cleanup" || context === "auto-tag" ? context : null;

	return (
		<div className="space-y-4">
			{/* Authoring entry points — one per composer-capable context (grows as
			    notifications lands). */}
			<div className="flex flex-wrap items-center justify-end gap-2">
				<button
					type="button"
					onClick={() => openCreate("library-cleanup")}
					className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5 text-sm font-medium backdrop-blur-xs transition-colors hover:bg-card/80"
				>
					<Plus className="h-4 w-4" aria-hidden="true" />
					New cleanup rule
				</button>
				<button
					type="button"
					onClick={() => openCreate("auto-tag")}
					className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5 text-sm font-medium backdrop-blur-xs transition-colors hover:bg-card/80"
				>
					<Plus className="h-4 w-4" aria-hidden="true" />
					New auto-tag rule
				</button>
			</div>

			<AsyncStateView
				isLoading={isLoading}
				isError={isError}
				error={error}
				isEmpty={rules.length === 0}
				onRetry={() => void refetch()}
				errorTitle="Couldn't load automation rules"
				emptyState={{
					icon: Workflow,
					title: "No automation rules yet",
					description:
						"Create a cleanup or auto-tag rule here, or add notification rules — they all appear here, unified.",
				}}
			>
				<div className="space-y-6">
					{groups.map((group) => (
						<section key={group.context} className="space-y-2">
							<h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
								{CONTEXT_LABELS[group.context]}
								<span className="rounded-full bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">
									{group.rules.length}
								</span>
							</h3>
							<div className="space-y-3">
								{group.rules.map((rule) => (
									<RuleCard
										key={`${rule.context}-${rule.id}`}
										rule={rule}
										incognito={incognito}
										onEdit={(() => {
											// Composer-editable only for contexts with an authoring dialog
											// AND rules whose kinds are ALL still available. A rule with a
											// retired kind (unavailableKinds non-empty) is parseable but the
											// composer's kind picker can't represent it — editing would be a
											// dead-end (picker shows a wrong kind, save is blocked). Route
											// those to the domain surface to repair instead.
											const ctx = editableContext(rule.context);
											return ctx && rule.unavailableKinds.length === 0
												? () => openEdit(ctx, rule.id)
												: undefined;
										})()}
									/>
								))}
							</div>
						</section>
					))}
				</div>
			</AsyncStateView>

			{composer.open && (
				<Suspense>
					{composer.context === "library-cleanup" ? (
						<CleanupRuleComposerDialog
							open={composer.open}
							onOpenChange={(open) => setComposer((prev) => ({ ...prev, open }))}
							editRuleId={composer.editRuleId}
						/>
					) : (
						<AutoTagRuleComposerDialog
							open={composer.open}
							onOpenChange={(open) => setComposer((prev) => ({ ...prev, open }))}
							editRuleId={composer.editRuleId}
						/>
					)}
				</Suspense>
			)}
		</div>
	);
}
