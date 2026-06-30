"use client";

/**
 * Operator Console — Automation tab (read-only cross-domain rule viewer).
 *
 * The read half of the Unified Automation Engine composer (charter §2.1 /
 * §5.2): every domain's rules in one place, normalized to v1 and rendered with
 * {@link RuleDocumentView}. Authoring lands in a later PR; this surface is
 * deliberately read-only.
 *
 * Incognito: rule NAMES (the operator's own labels) stay visible so the view is
 * usable; sensitive param VALUES are masked inside RuleDocumentView. Retired
 * kinds badge as unavailable; an unparseable stored rule is shown honestly
 * rather than hidden.
 */

import type { AutomationRuleSummary, RuleContextId } from "@arr/shared";
import { AlertTriangle, Workflow } from "lucide-react";
import { AsyncStateView, GlassmorphicCard } from "../../../components/layout";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import { useAutomationRules } from "../../../hooks/api/useAutomation";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { RuleDocumentView } from "./rule-document-view";

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

function RuleCard({ rule, incognito }: { rule: AutomationRuleSummary; incognito: boolean }) {
	return (
		<GlassmorphicCard className="space-y-2 p-4">
			<div className="flex items-start justify-between gap-2">
				{/* Rule name = the operator's own label; shown even in incognito so the
				    viewer stays usable. Sensitive values live in the params, masked below. */}
				<span className="font-medium text-foreground">{rule.name}</span>
				<EnabledBadge enabled={rule.enabled} />
			</div>
			{rule.unparseable || rule.document === null ? (
				<p
					className="flex items-center gap-1.5 text-sm"
					style={{ color: SEMANTIC_COLORS.warning.text }}
				>
					<AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					This rule could not be read from its stored definition — open its surface to repair it.
				</p>
			) : (
				<RuleDocumentView document={rule.document} context={rule.context} incognito={incognito} />
			)}
		</GlassmorphicCard>
	);
}

export function AutomationPanel() {
	const { data, isLoading, isError, error, refetch } = useAutomationRules();
	const [incognito] = useIncognitoMode();

	const rules = data?.rules ?? [];
	const groups = CONTEXT_ORDER.map((context) => ({
		context,
		rules: rules.filter((rule) => rule.context === context),
	})).filter((group) => group.rules.length > 0);

	return (
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
					"Rules you create in Library Cleanup, Auto-Tag, and Notifications appear here, unified.",
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
								<RuleCard key={`${rule.context}-${rule.id}`} rule={rule} incognito={incognito} />
							))}
						</div>
					</section>
				))}
			</div>
		</AsyncStateView>
	);
}
