"use client";

/**
 * Needs Attention Panel (dashboard home — first user-facing surface for the
 * curated attention feed).
 *
 * Consumes `usePulseQuery({ attentionOnly: true })`, which serves the same
 * /pulse route through a new server-side filter that keeps only
 * critical/warning items with an actionUrl. This panel is a *curated subset*
 * of /pulse — a fast read-only "what needs me today" surface — not a
 * replacement for the full Pulse view. That boundary is why the empty state
 * is deliberately narrow ("No critical or warning signals from Pulse right
 * now") and the header always links out to /pulse.
 *
 * Trust rules (enforced here):
 *   - If the query errored AND we have no cached data, show an honest error
 *     state — never an "all clear" on a failed fetch.
 *   - Empty state is ONLY shown when the fetch succeeded.
 *   - Rows render no severity/logic of their own: the severity visual comes
 *     straight from the Pulse item, actionUrl decides whether the row gets
 *     an action button, and we never try to classify items ourselves.
 *   - Titles/details are passed through `anonymizePulseText` /
 *     `anonymizeHealthMessage` (same as /pulse) when incognito mode is on.
 */

import type { PulseItem, PulseSeverity } from "@arr/shared";
import { AlertTriangle, CheckCircle2, ChevronRight, XCircle } from "lucide-react";
import Link from "next/link";
import {
	anonymizeHealthMessage,
	anonymizePulseText,
	useIncognitoMode,
} from "../../../lib/incognito";
import { usePulseQuery } from "../../../hooks/api/usePulse";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";

const MAX_VISIBLE_ITEMS = 10;

// `PulseSeverity` includes `info`, but the server filter guarantees rows here
// are only `critical` / `warning`. We still key the visual map off severity
// directly (no re-classification) and narrow to the two expected severities.
type SeverityColors = {
	readonly bg: string;
	readonly border: string;
	readonly text: string;
};

const SEVERITY_VISUAL: Record<
	Exclude<PulseSeverity, "info">,
	{ icon: typeof XCircle; colors: SeverityColors; srLabel: string }
> = {
	critical: {
		icon: XCircle,
		colors: SEMANTIC_COLORS.error,
		srLabel: "Critical",
	},
	warning: {
		icon: AlertTriangle,
		colors: SEMANTIC_COLORS.warning,
		srLabel: "Warning",
	},
};

// ---------------------------------------------------------------------------
// Card shell — matches the existing dashboard widget look (see
// recently-added-widget.tsx) so the new panel blends with existing cards.
// ---------------------------------------------------------------------------
function PanelShell({
	children,
	className,
	testId,
	ariaLabel,
}: {
	children: React.ReactNode;
	className?: string;
	testId?: string;
	ariaLabel?: string;
}) {
	return (
		<section
			data-testid={testId}
			aria-label={ariaLabel}
			className={cn(
				"overflow-hidden rounded-xl border border-border/30 bg-muted/10",
				className,
			)}
		>
			{children}
		</section>
	);
}

function PanelHeader({
	visibleCount,
	totalCount,
}: {
	visibleCount: number;
	totalCount: number;
}) {
	const subtitle =
		totalCount === 0
			? "Actionable critical and warning signals"
			: totalCount === 1
				? "1 actionable item"
				: `${totalCount} actionable items${totalCount > visibleCount ? ` (showing ${visibleCount})` : ""}`;

	return (
		<div className="flex items-center gap-3 border-b border-border/50 px-6 py-4">
			<div
				className="flex h-8 w-8 items-center justify-center rounded-lg"
				style={{
					backgroundColor: SEMANTIC_COLORS.warning.bg,
					border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
				}}
			>
				<AlertTriangle
					className="h-4 w-4"
					style={{ color: SEMANTIC_COLORS.warning.text }}
				/>
			</div>
			<div className="min-w-0 flex-1">
				<h3 className="text-sm font-semibold text-foreground">Needs Attention</h3>
				<p className="text-xs text-muted-foreground">{subtitle}</p>
			</div>
			<Link
				href="/pulse"
				className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
			>
				View all in Pulse
				<ChevronRight className="inline h-3 w-3 align-[-2px]" />
			</Link>
		</div>
	);
}

