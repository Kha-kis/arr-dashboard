"use client";

import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	Download,
	Loader2,
	Package,
	Play,
	Shield,
	Trash2,
	Wifi,
	WifiOff,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { GlassmorphicCard, ServiceBadge } from "../../../components/layout";
import { Button, toast } from "../../../components/ui";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import type { EnhancedPreviewItem, EnhancedPreviewResult } from "../lib/queue-cleaner-types";

interface EnhancedDryRunPreviewProps {
	result: EnhancedPreviewResult;
	onClose: () => void;
	onRunClean: () => Promise<void>;
	isRunningClean: boolean;
}

const RULE_LABELS: Record<string, string> = {
	stalled: "Stalled",
	failed: "Failed",
	slow: "Slow",
	error_pattern: "Error Pattern",
	seeding_timeout: "Seeding Timeout",
	import_pending: "Import Pending",
	import_blocked: "Import Blocked",
	whitelisted: "Whitelisted",
	healthy: "Healthy",
	too_young: "Too New",
};

// Color type definition for consistent typing
interface ColorStyle {
	bg: string;
	text: string;
	border: string;
}

// Default fallback color for rules not in the map
const DEFAULT_RULE_COLOR: ColorStyle = {
	bg: "rgba(148, 163, 184, 0.1)",
	text: "#94a3b8",
	border: "rgba(148, 163, 184, 0.2)",
};

const RULE_COLORS: Record<string, ColorStyle> = {
	stalled: { bg: "rgba(245, 158, 11, 0.1)", text: "#f59e0b", border: "rgba(245, 158, 11, 0.2)" },
	failed: { bg: "rgba(239, 68, 68, 0.1)", text: "#ef4444", border: "rgba(239, 68, 68, 0.2)" },
	slow: { bg: "rgba(99, 102, 241, 0.1)", text: "#6366f1", border: "rgba(99, 102, 241, 0.2)" },
	error_pattern: {
		bg: "rgba(168, 85, 247, 0.1)",
		text: "#a855f7",
		border: "rgba(168, 85, 247, 0.2)",
	},
	seeding_timeout: {
		bg: "rgba(6, 182, 212, 0.1)",
		text: "#06b6d4",
		border: "rgba(6, 182, 212, 0.2)",
	},
	import_pending: {
		bg: "rgba(251, 146, 60, 0.1)",
		text: "#fb923c",
		border: "rgba(251, 146, 60, 0.2)",
	},
	import_blocked: {
		bg: "rgba(244, 63, 94, 0.1)",
		text: "#f43f5e",
		border: "rgba(244, 63, 94, 0.2)",
	},
	whitelisted: { bg: "rgba(34, 197, 94, 0.1)", text: "#22c55e", border: "rgba(34, 197, 94, 0.2)" },
	healthy: { bg: "rgba(34, 197, 94, 0.1)", text: "#22c55e", border: "rgba(34, 197, 94, 0.2)" },
	too_young: {
		bg: "rgba(148, 163, 184, 0.1)",
		text: "#94a3b8",
		border: "rgba(148, 163, 184, 0.2)",
	},
};

// Default fallback color for actions not in the map
const DEFAULT_ACTION_COLOR: ColorStyle = {
	bg: "rgba(148, 163, 184, 0.1)",
	text: "#94a3b8",
	border: "rgba(148, 163, 184, 0.2)",
};

const ACTION_COLORS: Record<string, ColorStyle> = {
	remove: SEMANTIC_COLORS.error,
	warn: SEMANTIC_COLORS.warning,
	skip: { bg: "rgba(148, 163, 184, 0.1)", text: "#94a3b8", border: "rgba(148, 163, 184, 0.2)" },
	whitelist: SEMANTIC_COLORS.success,
};

// Action priority for determining group action (worst action takes precedence)
const ACTION_PRIORITY: Record<string, number> = {
	remove: 4,
	warn: 3,
	skip: 2,
	whitelist: 1,
};

