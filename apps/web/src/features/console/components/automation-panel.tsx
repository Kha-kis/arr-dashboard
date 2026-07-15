"use client";

/**
 * Operator Console — Automation tab (cross-domain rule composer).
 *
 * The unified rule surface (charter §2.1 / §5.2): every domain's rules in one
 * place, normalized to v1 and rendered with {@link RuleDocumentView}. Each
 * domain authors through its existing write path; cross-domain rules use the
 * draft, dry-run, and deployment lifecycle on this surface.
 *
 * Incognito: rule NAMES stay visible (ratified 2026-07-07 — consistent with the
 * rest of the app; usable in a screenshare); sensitive param VALUES are masked
 * inside RuleDocumentView. Retired kinds badge as unavailable; an unparseable
 * stored rule is shown honestly and is NOT offered for composer edit (it routes
 * to its own surface to repair).
 */

import type { AutomationRuleSummary, CrossDomainDryRunResponse, RuleContextId } from "@arr/shared";
import {
	AlertTriangle,
	FlaskConical,
	Loader2,
	Pencil,
	Plus,
	PowerOff,
	Rocket,
	Trash2,
	Workflow,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { AsyncStateView, GlassmorphicCard } from "../../../components/layout";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui/dialog";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import {
	useAutomationRules,
	useCrossDomainRules,
	useDeactivateCrossDomainRule,
	useDeleteCrossDomainRule,
	useDeployCrossDomainRule,
	useDryRunCrossDomainRule,
} from "../../../hooks/api/useAutomation";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName, getLinuxIsoName } from "../../../lib/incognito";
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

const NotificationRuleComposerDialog = lazy(() =>
	import("./notification-rule-composer-dialog").then((m) => ({
		default: m.NotificationRuleComposerDialog,
	})),
);

const CrossDomainRuleComposerDialog = lazy(() =>
	import("./cross-domain-rule-composer-dialog").then((m) => ({
		default: m.CrossDomainRuleComposerDialog,
	})),
);

/** Contexts this composer can author (grows as slices land). */
type AuthorableContext = "library-cleanup" | "auto-tag" | "notifications" | "cross-domain";

const CONTEXT_LABELS: Record<RuleContextId, string> = {
	"library-cleanup": "Library Cleanup",
	"auto-tag": "Auto-Tag",
	notifications: "Notifications",
	"cross-domain": "Cross-Domain",
	"queue-cleaner": "Queue Cleaner",
	hunting: "Hunting",
};

// Display order — the three surfaces with user-authored documents first.
const CONTEXT_ORDER: RuleContextId[] = [
	"library-cleanup",
	"auto-tag",
	"notifications",
	"cross-domain",
	"queue-cleaner",
	"hunting",
];

function EnabledBadge({ enabled, label }: { enabled: boolean; label?: string }) {
	const tone = enabled ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.neutral;
	return (
		<span
			className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium"
			style={{ backgroundColor: tone.bg, color: tone.text, border: `1px solid ${tone.border}` }}
		>
			{label ?? (enabled ? "Enabled" : "Disabled")}
		</span>
	);
}

function RuleCard({
	rule,
	incognito,
	onEdit,
	cardActions,
	statusLabel,
	footer,
}: {
	rule: AutomationRuleSummary;
	incognito: boolean;
	/** Provided only for parseable rules whose context this composer can author. */
	onEdit?: () => void;
	cardActions?: ReactNode;
	statusLabel?: "Draft" | "Active";
	footer?: ReactNode;
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
					{cardActions}
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
					{statusLabel ? (
						<EnabledBadge enabled={statusLabel === "Active"} label={statusLabel} />
					) : (
						<EnabledBadge enabled={rule.enabled} />
					)}
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
			{footer}
		</GlassmorphicCard>
	);
}

