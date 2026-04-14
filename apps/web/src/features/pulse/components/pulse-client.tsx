"use client";

import type { PulseItem, PulseSeverity } from "@arr/shared";
import {
	Activity,
	AlertTriangle,
	ArrowUpCircle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	HardDrive,
	HeartPulse,
	Inbox,
	Info,
	Settings,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
	DataFreshness,
	GlassmorphicCard,
	PremiumEmptyState,
} from "../../../components/layout/premium-components";
import { usePulseQuery } from "../../../hooks/api/usePulse";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	anonymizeHealthMessage,
	getLinuxInstanceName,
	useIncognitoMode,
} from "../../../lib/incognito";
import { POLLING_STATS } from "../../../lib/polling-intervals";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";

// ============================================================================
// Incognito helper — anonymize "InstanceLabel: health message" titles
// ============================================================================

function anonymizePulseText(text: string): string {
	// Pulse titles follow "Label: message" or "Label is unreachable/recovering"
	const colonIdx = text.indexOf(": ");
	if (colonIdx > 0) {
		const label = text.slice(0, colonIdx);
		const message = text.slice(colonIdx + 2);
		return `${getLinuxInstanceName(label)}: ${anonymizeHealthMessage(message)}`;
	}
	// "Label is unreachable" pattern
	const isIdx = text.indexOf(" is ");
	if (isIdx > 0) {
		const label = text.slice(0, isIdx);
		const rest = text.slice(isIdx);
		return `${getLinuxInstanceName(label)}${rest}`;
	}
	return anonymizeHealthMessage(text);
}

// ============================================================================
// Severity config
// ============================================================================

const SEVERITY_CONFIG: Record<
	PulseSeverity,
	{
		label: string;
		icon: typeof XCircle;
		colors: { bg: string; border: string; text: string };
	}
> = {
	critical: {
		label: "Critical",
		icon: XCircle,
		colors: SEMANTIC_COLORS.error,
	},
	warning: {
		label: "Warning",
		icon: AlertTriangle,
		colors: SEMANTIC_COLORS.warning,
	},
	info: {
		label: "Info",
		icon: Info,
		colors: SEMANTIC_COLORS.info,
	},
};

// ============================================================================
// Category icons
// ============================================================================

const CATEGORY_ICONS: Record<string, typeof Activity> = {
	health: HeartPulse,
	storage: HardDrive,
	quality: ArrowUpCircle,
	requests: Inbox,
	operations: Settings,
};

// ============================================================================
// PulseItemRow
// ============================================================================

function PulseItemRow({
	item,
	index,
	incognito,
}: {
	item: PulseItem;
	index: number;
	incognito: boolean;
}) {
	const serviceGradient = getServiceGradient(item.source);
	const CategoryIcon = CATEGORY_ICONS[item.category] ?? Activity;
	const title = incognito ? anonymizePulseText(item.title) : item.title;
	const detail = incognito && item.detail ? anonymizeHealthMessage(item.detail) : item.detail;

	return (
		<div
			className="flex items-start gap-3 rounded-lg border border-border/30 bg-card/20 px-4 py-3 transition-colors hover:bg-card/40 animate-in fade-in slide-in-from-bottom-2"
			style={{
				animationDelay: `${index * 30}ms`,
				animationFillMode: "backwards",
			}}
		>
			<div
				className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
				style={{
					backgroundColor: `${serviceGradient.from}20`,
					color: serviceGradient.from,
				}}
			>
				<CategoryIcon className="h-4 w-4" />
			</div>

			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium text-foreground">{title}</p>
				{detail && <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{detail}</p>}
			</div>

			{item.actionUrl && (
				<Link
					href={item.actionUrl}
					className="shrink-0 flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					{item.actionLabel ?? "View"}
					<ChevronRight className="h-3 w-3" />
				</Link>
			)}
		</div>
	);
}

// ============================================================================
// SeveritySection
// ============================================================================

function SeveritySection({
	severity,
	items,
	defaultExpanded,
	incognito,
}: {
	severity: PulseSeverity;
	items: PulseItem[];
	defaultExpanded: boolean;
	incognito: boolean;
}) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const config = SEVERITY_CONFIG[severity];

	if (items.length === 0) return null;

	return (
		<GlassmorphicCard className="overflow-hidden">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-card/30"
			>
				<div
					className="flex h-8 w-8 items-center justify-center rounded-lg"
					style={{
						backgroundColor: config.colors.bg,
						border: `1px solid ${config.colors.border}`,
					}}
				>
					<config.icon className="h-4 w-4" style={{ color: config.colors.text }} />
				</div>

				<div className="flex-1">
					<span className="text-sm font-semibold text-foreground">{config.label}</span>
					<span
						className="ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium"
						style={{
							backgroundColor: config.colors.bg,
							color: config.colors.text,
							border: `1px solid ${config.colors.border}`,
						}}
					>
						{items.length}
					</span>
				</div>

				<ChevronDown
					className={cn(
						"h-4 w-4 text-muted-foreground transition-transform duration-200",
						expanded && "rotate-180",
					)}
				/>
			</button>

			{expanded && (
				<div className="space-y-2 px-5 pb-4">
					{items.map((item, index) => (
						<PulseItemRow key={item.id} item={item} index={index} incognito={incognito} />
					))}
				</div>
			)}
		</GlassmorphicCard>
	);
}