// Grouped item structure for display
interface ItemGroup {
	downloadId: string;
	items: EnhancedPreviewItem[];
	worstAction: "remove" | "warn" | "skip" | "whitelist";
	dominantRule: string;
}

/**
 * Groups items by downloadId, keeping single items ungrouped
 */
function groupItemsByDownload(items: EnhancedPreviewItem[]): (EnhancedPreviewItem | ItemGroup)[] {
	// Group by downloadId
	const groups = new Map<string | undefined, EnhancedPreviewItem[]>();

	for (const item of items) {
		const key = item.downloadId;
		const existing = groups.get(key);
		if (existing) {
			existing.push(item);
		} else {
			groups.set(key, [item]);
		}
	}

	// Convert to array, keeping single items as-is, grouping multiples
	const result: (EnhancedPreviewItem | ItemGroup)[] = [];

	for (const [downloadId, groupItems] of groups) {
		if (!downloadId || groupItems.length === 1) {
			// Single item or no downloadId - render individually
			result.push(...groupItems);
		} else {
			// Multiple items with same downloadId - create group
			const worstAction = groupItems.reduce(
				(worst, item) => {
					const currentPriority = ACTION_PRIORITY[item.action] ?? 0;
					const worstPriority = ACTION_PRIORITY[worst] ?? 0;
					return currentPriority > worstPriority ? item.action : worst;
				},
				"whitelist" as "remove" | "warn" | "skip" | "whitelist",
			);

			// Find dominant rule (most common)
			const ruleCounts = new Map<string, number>();
			for (const item of groupItems) {
				ruleCounts.set(item.rule, (ruleCounts.get(item.rule) ?? 0) + 1);
			}
			const dominantRule =
				[...ruleCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

			result.push({
				downloadId,
				items: groupItems,
				worstAction,
				dominantRule,
			});
		}
	}

	return result;
}

function isItemGroup(item: EnhancedPreviewItem | ItemGroup): item is ItemGroup {
	return "items" in item && Array.isArray(item.items);
}

export const EnhancedDryRunPreview = ({
	result,
	onClose,
	onRunClean,
	isRunningClean,
}: EnhancedDryRunPreviewProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const serviceGradient = getServiceGradient(result.instanceService);
	const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

	// Handle Escape key to close modal
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	const toggleExpand = (id: number) => {
		setExpandedItems((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const handleRunClean = async () => {
		try {
			await onRunClean();
			toast.success("Queue clean started");
			onClose();
		} catch {
			toast.error("Failed to start clean");
		}
	};

	// Categorize items by action
	const itemsByAction = {
		remove: result.previewItems.filter((i) => i.action === "remove"),
		warn: result.previewItems.filter((i) => i.action === "warn"),
		skip: result.previewItems.filter(
			(i) => i.action === "skip" && i.rule !== "healthy" && i.rule !== "too_young",
		),
		whitelist: result.previewItems.filter((i) => i.action === "whitelist"),
		healthy: result.previewItems.filter((i) => i.rule === "healthy" || i.rule === "too_young"),
	};

	// Calculate rule breakdown percentages for bar
	const totalRules = Object.values(result.ruleSummary).reduce((a, b) => a + b, 0);

	return (
		<div className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4">
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled by modal */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Backdrop click to close is standard modal UX */}
			<div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

			{/* Modal */}
			<div className="relative z-modal w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-xl border border-border/50 bg-background shadow-2xl">
				{/* Accent line */}
				<div
					className="absolute top-0 left-0 right-0 h-0.5"
					style={{
						background: `linear-gradient(90deg, ${serviceGradient.from}, ${serviceGradient.to})`,
					}}
				/>

				{/* Header */}
				<div className="flex items-center justify-between border-b border-border/50 p-4">
					<div className="flex items-center gap-3">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-lg"
							style={{
								background: `linear-gradient(135deg, ${serviceGradient.from}20, ${serviceGradient.to}10)`,
								border: `1px solid ${serviceGradient.from}30`,
							}}
						>
							<Trash2 className="h-5 w-5" style={{ color: serviceGradient.from }} />
						</div>
						<div>
							<div className="flex items-center gap-2">
								<h3 className="font-semibold text-foreground">{result.instanceLabel}</h3>
								<ServiceBadge service={result.instanceService} />
								{result.instanceReachable ? (
									<span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-500">
										<Wifi className="h-3 w-3" />
										Connected
									</span>
								) : (
									<span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500">
										<WifiOff className="h-3 w-3" />
										Unreachable
									</span>
								)}
							</div>
							<p className="text-xs text-muted-foreground">
								Queue Preview • Generated {new Date(result.previewGeneratedAt).toLocaleTimeString()}
							</p>
						</div>
					</div>
					<Button variant="ghost" size="sm" onClick={onClose}>
						<X className="h-4 w-4" />
					</Button>
				</div>

				{/* Content */}
				<div className="overflow-y-auto p-4 max-h-[calc(85vh-10rem)]">
					{/* Queue State Summary */}
					<div className="grid grid-cols-4 gap-2 mb-4">
						<StatCard
							icon={Download}
							label="Downloading"
							value={result.queueSummary.downloading}
							color="#3b82f6"
						/>
						<StatCard
							icon={Clock}
							label="Seeding"
							value={result.queueSummary.seeding + result.queueSummary.importPending}
							color="#22c55e"
						/>
						<StatCard
							icon={AlertTriangle}
							label="Failed"
							value={result.queueSummary.failed}
							color="#ef4444"
						/>
						<StatCard
							icon={Shield}
							label="Total"
							value={result.queueSummary.totalItems}
							color={themeGradient.from}
						/>
					</div>

					{/* Preview Summary */}
					<div className="grid grid-cols-3 gap-2 mb-4">
						<div
							className="rounded-lg p-3 text-center"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<div className="text-2xl font-bold" style={{ color: SEMANTIC_COLORS.error.text }}>
								{result.wouldRemove}
							</div>
							<div className="text-xs text-muted-foreground">Would Remove</div>
						</div>
						<div
							className="rounded-lg p-3 text-center"
							style={{
								backgroundColor: SEMANTIC_COLORS.warning.bg,
								border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
							}}
						>
							<div className="text-2xl font-bold" style={{ color: SEMANTIC_COLORS.warning.text }}>
								{result.wouldWarn}
							</div>
							<div className="text-xs text-muted-foreground">Would Warn</div>
						</div>
						<div
							className="rounded-lg p-3 text-center"
							style={{
								backgroundColor: SEMANTIC_COLORS.success.bg,
								border: `1px solid ${SEMANTIC_COLORS.success.border}`,
							}}
						>
							<div className="text-2xl font-bold" style={{ color: SEMANTIC_COLORS.success.text }}>
								{result.wouldSkip}
							</div>
							<div className="text-xs text-muted-foreground">Would Keep</div>
						</div>
					</div>

					{/* Rule Breakdown Bar */}
					{totalRules > 0 && (
						<div className="mb-4">
							<div className="text-xs font-medium text-muted-foreground mb-2">Rule Breakdown</div>
							<div className="flex h-3 rounded-full overflow-hidden bg-card/50">
								{Object.entries(result.ruleSummary).map(([rule, count]) => {
									const width = (count / totalRules) * 100;
									const color = RULE_COLORS[rule] ?? DEFAULT_RULE_COLOR;
									return (
										<div
											key={rule}
											className="h-full transition-all"
											style={{
												width: `${width}%`,
												backgroundColor: color.text,
											}}
											title={`${RULE_LABELS[rule] ?? rule}: ${count}`}
										/>
									);
								})}
							</div>
							<div className="flex flex-wrap gap-2 mt-2">
								{Object.entries(result.ruleSummary).map(([rule, count]) => {
									const color = RULE_COLORS[rule] ?? DEFAULT_RULE_COLOR;
									return (
										<span key={rule} className="inline-flex items-center gap-1 text-[10px]">
											<span
												className="w-2 h-2 rounded-full"
												style={{ backgroundColor: color.text }}
											/>
											{RULE_LABELS[rule] ?? rule}: {count}
										</span>
									);
								})}
							</div>
						</div>
					)}

					{/* Items by Action */}
					{itemsByAction.remove.length > 0 && (
						<ItemSection
							title="Would Remove"
							icon={Trash2}
							items={itemsByAction.remove}
							color={SEMANTIC_COLORS.error.text}
							expandedItems={expandedItems}
							onToggle={toggleExpand}
						/>
					)}

					{itemsByAction.warn.length > 0 && (
						<ItemSection
							title="Would Warn"
							icon={AlertTriangle}
							items={itemsByAction.warn}
							color="#f59e0b"
							expandedItems={expandedItems}
							onToggle={toggleExpand}
						/>
					)}

					{itemsByAction.whitelist.length > 0 && (
						<ItemSection
							title="Whitelisted"
							icon={Shield}
							items={itemsByAction.whitelist}
							color={SEMANTIC_COLORS.success.text}
							expandedItems={expandedItems}
							onToggle={toggleExpand}
							defaultCollapsed
						/>
					)}

					{itemsByAction.healthy.length > 0 && (
						<ItemSection
							title="Healthy"
							icon={CheckCircle2}
							items={itemsByAction.healthy}
							color={SEMANTIC_COLORS.success.text}
							expandedItems={expandedItems}
							onToggle={toggleExpand}
							defaultCollapsed
							maxVisible={10}
						/>
					)}

					{result.previewItems.length === 0 && (
						<div className="text-center py-8 text-muted-foreground">
							<CheckCircle2 className="h-10 w-10 mx-auto mb-2 opacity-50" />
							<p className="text-sm font-medium">Queue is empty</p>
							<p className="text-xs">No items to preview</p>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="border-t border-border/50 p-4 flex items-center justify-between">
					<div className="text-xs text-muted-foreground">
						{result.configSnapshot.strikeSystemEnabled && (
							<span className="mr-2">Strike System: {result.configSnapshot.maxStrikes} max</span>
						)}
						<span>Max removals per run: {result.configSnapshot.maxRemovalsPerRun}</span>
					</div>
					<div className="flex gap-2">
						<Button variant="secondary" onClick={onClose}>
							Close
						</Button>
						{result.wouldRemove > 0 && result.instanceReachable && (
							<Button
								variant="secondary"
								onClick={() => void handleRunClean()}
								disabled={isRunningClean}
								className="gap-2"
								style={{
									borderColor: `${themeGradient.from}40`,
									color: themeGradient.from,
								}}
							>
								{isRunningClean ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : (
									<Play className="h-4 w-4" />
								)}
								Run Clean Now
							</Button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};

// Helper components
const StatCard = ({
	icon: Icon,
	label,
	value,
	color,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	label: string;
	value: number;
	color: string;
}) => (
	<div className="rounded-lg border border-border/30 bg-card/30 p-2 text-center">
		<div className="flex items-center justify-center gap-1 mb-1">
			<Icon className="h-3 w-3" style={{ color }} />
			<span className="text-lg font-bold" style={{ color }}>
				{value}
			</span>
		</div>
		<div className="text-[10px] text-muted-foreground">{label}</div>
	</div>
);

/**
 * Find common prefix among an array of strings (for extracting show/movie name)
 */
function findCommonPrefix(strings: string[]): string {
	if (strings.length === 0) return "";
	if (strings.length === 1) return strings[0] ?? "";

	const first = strings[0] ?? "";

	// Find the longest common prefix
	let prefixEnd = 0;
	for (let i = 0; i < first.length; i++) {
		const char = first[i];
		if (strings.every((s) => s?.[i] === char)) {
			prefixEnd = i + 1;
		} else {
			break;
		}
	}

	// Trim to last word boundary or separator
	let prefix = first.substring(0, prefixEnd);

	// Look for common separators (season/episode markers)
	const separators = [" - S", " S", " - ", " (", " ["];
	for (const sep of separators) {
		const sepIdx = prefix.lastIndexOf(sep);
		if (sepIdx > 0) {
			prefix = prefix.substring(0, sepIdx);
			break;
		}
	}

	return prefix.trim();
}

const PreviewItemRow = ({
	item,
	isExpanded,
	onToggle,
}: {
	item: EnhancedPreviewItem;
	isExpanded: boolean;
	onToggle: () => void;
}) => {
	const ruleColor = RULE_COLORS[item.rule] ?? DEFAULT_RULE_COLOR;
	const actionColor = ACTION_COLORS[item.action] ?? DEFAULT_ACTION_COLOR;

	return (
		<GlassmorphicCard padding="none">
			<button type="button" className="w-full p-3 text-left" onClick={onToggle}>
				<div className="flex items-start gap-2">
					{isExpanded ? (
						<ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
					) : (
						<ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
					)}
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 mb-1">
							<p className="text-sm font-medium text-foreground truncate">{item.title}</p>
							<span
								className="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium"
								style={{
									backgroundColor: ruleColor.bg,
									color: ruleColor.text,
									border: `1px solid ${ruleColor.border}`,
								}}
							>
								{RULE_LABELS[item.rule] ?? item.rule}
							</span>
							{item.strikeInfo && (
								<span
									className="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium"
									style={{
										backgroundColor: SEMANTIC_COLORS.warning.bg,
										color: SEMANTIC_COLORS.warning.text,
										border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
									}}
								>
									Strike {item.strikeInfo.currentStrikes}/{item.strikeInfo.maxStrikes}
								</span>
							)}
						</div>
						<p className="text-xs text-muted-foreground">{item.reason}</p>
					</div>
					<span
						className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize"
						style={{
							backgroundColor: actionColor.bg,
							color: actionColor.text,
							border: `1px solid ${actionColor.border}`,
						}}
					>
						{item.action}
					</span>
				</div>
			</button>

			{isExpanded && (
				<div className="px-3 pb-3 pt-0 border-t border-border/30 ml-6">
					<div className="pt-2 space-y-2">
						<p className="text-xs text-foreground">{item.detailedReason}</p>
						<div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
							<span>Age: {item.queueAge}m</span>
							{item.progress !== undefined && <span>Progress: {item.progress}%</span>}
							{item.indexer && <span>Indexer: {item.indexer}</span>}
							{item.protocol && <span>Protocol: {item.protocol}</span>}
							{item.downloadClient && <span>Client: {item.downloadClient}</span>}
							{item.status && <span>Status: {item.status}</span>}
						</div>
					</div>
				</div>
			)}
		</GlassmorphicCard>
	);
};

/**
 * Grouped item row - shows a collapsible group of items from the same download (e.g., season pack)
 */
const GroupedItemRow = ({
	group,
	isExpanded,
	onToggleGroup,
	expandedItems,
	onToggleItem,
}: {
	group: ItemGroup;
	isExpanded: boolean;
	onToggleGroup: () => void;
	expandedItems: Set<number>;
	onToggleItem: (id: number) => void;
}) => {
	const actionColor = ACTION_COLORS[group.worstAction] ?? DEFAULT_ACTION_COLOR;
	const ruleColor = RULE_COLORS[group.dominantRule] ?? DEFAULT_RULE_COLOR;

	// Find common properties from first item for display
	const firstItem = group.items[0];
	const indexer = firstItem?.indexer;
	const downloadClient = firstItem?.downloadClient;
	const protocol = firstItem?.protocol;

	// Extract common title prefix (usually show/movie name)
	const titles = group.items.map((i) => i.title);
	const commonPrefix = findCommonPrefix(titles);

	return (
		<GlassmorphicCard padding="none">
			<button type="button" className="w-full p-3 text-left" onClick={onToggleGroup}>
				<div className="flex items-start gap-2">
					{isExpanded ? (
						<ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
					) : (
						<ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
					)}
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 mb-1">
							<Package className="h-4 w-4 text-muted-foreground shrink-0" />
							<p className="text-sm font-medium text-foreground truncate">
								{commonPrefix || "Download Pack"}
							</p>
							<span
								className="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium"
								style={{
									backgroundColor: "rgba(99, 102, 241, 0.1)",
									color: "#6366f1",
									border: "1px solid rgba(99, 102, 241, 0.2)",
								}}
							>
								{group.items.length} items
							</span>
							<span
								className="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium"
								style={{
									backgroundColor: ruleColor.bg,
									color: ruleColor.text,
									border: `1px solid ${ruleColor.border}`,
								}}
							>
								{RULE_LABELS[group.dominantRule] ?? group.dominantRule}
							</span>
						</div>
						<p className="text-xs text-muted-foreground">
							{indexer && <span className="mr-3">Indexer: {indexer}</span>}
							{downloadClient && <span className="mr-3">Client: {downloadClient}</span>}
							{protocol && <span>Protocol: {protocol}</span>}
						</p>
					</div>
					<span
						className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize"
						style={{
							backgroundColor: actionColor.bg,
							color: actionColor.text,
							border: `1px solid ${actionColor.border}`,
						}}
					>
						{group.worstAction}
					</span>
				</div>
			</button>

			{isExpanded && (
				<div className="px-3 pb-3 pt-0 border-t border-border/30">
					<div className="pt-2 space-y-2 pl-6">
						{group.items.map((item) => (
							<PreviewItemRow
								key={item.id}
								item={item}
								isExpanded={expandedItems.has(item.id)}
								onToggle={() => onToggleItem(item.id)}
							/>
						))}
					</div>
				</div>
			)}
		</GlassmorphicCard>
	);
};

const ItemSection = ({
	title,
	icon: Icon,
	items,
	color,
	expandedItems,
	onToggle,
	defaultCollapsed = false,
	maxVisible = 100,
}: {
	title: string;
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	items: EnhancedPreviewItem[];
	color: string;
	expandedItems: Set<number>;
	onToggle: (id: number) => void;
	defaultCollapsed?: boolean;
	maxVisible?: number;
}) => {
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

	// Group items by downloadId
	const groupedItems = useMemo(() => groupItemsByDownload(items), [items]);

	const toggleGroup = (downloadId: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(downloadId)) {
				next.delete(downloadId);
			} else {
				next.add(downloadId);
			}
			return next;
		});
	};

	// Count actual visible entries (groups count as 1)
	const visibleCount = groupedItems.slice(0, maxVisible).length;
	const hasMore = groupedItems.length > maxVisible;

	return (
		<div className="mb-4">
			<button
				type="button"
				className="flex items-center gap-2 mb-2 text-sm font-medium w-full text-left"
				onClick={() => setCollapsed(!collapsed)}
			>
				{collapsed ? (
					<ChevronRight className="h-4 w-4 text-muted-foreground" />
				) : (
					<ChevronDown className="h-4 w-4 text-muted-foreground" />
				)}
				<Icon className="h-4 w-4" style={{ color }} />
				{title} ({items.length})
			</button>
			{!collapsed && (
				<div className="space-y-2 pl-6">
					{groupedItems.slice(0, maxVisible).map((itemOrGroup) => {
						if (isItemGroup(itemOrGroup)) {
							return (
								<GroupedItemRow
									key={itemOrGroup.downloadId}
									group={itemOrGroup}
									isExpanded={expandedGroups.has(itemOrGroup.downloadId)}
									onToggleGroup={() => toggleGroup(itemOrGroup.downloadId)}
									expandedItems={expandedItems}
									onToggleItem={onToggle}
								/>
							);
						}
						return (
							<PreviewItemRow
								key={itemOrGroup.id}
								item={itemOrGroup}
								isExpanded={expandedItems.has(itemOrGroup.id)}
								onToggle={() => onToggle(itemOrGroup.id)}
							/>
						);
					})}
					{hasMore && (
						<p className="text-xs text-muted-foreground text-center py-2">
							...and {groupedItems.length - visibleCount} more entries
						</p>
					)}
				</div>
			)}
		</div>
	);
};

// Legacy export for backward compatibility
export { EnhancedDryRunPreview as DryRunPreview };