// ---------------------------------------------------------------------------
// AttentionRow — one row per item. No severity logic beyond "pick the visual
// for critical vs warning". Severity comes from the item verbatim.
// ---------------------------------------------------------------------------
function AttentionRow({
	item,
	incognito,
}: {
	item: PulseItem;
	incognito: boolean;
}) {
	const visual =
		item.severity === "critical" || item.severity === "warning"
			? SEVERITY_VISUAL[item.severity]
			: null;

	// If a future /pulse change ever leaks an `info` item through the filter,
	// we'd rather not render it than silently mis-badge it as a warning.
	if (!visual) return null;

	const Icon = visual.icon;
	const title = incognito ? anonymizePulseText(item.title) : item.title;
	const detail =
		incognito && item.detail ? anonymizeHealthMessage(item.detail) : item.detail;

	return (
		<li className="flex items-start gap-3 border-b border-border/30 px-6 py-3 last:border-b-0">
			<div
				role="img"
				aria-label={visual.srLabel}
				className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
				style={{
					backgroundColor: visual.colors.bg,
					border: `1px solid ${visual.colors.border}`,
					color: visual.colors.text,
				}}
			>
				<Icon className="h-3.5 w-3.5" aria-hidden="true" />
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-foreground">{title}</p>
				{detail && (
					<p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{detail}</p>
				)}
			</div>
			{item.actionUrl && (
				<Link
					href={item.actionUrl}
					className="inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					{/* actionLabel is static on today's collectors ("Resolve",
					    "Open service", etc.), but routing it through the same
					    anonymizer as detail keeps incognito safe if a future
					    collector ever interpolates a name into the label. */}
					{(() => {
						const label = item.actionLabel ?? "Resolve";
						return incognito ? anonymizeHealthMessage(label) : label;
					})()}
					<ChevronRight className="h-3 w-3" />
				</Link>
			)}
		</li>
	);
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
export function NeedsAttentionPanel() {
	const { data, isLoading, isError } = usePulseQuery({ attentionOnly: true });
	const [incognito] = useIncognitoMode();

	// State: loading (no cached data yet).
	if (isLoading) {
		return (
			<PanelShell
				testId="needs-attention-panel-loading"
				ariaLabel="Needs Attention — loading"
			>
				<div className="flex items-center gap-3 border-b border-border/50 px-6 py-4">
					<div className="h-8 w-8 animate-pulse rounded-lg bg-muted/30" />
					<div className="flex-1 space-y-1.5">
						<div className="h-4 w-32 animate-pulse rounded bg-muted/30" />
						<div className="h-3 w-56 animate-pulse rounded bg-muted/20" />
					</div>
				</div>
				<div className="space-y-2 px-6 py-4">
					<div className="h-4 w-full animate-pulse rounded bg-muted/20" />
					<div className="h-4 w-4/5 animate-pulse rounded bg-muted/20" />
					<div className="h-4 w-3/4 animate-pulse rounded bg-muted/20" />
				</div>
			</PanelShell>
		);
	}

	// State: error with no cached data — NEVER imply "all clear" here.
	if (isError && !data) {
		return (
			<PanelShell
				testId="needs-attention-panel-error"
				ariaLabel="Needs Attention — unavailable"
			>
				<div className="flex items-start gap-3 px-6 py-4">
					<XCircle
						className="mt-0.5 h-5 w-5 shrink-0"
						style={{ color: SEMANTIC_COLORS.error.text }}
					/>
					<div className="min-w-0 flex-1">
						<h3 className="text-sm font-semibold text-foreground">
							Couldn&apos;t load attention items
						</h3>
						<p className="mt-0.5 text-xs text-muted-foreground">
							The attention feed is unavailable right now — other dashboard signals may
							still be accurate.{" "}
							<Link
								href="/pulse"
								className="underline underline-offset-2 transition-colors hover:text-foreground"
							>
								Open Pulse to retry
							</Link>
							.
						</p>
					</div>
				</div>
			</PanelShell>
		);
	}

	const items = data?.items ?? [];
	const visible = items.slice(0, MAX_VISIBLE_ITEMS);
	const truncated = items.length > MAX_VISIBLE_ITEMS;

	// State: empty — only shown when fetch succeeded.
	if (visible.length === 0) {
		return (
			<PanelShell
				testId="needs-attention-panel-empty"
				ariaLabel="Needs Attention — all clear"
			>
				<div className="flex items-start gap-3 px-6 py-4">
					<CheckCircle2
						className="mt-0.5 h-5 w-5 shrink-0"
						style={{ color: SEMANTIC_COLORS.success.text }}
					/>
					<div className="min-w-0 flex-1">
						<h3 className="text-sm font-semibold text-foreground">
							All systems operational
						</h3>
						<p className="mt-0.5 text-xs text-muted-foreground">
							No critical or warning signals from Pulse right now.
						</p>
					</div>
				</div>
			</PanelShell>
		);
	}

	// State: populated.
	return (
		<PanelShell testId="needs-attention-panel" ariaLabel="Needs Attention">
			<PanelHeader visibleCount={visible.length} totalCount={items.length} />
			<ul>
				{visible.map((item) => (
					<AttentionRow key={item.id} item={item} incognito={incognito} />
				))}
			</ul>
			{truncated && (
				<div className="border-t border-border/30 px-6 py-3 text-right">
					<Link
						href="/pulse"
						className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						View all {items.length} items in Pulse
						<ChevronRight className="inline h-3 w-3 align-[-2px]" />
					</Link>
				</div>
			)}
		</PanelShell>
	);
}