// ============================================================================
// PulseSummary (inline in page header)
// ============================================================================

function PulseSummary({
	critical,
	warning,
	info,
}: {
	critical: number;
	warning: number;
	info: number;
}) {
	const total = critical + warning + info;
	if (total === 0) return null;

	return (
		<div className="flex items-center gap-2">
			{critical > 0 && (
				<span
					className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
					style={{
						backgroundColor: SEMANTIC_COLORS.error.bg,
						color: SEMANTIC_COLORS.error.text,
						border: `1px solid ${SEMANTIC_COLORS.error.border}`,
					}}
				>
					<XCircle className="h-3 w-3" />
					{critical}
				</span>
			)}
			{warning > 0 && (
				<span
					className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
					style={{
						backgroundColor: SEMANTIC_COLORS.warning.bg,
						color: SEMANTIC_COLORS.warning.text,
						border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
					}}
				>
					<AlertTriangle className="h-3 w-3" />
					{warning}
				</span>
			)}
			{info > 0 && (
				<span
					className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
					style={{
						backgroundColor: SEMANTIC_COLORS.info.bg,
						color: SEMANTIC_COLORS.info.text,
						border: `1px solid ${SEMANTIC_COLORS.info.border}`,
					}}
				>
					<Info className="h-3 w-3" />
					{info}
				</span>
			)}
		</div>
	);
}

// ============================================================================
// Main PulseClient
// ============================================================================

export const PulseClient: React.FC = () => {
	const { data, isLoading, isError, isFetching, dataUpdatedAt } = usePulseQuery();
	const { gradient: themeGradient } = useThemeGradient();
	const [incognito] = useIncognitoMode();

	if (isLoading) {
		return (
			<div className="space-y-4">
				{[1, 2, 3].map((i) => (
					<div
						key={i}
						className="h-20 animate-pulse rounded-xl border border-border/50 bg-card/30"
					/>
				))}
			</div>
		);
	}

	// Only replace the whole UI when we have nothing to show. A refetch error
	// with cached data keeps rendering — the DataFreshness indicator in the
	// header communicates "Couldn't refresh · showing last result from N ago".
	if (!data) {
		return (
			<PremiumEmptyState
				icon={AlertTriangle}
				title="Could not load system pulse"
				description="There was a problem fetching health signals. Try refreshing the page."
			/>
		);
	}

	const criticalItems = data.items.filter((i) => i.severity === "critical");
	const warningItems = data.items.filter((i) => i.severity === "warning");
	const infoItems = data.items.filter((i) => i.severity === "info");
	const totalItems = data.items.length;

	// When the most recent refresh failed we're looking at a cached snapshot.
	// A zero-item cached snapshot does NOT mean "healthy right now" — it means
	// "healthy as of the last successful fetch". Treat that as unknown-state so
	// the big green "All clear" doesn't overclaim. DataFreshness already shows
	// "Couldn't refresh · showing last result from N ago" in the header.
	const canAssertHealthy = !isError;

	return (
		<div className="space-y-6">
			{/* Page header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						}}
					>
						<Activity className="h-5 w-5 text-white" />
					</div>
					<div>
						<h1 className="text-xl font-bold text-foreground">System Pulse</h1>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<p className="text-sm text-muted-foreground">
								{totalItems === 0
									? canAssertHealthy
										? "Everything looks good"
										: "No signals in last successful check"
									: `${totalItems} signal${totalItems === 1 ? "" : "s"} across your stack`}
							</p>
							{/* Pulse polls every 2min — operators otherwise have no way to tell
							    whether they're looking at fresh or 90s-old health data. */}
							<DataFreshness
								dataUpdatedAt={dataUpdatedAt}
								isFetching={isFetching}
								isError={isError}
								pollIntervalMs={POLLING_STATS}
							/>
						</div>
					</div>
				</div>

				<PulseSummary
					critical={data.summary.critical}
					warning={data.summary.warning}
					info={data.summary.info}
				/>
			</div>

			{/* Empty state — only claim "all clear" when the refresh actually succeeded.
			    On a failed refresh we still render the card (so the freshness badge in the
			    header stays anchored) but swap the copy so we don't overclaim health. */}
			{totalItems === 0 &&
				(canAssertHealthy ? (
					<PremiumEmptyState
						icon={CheckCircle2}
						title="All clear"
						description="No issues detected across your connected services. Everything is running smoothly."
					/>
				) : (
					<PremiumEmptyState
						icon={AlertTriangle}
						title="Couldn't refresh signals"
						description="Showing the last successful check, which found no issues. Current status is unknown until the next refresh succeeds."
					/>
				))}

			{/* Severity sections */}
			<div className="space-y-4">
				<SeveritySection
					severity="critical"
					items={criticalItems}
					defaultExpanded={true}
					incognito={incognito}
				/>
				<SeveritySection
					severity="warning"
					items={warningItems}
					defaultExpanded={true}
					incognito={incognito}
				/>
				<SeveritySection
					severity="info"
					items={infoItems}
					defaultExpanded={criticalItems.length === 0 && warningItems.length === 0}
					incognito={incognito}
				/>
			</div>
		</div>
	);
};