export function AutomationPanel() {
	const { data, isLoading, isError, error, refetch } = useAutomationRules();
	const [incognito] = useIncognitoMode();
	const { data: crossDomainData } = useCrossDomainRules();
	const dryRun = useDryRunCrossDomainRule();
	const deploy = useDeployCrossDomainRule();
	const deactivate = useDeactivateCrossDomainRule();
	const deleteRule = useDeleteCrossDomainRule();
	const [preview, setPreview] = useState<{
		ruleId: string;
		ruleName: string;
		data: CrossDomainDryRunResponse;
	} | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
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

	const openCreate = (context: AuthorableContext) => {
		setPreview(null);
		setComposer({ open: true, context, editRuleId: null });
	};
	const openEdit = (context: AuthorableContext, id: string) => {
		setPreview(null);
		setComposer({ open: true, context, editRuleId: id });
	};

	// Only these contexts have a composer authoring dialog in this slice.
	const editableContext = (context: RuleContextId): AuthorableContext | null =>
		context === "library-cleanup" ||
		context === "auto-tag" ||
		context === "notifications" ||
		context === "cross-domain"
			? context
			: null;

	return (
		<div className="space-y-4">
			{actionError && (
				<div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
					{actionError}
				</div>
			)}
			{/* Authoring entry points — one per composer-capable context (grows as
			    notifications lands). */}
			<div className="flex flex-wrap items-center justify-end gap-2">
				<button
					type="button"
					onClick={() => openCreate("cross-domain")}
					className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5 text-sm font-medium backdrop-blur-xs transition-colors hover:bg-card/80"
				>
					<Plus className="h-4 w-4" aria-hidden="true" />
					New cross-domain rule
				</button>
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
				<button
					type="button"
					onClick={() => openCreate("notifications")}
					className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5 text-sm font-medium backdrop-blur-xs transition-colors hover:bg-card/80"
				>
					<Plus className="h-4 w-4" aria-hidden="true" />
					New notification rule
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
						"Create cleanup, auto-tag, and notification rules here — they all appear in one unified view.",
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
										cardActions={
											rule.context === "cross-domain"
												? (() => {
														const detail = crossDomainData?.rules.find(
															(candidate) => candidate.id === rule.id,
														);
														if (!detail) return null;
														return (
															<>
																{detail.hasDraftChanges && (
																	<span className="text-[11px] text-muted-foreground">
																		Draft changes
																	</span>
																)}
																<button
																	type="button"
																	disabled={dryRun.isPending}
																	onClick={async () => {
																		setActionError(null);
																		try {
																			const result = await dryRun.mutateAsync(rule.id);
																			setPreview({
																				ruleId: rule.id,
																				ruleName: rule.name,
																				data: result,
																			});
																		} catch (error) {
																			setActionError(
																				getErrorMessage(error, "Could not preview the rule."),
																			);
																		}
																	}}
																	className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
																>
																	{dryRun.isPending && dryRun.variables === rule.id ? (
																		<Loader2 className="h-3 w-3 animate-spin" />
																	) : (
																		<FlaskConical className="h-3 w-3" />
																	)}{" "}
																	Dry run
																</button>
																<button
																	type="button"
																	disabled={deploy.isPending || preview?.ruleId !== rule.id}
																	title={
																		preview?.ruleId === rule.id
																			? "Deploy this previewed draft"
																			: "Dry-run this draft first"
																	}
																	onClick={async () => {
																		setActionError(null);
																		try {
																			await deploy.mutateAsync(rule.id);
																			setPreview(null);
																		} catch (error) {
																			setActionError(
																				getErrorMessage(error, "Could not deploy the rule."),
																			);
																		}
																	}}
																	className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
																>
																	<Rocket className="h-3 w-3" /> Deploy
																</button>
																{detail.active && (
																	<button
																		type="button"
																		disabled={deactivate.isPending}
																		onClick={async () => {
																			if (
																				!window.confirm(
																					`Deactivate ${rule.name}? The saved draft will be kept.`,
																				)
																			)
																				return;
																			try {
																				await deactivate.mutateAsync(rule.id);
																				setPreview(null);
																			} catch (error) {
																				setActionError(
																					getErrorMessage(error, "Could not deactivate the rule."),
																				);
																			}
																		}}
																		className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
																	>
																		<PowerOff className="h-3 w-3" /> Deactivate
																	</button>
																)}
																<button
																	type="button"
																	disabled={deleteRule.isPending}
																	onClick={async () => {
																		if (
																			!window.confirm(`Delete ${rule.name}? This cannot be undone.`)
																		)
																			return;
																		try {
																			await deleteRule.mutateAsync(rule.id);
																			setPreview(null);
																		} catch (error) {
																			setActionError(
																				getErrorMessage(error, "Could not delete the rule."),
																			);
																		}
																	}}
																	className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-40"
																>
																	<Trash2 className="h-3 w-3" /> Delete
																</button>
															</>
														);
													})()
												: undefined
										}
										statusLabel={
											rule.context === "cross-domain"
												? crossDomainData?.rules.find((candidate) => candidate.id === rule.id)
														?.active
													? "Active"
													: "Draft"
												: undefined
										}
										footer={
											rule.context === "cross-domain"
												? (() => {
														const detail = crossDomainData?.rules.find(
															(candidate) => candidate.id === rule.id,
														);
														if (!detail) return null;
														return (
															<p className="text-xs text-muted-foreground">
																Actions:{" "}
																{detail.actions
																	.map((action) =>
																		action.type === "apply_tag"
																			? `apply tag “${action.tagName}”`
																			: action.type === "send_notification"
																				? "send notification"
																				: "exempt from cleanup",
																	)
																	.join(" · ")}
															</p>
														);
													})()
												: undefined
										}
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
					) : composer.context === "auto-tag" ? (
						<AutoTagRuleComposerDialog
							open={composer.open}
							onOpenChange={(open) => setComposer((prev) => ({ ...prev, open }))}
							editRuleId={composer.editRuleId}
						/>
					) : composer.context === "notifications" ? (
						<NotificationRuleComposerDialog
							open={composer.open}
							onOpenChange={(open) => setComposer((prev) => ({ ...prev, open }))}
							editRuleId={composer.editRuleId}
						/>
					) : (
						<CrossDomainRuleComposerDialog
							open={composer.open}
							onOpenChange={(open) => setComposer((prev) => ({ ...prev, open }))}
							editRuleId={composer.editRuleId}
						/>
					)}
				</Suspense>
			)}

			<Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
				<DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Dry-run: {preview?.ruleName}</DialogTitle>
						<DialogDescription>
							No tags, notifications, cleanup exemptions, or external configuration were changed.
						</DialogDescription>
					</DialogHeader>
					{preview && (
						<div className="space-y-3">
							<p className="text-sm text-muted-foreground">
								Evaluated {preview.data.itemsEvaluated} items; {preview.data.itemsMatched} matched.
							</p>
							<p className="text-xs text-muted-foreground">
								Proposed actions:{" "}
								{preview.data.actions
									.map((action) =>
										action.type === "apply_tag"
											? `apply tag “${action.tagName}”`
											: action.type === "send_notification"
												? "send notification"
												: "exempt from cleanup",
									)
									.join(" · ")}
							</p>
							<div className="max-h-80 space-y-2 overflow-y-auto">
								{preview.data.matches.map((match) => (
									<div
										key={`${match.instanceId}-${match.arrItemId}-${match.itemType}`}
										className="rounded-lg border border-border/50 p-3 text-sm"
									>
										<div className="flex justify-between gap-2">
											<span className="font-medium">
												{incognito ? getLinuxIsoName(match.title) : match.title}
											</span>
											{match.alreadyProcessed && (
												<span className="text-xs text-muted-foreground">Already processed</span>
											)}
										</div>
										<p className="text-xs text-muted-foreground">
											{incognito ? getLinuxInstanceName(match.instanceName) : match.instanceName} ·{" "}
											{incognito ? "Matched configured conditions" : match.reason}
										</p>
									</div>
								))}
							</div>
							{preview.data.truncated && (
								<p className="text-xs text-muted-foreground">Showing the first 100 matches.</p>
							)}
							<div className="flex justify-end gap-2">
								<button
									type="button"
									onClick={() => setPreview(null)}
									className="rounded-lg border border-border/50 px-4 py-2 text-sm"
								>
									Close
								</button>
								<button
									type="button"
									disabled={deploy.isPending}
									onClick={async () => {
										try {
											await deploy.mutateAsync(preview.ruleId);
											setPreview(null);
										} catch (error) {
											setActionError(getErrorMessage(error, "Could not deploy the rule."));
										}
									}}
									className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
								>
									<Rocket className="h-4 w-4" />
									Deploy this draft
								</button>
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
