"use client";

import type { CleanupExplainResponse, CleanupPreviewResponse, CleanupRuleResponse, CreateCleanupRule } from "@arr/shared";
import {
	AlertTriangle,
	BarChart3,
	Check,
	CheckCircle2,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Eraser,
	Eye,
	HelpCircle,
	ListChecks,
	Loader2,
	Pencil,
	Film,
	Play,
	Plus,
	RefreshCw,
	Tv,
	ScrollText,
	Settings2,
	Shield,
	X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
	GlassmorphicCard,
	GradientButton,
	PremiumPageHeader,
	PremiumPageLoading,
	PremiumProgress,
	PremiumSection,
	type PremiumTab,
	PremiumTabs,
	StatusBadge,
} from "@/components/layout";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import {
	useApproveCleanupItem,
	useBulkCleanupAction,
	useCleanupApprovalQueue,
	useCleanupConfig,
	useCleanupExecute,
	useCleanupExplain,
	useCleanupLogs,
	useCleanupPreview,
	useCleanupStatistics,
	useCleanupStatus,
	useCreateCleanupRule,
	useDeleteCleanupRule,
	useRejectCleanupItem,
	useReorderCleanupRules,
	useUpdateCleanupConfig,
	useUpdateCleanupRule,
} from "../../../hooks/api/useLibraryCleanup";
import { CleanupHealthBanner } from "./cleanup-health-banner";
import { CleanupRuleDialog } from "./cleanup-rule-dialog";

type Tab = "config" | "approvals" | "logs" | "statistics";

const tabConfig: PremiumTab[] = [
	{ id: "config", label: "Rules & Config", icon: Settings2 },
	{ id: "approvals", label: "Approval Queue", icon: ListChecks },
	{ id: "logs", label: "Activity Log", icon: ScrollText },
	{ id: "statistics", label: "Statistics", icon: BarChart3 },
];

interface ExplainTarget {
	instanceId: string;
	arrItemId: number;
	title: string;
}

export function LibraryCleanupClient() {
	const { gradient } = useThemeGradient();
	const [activeTab, setActiveTab] = useState<Tab>("config");
	const { data: config, isLoading } = useCleanupConfig();
	const { data: healthStatus } = useCleanupStatus();
	const updateConfig = useUpdateCleanupConfig();
	const preview = useCleanupPreview();
	const execute = useCleanupExecute();

	// Explain state — shared across tabs (preview + approvals)
	const [explainTarget, setExplainTarget] = useState<ExplainTarget | null>(null);
	const explain = useCleanupExplain();

	if (isLoading) return <PremiumPageLoading showHeader cardCount={3} />;

	return (
		<>
			<PremiumPageHeader
				label="Library Management"
				labelIcon={Eraser}
				title="Library Cleanup"
				gradientTitle
				description="Automatically clean up your library based on configurable rules"
			/>

			<PremiumTabs
				tabs={tabConfig}
				activeTab={activeTab}
				onTabChange={(id) => setActiveTab(id as Tab)}
			/>

			{healthStatus && <div className="mt-4"><CleanupHealthBanner status={healthStatus} /></div>}

			<div className="mt-6 space-y-6">
				{activeTab === "config" && config && (
					<ConfigTab
						config={config}
						gradient={gradient}
						onUpdateConfig={(data) => updateConfig.mutate(data)}
						onPreview={() => preview.mutate(undefined)}
						onExecute={() => execute.mutate(undefined, { onSettled: () => preview.reset() })}
						previewData={preview.data}
						isPreviewLoading={preview.isPending}
						isExecuting={execute.isPending}
						executeResult={execute.data}
						previewError={preview.error}
						executeError={execute.error}
						onExplain={(target) => {
							setExplainTarget(target);
							explain.mutate({ instanceId: target.instanceId, arrItemId: target.arrItemId });
						}}
					/>
				)}

				{activeTab === "approvals" && (
					<ApprovalsTab
						onExplain={(target) => {
							setExplainTarget(target);
							explain.mutate({ instanceId: target.instanceId, arrItemId: target.arrItemId });
						}}
					/>
				)}
				{activeTab === "logs" && <LogsTab />}
				{activeTab === "statistics" && <StatisticsTab />}
			</div>

			{/* Explain Dialog — shared across tabs */}
			<ExplainDialog
				target={explainTarget}
				data={explain.data ?? null}
				isPending={explain.isPending}
				onClose={() => setExplainTarget(null)}
			/>
		</>
	);
}

// ============================================================================
// Staleness Score Helpers
// ============================================================================

function extractStalenessScore(reason: string): number | null {
	const match = reason.match(/^Staleness score ([\d.]+)\s*>/);
	return match ? Number(match[1]) : null;
}

function stalenessVariant(score: number): "success" | "warning" | "danger" {
	if (score < 30) return "success";
	if (score <= 70) return "warning";
	return "danger";
}

// ============================================================================
// Config Tab
// ============================================================================

function ConfigTab({
	config,
	gradient,
	onUpdateConfig,
	onPreview,
	onExecute,
	previewData,
	isPreviewLoading,
	isExecuting,
	executeResult,
	previewError,
	executeError,
	onExplain,
}: {
	config: NonNullable<ReturnType<typeof useCleanupConfig>["data"]>;
	gradient: { from: string; fromLight: string };
	onUpdateConfig: (data: Record<string, unknown>) => void;
	onPreview: () => void;
	onExecute: () => void;
	previewData?: CleanupPreviewResponse;
	isPreviewLoading: boolean;
	isExecuting: boolean;
	executeResult?: { itemsRemoved: number; itemsFlagged: number; itemsUnmonitored?: number; itemsFilesDeleted?: number; status: string };
	previewError?: Error | null;
	executeError?: Error | null;
	onExplain: (target: ExplainTarget) => void;
}) {
	const createRule = useCreateCleanupRule();
	const updateRule = useUpdateCleanupRule();
	const deleteRule = useDeleteCleanupRule();
	const reorderRules = useReorderCleanupRules();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingRule, setEditingRule] = useState<CleanupRuleResponse | null>(null);
	const [confirmRunOpen, setConfirmRunOpen] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

	// Local state for numeric inputs (onBlur commit pattern — F7)
	const [localInterval, setLocalInterval] = useState(String(config.intervalHours));
	const [localMaxRemovals, setLocalMaxRemovals] = useState(String(config.maxRemovalsPerRun ?? 50));
	useEffect(() => { setLocalInterval(String(config.intervalHours)); }, [config.intervalHours]);
	useEffect(() => { setLocalMaxRemovals(String(config.maxRemovalsPerRun ?? 50)); }, [config.maxRemovalsPerRun]);

	const actionCounts = useMemo(() => {
		if (!previewData?.items) return null;
		const counts = { delete: 0, unmonitor: 0, delete_files: 0 };
		for (const item of previewData.items) {
			const action = item.action ?? "delete";
			if (action === "unmonitor") counts.unmonitor++;
			else if (action === "delete_files") counts.delete_files++;
			else counts.delete++;
		}
		return counts;
	}, [previewData]);

	const handleCreate = () => {
		setEditingRule(null);
		setDialogOpen(true);
	};

	const handleEdit = (rule: CleanupRuleResponse) => {
		setEditingRule(rule);
		setDialogOpen(true);
	};

	const handleMoveRule = (index: number, direction: "up" | "down") => {
		if (!config) return;
		const ids = config.rules.map((r) => r.id);
		const target = direction === "up" ? index - 1 : index + 1;
		if (target < 0 || target >= ids.length) return;
		[ids[index], ids[target]] = [ids[target]!, ids[index]!];
		reorderRules.mutate(ids);
	};

	const handleSave = (data: CreateCleanupRule) => {
		if (editingRule) {
			updateRule.mutate({ id: editingRule.id, data }, { onSuccess: () => setDialogOpen(false) });
		} else {
			createRule.mutate(data, {
				onSuccess: () => setDialogOpen(false),
			});
		}
	};

	return (
		<div className="space-y-6">
			{/* Global settings */}
			<GlassmorphicCard padding="md">
				<h3 className="text-h4 mb-4">Settings</h3>
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={config.enabled}
							onChange={(e) => onUpdateConfig({ enabled: e.target.checked })}
						/>
						Enabled
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={config.dryRunMode}
							onChange={(e) => onUpdateConfig({ dryRunMode: e.target.checked })}
						/>
						Dry Run Mode
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={config.requireApproval}
							onChange={(e) => onUpdateConfig({ requireApproval: e.target.checked })}
						/>
						Require Approval
					</label>
					<label className="block">
						<span className="text-xs text-muted-foreground block mb-1">Interval (hours)</span>
						<input
							type="number"
							value={localInterval}
							onChange={(e) => setLocalInterval(e.target.value)}
							onBlur={() => {
								const v = Number(localInterval);
								if (!Number.isNaN(v) && v >= 1 && v <= 168 && v !== config.intervalHours) {
									onUpdateConfig({ intervalHours: v });
								} else {
									setLocalInterval(String(config.intervalHours));
								}
							}}
							min={1}
							max={168}
							className="w-full rounded-md border border-border/50 bg-background/50 px-3 py-1.5 text-sm"
						/>
					</label>
					<label className="block">
						<span className="text-xs text-muted-foreground block mb-1">Max Removals / Run</span>
						<input
							type="number"
							value={localMaxRemovals}
							onChange={(e) => setLocalMaxRemovals(e.target.value)}
							onBlur={() => {
								const v = Number(localMaxRemovals);
								if (!Number.isNaN(v) && v >= 1 && v <= 100 && v !== (config.maxRemovalsPerRun ?? 50)) {
									onUpdateConfig({ maxRemovalsPerRun: v });
								} else {
									setLocalMaxRemovals(String(config.maxRemovalsPerRun ?? 50));
								}
							}}
							min={1}
							max={100}
							className="w-full rounded-md border border-border/50 bg-background/50 px-3 py-1.5 text-sm"
						/>
					</label>
				</div>

				{config.dryRunMode && (
					<div className="mt-3 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-400">
						Dry run mode is active. No items will be removed.
					</div>
				)}
			</GlassmorphicCard>

			{/* Actions */}
			<div className="flex items-center gap-3">
				<GradientButton onClick={onPreview} disabled={isPreviewLoading}>
					{isPreviewLoading ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<Eye className="mr-2 h-4 w-4" />
					)}
					Preview
				</GradientButton>
				<GradientButton
					variant="secondary"
					onClick={() => setConfirmRunOpen(true)}
					disabled={isExecuting || !config.enabled}
				>
					{isExecuting ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<Play className="mr-2 h-4 w-4" />
					)}
					Run Now
				</GradientButton>

				{/* Confirmation dialog for destructive cleanup execution */}
				<Dialog open={confirmRunOpen} onOpenChange={setConfirmRunOpen}>
					<DialogContent className="max-w-md">
						<DialogHeader>
							<DialogTitle>Run Library Cleanup?</DialogTitle>
							<DialogDescription>
								This will evaluate your library against all enabled rules and{" "}
								{config.dryRunMode
									? "flag matching items (dry run mode — nothing will be removed)."
									: config.requireApproval
										? "queue matching items for approval."
										: "remove or unmonitor matching items. This action cannot be undone."}
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<GradientButton variant="secondary" onClick={() => setConfirmRunOpen(false)}>
								Cancel
							</GradientButton>
							<GradientButton
								onClick={() => {
									setConfirmRunOpen(false);
									onExecute();
								}}
							>
								{config.dryRunMode ? "Run Preview" : config.requireApproval ? "Run & Queue" : "Run & Execute"}
							</GradientButton>
						</DialogFooter>
					</DialogContent>
				</Dialog>

				{executeResult && (
					<span className="text-sm text-muted-foreground">
						{executeResult.status === "completed"
							? `Done: ${executeResult.itemsFlagged} flagged, ${executeResult.itemsRemoved} removed${executeResult.itemsUnmonitored ? `, ${executeResult.itemsUnmonitored} unmonitored` : ""}${executeResult.itemsFilesDeleted ? `, ${executeResult.itemsFilesDeleted} files deleted` : ""}`
							: `Status: ${executeResult.status}`}
					</span>
				)}
			</div>

			{/* Mutation errors */}
			{previewError && (
				<div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
					Preview failed: {previewError.message}
				</div>
			)}
			{executeError && (
				<div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
					Execution failed: {executeError.message}
				</div>
			)}

			{/* Preview results */}
			{previewData && (
				<GlassmorphicCard padding="md">
					<h4 className="text-h4 mb-3">
						Preview Results ({previewData.totalFlagged} of {previewData.totalEvaluated} items
						flagged)
					</h4>
					{previewData.prefetchHealth && Object.entries(previewData.prefetchHealth).some(([, s]) => s === "failed") && (
						<div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
							<span className="font-medium">Data source issues:</span>{" "}
							{Object.entries(previewData.prefetchHealth)
								.filter(([, s]) => s === "failed")
								.map(([k]) => k)
								.join(", ")}{" "}
							failed to load. Some rules may have been skipped.
						</div>
					)}
					{previewData.warnings && previewData.warnings.length > 0 && (
						<div className="mb-3 space-y-1">
							{previewData.warnings.map((w, i) => (
								<div key={i} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
									{w}
								</div>
							))}
						</div>
					)}
					{actionCounts && previewData.items.length > 0 && (
						<div className="flex flex-wrap gap-2 mb-3">
							{actionCounts.delete > 0 && (
								<StatusBadge status="error">{actionCounts.delete} Delete</StatusBadge>
							)}
							{actionCounts.unmonitor > 0 && (
								<StatusBadge status="warning">{actionCounts.unmonitor} Unmonitor</StatusBadge>
							)}
							{actionCounts.delete_files > 0 && (
								<StatusBadge status="info">{actionCounts.delete_files} Delete Files</StatusBadge>
							)}
						</div>
					)}
					{previewData.items.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No items would be flagged with current rules.
						</p>
					) : (
						<div className="max-h-80 overflow-y-auto space-y-2">
							{previewData.items.map((item, i) => {
								const score = extractStalenessScore(item.reason);
								return (
									<div
										key={`${item.title}-${i}`}
										className="flex items-center justify-between rounded-md bg-card/20 px-3 py-2 text-sm"
									>
										<span className="truncate">{item.title}</span>
										<div className="flex items-center gap-2 shrink-0 ml-3">
											<button
												type="button"
												onClick={() => onExplain({
													instanceId: item.instanceId,
													arrItemId: item.arrItemId,
													title: item.title,
												})}
												className="rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
												title="Explain why this item was flagged"
											>
												<HelpCircle className="h-3.5 w-3.5" />
											</button>
											{item.action !== "delete" && (
												<StatusBadge status={item.action === "unmonitor" ? "warning" : "info"}>
													{item.action === "unmonitor" ? "Unmonitor" : "Delete Files"}
												</StatusBadge>
											)}
											{score != null ? (
												<div className="flex items-center gap-2 min-w-[160px]">
													<PremiumProgress
														value={score}
														max={100}
														variant={stalenessVariant(score)}
														size="sm"
														className="w-20"
													/>
													<span className="text-xs text-muted-foreground whitespace-nowrap">
														{score.toFixed(0)}%
													</span>
												</div>
											) : (
												<span className="text-xs text-muted-foreground">
													{item.matchedRuleName}: {item.reason}
												</span>
											)}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</GlassmorphicCard>
			)}

			{/* Rules */}
			<GlassmorphicCard padding="md">
				<div className="flex items-center justify-between mb-4">
					<h3 className="text-h4">Cleanup Rules</h3>
					<GradientButton onClick={handleCreate}>
						<Plus className="mr-2 h-4 w-4" />
						Add Rule
					</GradientButton>
				</div>

				{config.rules.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4 text-center">
						No rules configured. Add a rule to start cleaning up your library.
					</p>
				) : (
					<div className="space-y-2">
						{config.rules.map((rule, index) => (
							<div
								key={rule.id}
								className="flex items-center gap-3 rounded-lg border border-border/30 bg-card/20 px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300"
								style={{
									animationDelay: `${index * 30}ms`,
									animationFillMode: "backwards",
								}}
							>
								<div className="flex flex-col -my-1">
									<button
										type="button"
										disabled={index === 0 || reorderRules.isPending}
										onClick={() => handleMoveRule(index, "up")}
										className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
										aria-label="Move rule up"
									>
										<ChevronUp className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										disabled={index === config.rules.length - 1 || reorderRules.isPending}
										onClick={() => handleMoveRule(index, "down")}
										className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
										aria-label="Move rule down"
									>
										<ChevronDown className="h-3.5 w-3.5" />
									</button>
								</div>
								<div
									className="h-2 w-2 rounded-full shrink-0"
									style={{
										backgroundColor: rule.enabled ? gradient.from : "var(--color-muted-foreground)",
									}}
								/>
								<div className="flex-1 min-w-0">
									<span className="font-medium text-sm">{rule.name}</span>
									<span className="text-xs text-muted-foreground ml-2">{rule.operator ? `${rule.operator} (${(rule.conditions as unknown[])?.length ?? 0} conditions)` : rule.ruleType}</span>
									{rule.serviceFilter && rule.serviceFilter.length > 0 && (
										<span className="text-xs text-muted-foreground ml-2">
											({rule.serviceFilter.join(", ")})
										</span>
									)}
								</div>
								{rule.retentionMode && (
									<span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-500/20">
										<Shield className="h-3 w-3" />
										Protection
									</span>
								)}
								{rule.action && rule.action !== "delete" && !rule.retentionMode && (
									<StatusBadge status={rule.action === "unmonitor" ? "warning" : "info"}>
										{rule.action === "unmonitor" ? "Unmonitor" : "Delete Files"}
									</StatusBadge>
								)}
								<StatusBadge status={rule.enabled ? "success" : "default"}>
									{rule.enabled ? "Active" : "Off"}
								</StatusBadge>
								<button
									type="button"
									onClick={() => handleEdit(rule)}
									className="rounded-md p-1.5 text-muted-foreground hover:text-foreground transition-colors"
									aria-label={`Edit rule: ${rule.name}`}
								>
									<Pencil className="h-3.5 w-3.5" />
								</button>
								{deleteTarget === rule.id ? (
									<div className="flex items-center gap-1.5">
										<span className="text-xs text-muted-foreground">Confirm?</span>
										<button
											type="button"
											onClick={() => { deleteRule.mutate(rule.id); setDeleteTarget(null); }}
											className="text-xs font-medium text-red-400 hover:text-red-300 transition-colors"
										>
											Yes
										</button>
										<button
											type="button"
											onClick={() => setDeleteTarget(null)}
											className="text-xs text-muted-foreground hover:text-foreground transition-colors"
										>
											No
										</button>
									</div>
								) : (
									<button
										type="button"
										onClick={() => setDeleteTarget(rule.id)}
										className="text-xs text-muted-foreground hover:text-red-400 transition-colors"
										aria-label={`Delete rule: ${rule.name}`}
									>
										Delete
									</button>
								)}
							</div>
						))}
					</div>
				)}
			</GlassmorphicCard>

			{/* Rule Dialog */}
			<CleanupRuleDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				editRule={editingRule}
				onSave={handleSave}
				isSaving={createRule.isPending || updateRule.isPending}
			/>
		</div>
	);
}

// ============================================================================
// Approvals Tab
// ============================================================================

function ApprovalsTab({ onExplain }: { onExplain: (target: ExplainTarget) => void }) {
	const { gradient } = useThemeGradient();
	const [page, setPage] = useState(1);
	const [statusFilter, setStatusFilter] = useState("pending");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const { data, isLoading, isError, refetch } = useCleanupApprovalQueue(page, 20, statusFilter);
	const approve = useApproveCleanupItem();
	const reject = useRejectCleanupItem();
	const bulkAction = useBulkCleanupAction();

	const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

	// Clear selection on page/filter change
	useEffect(() => {
		setSelectedIds(new Set());
	}, [page, statusFilter]);

	const toggleItem = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const toggleAll = useCallback(() => {
		if (!data) return;
		setSelectedIds((prev) => {
			if (prev.size === data.items.length) return new Set();
			return new Set(data.items.map((i) => i.id));
		});
	}, [data]);

	const handleBulkAction = useCallback((action: "approved" | "rejected") => {
		const ids = [...selectedIds];
		bulkAction.mutate({ ids, action }, {
			onSuccess: () => setSelectedIds(new Set()),
		});
	}, [selectedIds, bulkAction]);

	const showCheckboxes = statusFilter === "pending" && data && data.items.length > 0;
	const allSelected = showCheckboxes && data ? selectedIds.size === data.items.length && data.items.length > 0 : false;

	return (
		<div className="space-y-4">
			{/* Status filter + select-all */}
			<div className="flex items-center gap-3">
				<div className="flex items-center gap-2">
					{["pending", "approved", "rejected", "expired"].map((s) => (
						<button
							key={s}
							type="button"
							onClick={() => { setStatusFilter(s); setPage(1); }}
							aria-pressed={statusFilter === s}
							className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
								statusFilter === s
									? "bg-primary/20 text-primary border border-primary/30"
									: "bg-card/30 text-muted-foreground hover:bg-card/50 border border-border/30"
							}`}
						>
							{s.charAt(0).toUpperCase() + s.slice(1)}
						</button>
					))}
				</div>
				{showCheckboxes && (
					<button
						type="button"
						role="checkbox"
						aria-checked={allSelected}
						aria-label="Select all items"
						onClick={toggleAll}
						className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
					>
						<div className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
							allSelected
								? "border-primary bg-primary/20"
								: "border-border/50 bg-card/30"
						}`}>
							{allSelected && <Check className="h-3 w-3 text-primary" />}
						</div>
						Select all
					</button>
				)}
			</div>

			{/* Bulk action bar */}
			{selectedIds.size > 0 && (
				<BulkActionBar
					count={selectedIds.size}
					gradient={gradient}
					isPending={bulkAction.isPending}
					onApprove={() => handleBulkAction("approved")}
					onReject={() => handleBulkAction("rejected")}
				/>
			)}

			{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
				</div>
			) : isError ? (
				<GlassmorphicCard padding="lg">
					<div className="text-center py-8">
						<AlertTriangle className="mx-auto mb-3 h-10 w-10 text-amber-400/50" />
						<p className="text-muted-foreground mb-3">Failed to load approval queue. Please try again.</p>
						<button
							type="button"
							onClick={() => refetch()}
							className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
						>
							<RefreshCw className="h-3 w-3" />
							Retry
						</button>
					</div>
				</GlassmorphicCard>
			) : !data || data.items.length === 0 ? (
				<GlassmorphicCard padding="lg">
					<div className="text-center py-8">
						<ListChecks className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
						<p className="text-muted-foreground">No {statusFilter} approvals.</p>
					</div>
				</GlassmorphicCard>
			) : (
				<>
					<div className="space-y-3">
						{data.items.map((item, index) => (
							<GlassmorphicCard key={item.id} padding="sm">
								<div
									className="flex items-center gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300"
									style={{
										animationDelay: `${index * 30}ms`,
										animationFillMode: "backwards",
									}}
								>
									{/* Checkbox (pending only) */}
									{showCheckboxes && (
										<button
											type="button"
											role="checkbox"
											aria-checked={selectedIds.has(item.id)}
											aria-label={`Select ${item.title}`}
											onClick={() => toggleItem(item.id)}
											className="shrink-0"
										>
											<div className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
												selectedIds.has(item.id)
													? "border-primary bg-primary/20"
													: "border-border/50 bg-card/30 hover:border-border"
											}`}>
												{selectedIds.has(item.id) && <Check className="h-3 w-3 text-primary" />}
											</div>
										</button>
									)}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											{item.itemType === "series" ? (
												<Tv className="h-3.5 w-3.5 text-cyan-400 shrink-0" aria-label="Series" />
											) : (
												<Film className="h-3.5 w-3.5 text-orange-400 shrink-0" aria-label="Movie" />
											)}
											<span className="font-medium truncate">{item.title}</span>
											{item.year && <span className="text-xs text-muted-foreground">({item.year})</span>}
											{item.instanceLabel && (
												<span className="inline-flex rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground border border-border/30">
													{item.instanceLabel}
												</span>
											)}
											{item.action && item.action !== "delete" && (
												<StatusBadge status={item.action === "unmonitor" ? "warning" : "info"}>
													{item.action === "unmonitor" ? "Unmonitor" : "Delete Files"}
												</StatusBadge>
											)}
										</div>
										<p className="text-xs text-muted-foreground mt-0.5">
											{item.matchedRuleName}: {item.reason}
										</p>
									</div>
									<span className="text-xs text-muted-foreground shrink-0">
										{(Number(item.sizeOnDisk) / 1073741824).toFixed(1)} GB
									</span>
									{/* Why? button */}
									<button
										type="button"
										onClick={() => onExplain({
											instanceId: item.instanceId,
											arrItemId: item.arrItemId,
											title: item.title,
										})}
										className="rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
										title="Explain why this item was flagged"
									>
										<HelpCircle className="h-3.5 w-3.5" />
									</button>
									{statusFilter === "pending" && (
										<div className="flex gap-2">
											<button
												type="button"
												onClick={() => approve.mutate(item.id)}
												disabled={approve.isPending}
												className="rounded-md px-3 py-1 text-xs font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
											>
												Approve
											</button>
											<button
												type="button"
												onClick={() => reject.mutate(item.id)}
												disabled={reject.isPending}
												className="rounded-md px-3 py-1 text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
											>
												Reject
											</button>
										</div>
									)}
								</div>
							</GlassmorphicCard>
						))}
					</div>

					{/* Pagination */}
					{totalPages > 1 && (
						<div className="flex items-center justify-center gap-2 pt-2">
							<button
								type="button"
								disabled={page <= 1}
								onClick={() => setPage(page - 1)}
								className="rounded-md p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
							>
								<ChevronLeft className="h-4 w-4" />
							</button>
							<span className="text-xs text-muted-foreground">
								Page {page} of {totalPages}
							</span>
							<button
								type="button"
								disabled={page >= totalPages}
								onClick={() => setPage(page + 1)}
								className="rounded-md p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
							>
								<ChevronRight className="h-4 w-4" />
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

// ============================================================================
// Logs Tab
// ============================================================================

interface LogDetail {
	title: string;
	rule: string;
	reason: string;
	action?: string;
	status?: string;
}

function LogsTab() {
	const [page, setPage] = useState(1);
	const [logStatusFilter, setLogStatusFilter] = useState<string | undefined>(undefined);
	const [sinceFilter, setSinceFilter] = useState("");
	const [untilFilter, setUntilFilter] = useState("");
	const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

	const logFilters = useMemo(() => {
		const f: { status?: string; since?: string; until?: string } = {};
		if (logStatusFilter) f.status = logStatusFilter;
		if (sinceFilter) f.since = sinceFilter;
		if (untilFilter) f.until = untilFilter;
		return Object.keys(f).length > 0 ? f : undefined;
	}, [logStatusFilter, sinceFilter, untilFilter]);

	const { data, isLoading, isError, refetch } = useCleanupLogs(page, 20, logFilters);
	const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

	return (
		<div className="space-y-4">
			{/* Log status filter + date range — always visible */}
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex items-center gap-2">
					{[undefined, "completed", "partial", "error"].map((s) => (
						<button
							key={s ?? "all"}
							type="button"
							onClick={() => { setLogStatusFilter(s); setPage(1); }}
							aria-pressed={logStatusFilter === s}
							className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
								logStatusFilter === s
									? "bg-primary/20 text-primary border border-primary/30"
									: "bg-card/30 text-muted-foreground hover:bg-card/50 border border-border/30"
							}`}
						>
							{s ? s.charAt(0).toUpperCase() + s.slice(1) : "All"}
						</button>
					))}
				</div>
				<div className="flex items-center gap-2">
					<div className="flex flex-col gap-1">
						<label htmlFor="log-since" className="text-[10px] text-muted-foreground">From</label>
						<Input
							id="log-since"
							type="date"
							value={sinceFilter}
							onChange={(e) => { setSinceFilter(e.target.value); setPage(1); }}
							className="h-8 w-[140px] bg-background/50 border-border/50 text-xs"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<label htmlFor="log-until" className="text-[10px] text-muted-foreground">To</label>
						<Input
							id="log-until"
							type="date"
							value={untilFilter}
							onChange={(e) => { setUntilFilter(e.target.value); setPage(1); }}
							className="h-8 w-[140px] bg-background/50 border-border/50 text-xs"
						/>
					</div>
				</div>
			</div>

		{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
				</div>
			) : isError ? (
				<GlassmorphicCard padding="lg">
					<div className="text-center py-8">
						<AlertTriangle className="mx-auto mb-3 h-10 w-10 text-amber-400/50" />
						<p className="text-muted-foreground mb-3">Failed to load activity logs. Please try again.</p>
						<button
							type="button"
							onClick={() => refetch()}
							className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
						>
							<RefreshCw className="h-3 w-3" />
							Retry
						</button>
					</div>
				</GlassmorphicCard>
			) : !data || data.items.length === 0 ? (
				<GlassmorphicCard padding="lg">
					<div className="text-center py-8">
						<ScrollText className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
						<p className="text-muted-foreground">No cleanup runs yet.</p>
					</div>
				</GlassmorphicCard>
			) : (
				<>
				<GlassmorphicCard padding="none">
			<div className="overflow-x-auto">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b border-border/30">
							<th className="px-4 py-3 text-left text-muted-foreground font-medium">Date</th>
							<th className="px-4 py-3 text-left text-muted-foreground font-medium">Status</th>
							<th className="px-4 py-3 text-right text-muted-foreground font-medium">Evaluated</th>
							<th className="px-4 py-3 text-right text-muted-foreground font-medium">Flagged</th>
							<th className="px-4 py-3 text-right text-muted-foreground font-medium">Removed</th>
							<th className="px-4 py-3 text-right text-muted-foreground font-medium">Unmonitored</th>
							<th className="px-4 py-3 text-right text-muted-foreground font-medium">Files Del.</th>
							<th className="px-4 py-3 text-right text-muted-foreground font-medium">Duration</th>
						</tr>
					</thead>
					<tbody>
						{data.items.map((log) => {
							const details = (Array.isArray(log.details) ? log.details : []) as unknown as LogDetail[];
							const isExpanded = expandedLogId === log.id;
							return (
								<React.Fragment key={log.id}>
									<tr
										role="button"
										tabIndex={0}
										aria-expanded={isExpanded}
										className="border-b border-border/10 hover:bg-card/20 cursor-pointer"
										onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												setExpandedLogId(isExpanded ? null : log.id);
											}
										}}
									>
										<td className="px-4 py-2.5 text-xs whitespace-nowrap">
											{new Date(log.startedAt).toLocaleString()}
										</td>
										<td className="px-4 py-2.5">
											<StatusBadge
												status={
													log.status === "completed"
														? "success"
														: log.status === "error"
															? "error"
															: "warning"
												}
											>
												{log.isDryRun ? "dry run" : log.status}
											</StatusBadge>
										</td>
										<td className="px-4 py-2.5 text-right">{log.itemsEvaluated}</td>
										<td className="px-4 py-2.5 text-right">{log.itemsFlagged}</td>
										<td className="px-4 py-2.5 text-right">{log.itemsRemoved}</td>
										<td className="px-4 py-2.5 text-right">{log.itemsUnmonitored}</td>
										<td className="px-4 py-2.5 text-right">{log.itemsFilesDeleted}</td>
										<td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
											{log.durationMs ? `${(log.durationMs / 1000).toFixed(1)}s` : "-"}
										</td>
									</tr>
									{isExpanded && details.length > 0 && (
										<tr key={`${log.id}-details`}>
											<td colSpan={8} className="px-4 py-3 bg-card/10">
												<div className="space-y-1.5 max-h-64 overflow-y-auto">
													{details.map((d, i) => (
														<div key={i} className="flex items-center gap-2 text-xs">
															<span className="text-foreground font-medium truncate max-w-[200px]">
																{d.title}
															</span>
															<span className="text-muted-foreground">—</span>
															<span className="text-muted-foreground">{d.rule}</span>
															<span className="text-muted-foreground/70 truncate">
																{d.reason}
															</span>
															{d.action && d.action !== "delete" && (
																<StatusBadge
																	status={d.action === "unmonitor" ? "warning" : "info"}
																>
																	{d.action}
																</StatusBadge>
															)}
															{d.status && d.status !== "pending" && (
																<StatusBadge
																	status={
																		d.status === "executed" || d.status === "removed"
																			? "success"
																			: d.status === "error"
																				? "error"
																				: "info"
																	}
																>
																	{d.status}
																</StatusBadge>
															)}
														</div>
													))}
												</div>
											</td>
										</tr>
									)}
								</React.Fragment>
							);
						})}
					</tbody>
				</table>
			</div>
		</GlassmorphicCard>

			{totalPages > 1 && (
				<div className="flex items-center justify-between pt-2">
					<span className="text-xs text-muted-foreground">
						Page {page} of {totalPages}
					</span>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => setPage((p) => Math.max(1, p - 1))}
							disabled={page <= 1}
							className="rounded-md p-1.5 border border-border/30 bg-card/30 text-muted-foreground hover:bg-card/50 disabled:opacity-40"
						>
							<ChevronLeft className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
							disabled={page >= totalPages}
							className="rounded-md p-1.5 border border-border/30 bg-card/30 text-muted-foreground hover:bg-card/50 disabled:opacity-40"
						>
							<ChevronRight className="h-4 w-4" />
						</button>
					</div>
				</div>
			)}
			</>
			)}
		</div>
	);
}

// ============================================================================
// Statistics Tab
// ============================================================================

const PERIOD_OPTIONS = [
	{ label: "30d", days: 30 },
	{ label: "90d", days: 90 },
	{ label: "180d", days: 180 },
	{ label: "365d", days: 365 },
] as const;

function StatisticsTab() {
	const { gradient } = useThemeGradient();
	const [days, setDays] = useState(30);
	const { data: stats, isLoading, isError, refetch } = useCleanupStatistics(days);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (isError) {
		return (
			<GlassmorphicCard padding="lg">
				<div className="text-center py-8">
					<AlertTriangle className="mx-auto mb-3 h-10 w-10 text-amber-400/50" />
					<p className="text-muted-foreground mb-3">Failed to load statistics. Please try again.</p>
					<button
						type="button"
						onClick={() => refetch()}
						className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
					>
						<RefreshCw className="h-3 w-3" />
						Retry
					</button>
				</div>
			</GlassmorphicCard>
		);
	}

	if (!stats) {
		return (
			<GlassmorphicCard padding="lg">
				<div className="text-center py-8">
					<BarChart3 className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
					<p className="text-muted-foreground">No statistics available yet.</p>
				</div>
			</GlassmorphicCard>
		);
	}

	const maxRuleCount = Math.max(...stats.ruleEffectiveness.map((r) => r.matchCount), 1);

	return (
		<div className="space-y-6">
			{/* Period selector */}
			<div className="flex items-center gap-2">
				{PERIOD_OPTIONS.map((opt) => (
					<button
						key={opt.days}
						type="button"
						onClick={() => setDays(opt.days)}
						aria-pressed={days === opt.days}
						className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
							days === opt.days
								? "bg-primary/20 text-primary border border-primary/30"
								: "bg-card/30 text-muted-foreground hover:bg-card/50 border border-border/30"
						}`}
					>
						{opt.label}
					</button>
				))}
			</div>

			{/* Stat cards grid */}
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard
					label="Total Runs"
					value={stats.totalRuns}
					gradient={gradient}
					sub={`${stats.successfulRuns} success / ${stats.partialRuns} partial / ${stats.failedRuns} failed`}
				/>
				<StatCard label="Items Evaluated" value={stats.totalItemsEvaluated} gradient={gradient} />
				<StatCard label="Items Flagged" value={stats.totalItemsFlagged} gradient={gradient} />
				<StatCard
					label="Items Actioned"
					value={stats.totalItemsRemoved + stats.totalItemsUnmonitored}
					gradient={gradient}
					sub={`${stats.totalItemsRemoved} removed, ${stats.totalItemsUnmonitored} unmonitored${stats.totalFilesDeleted ? `, ${stats.totalFilesDeleted} files` : ""}`}
				/>
			</div>

			{/* Rule Effectiveness */}
			<PremiumSection title="Rule Effectiveness">
				{stats.ruleEffectiveness.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4 text-center">
						No rule match data in this period.
					</p>
				) : (
					<div className="space-y-3">
						{stats.ruleEffectiveness.map((rule, index) => {
							const barWidth = (rule.matchCount / maxRuleCount) * 100;
							return (
								<div
									key={rule.ruleId}
									className="animate-in fade-in slide-in-from-left-2 duration-300"
									style={{ animationDelay: `${index * 50}ms`, animationFillMode: "backwards" }}
								>
									<div className="flex items-center justify-between mb-1">
										<span className="text-sm font-medium text-foreground">{rule.ruleName}</span>
										<span className="text-xs text-muted-foreground">{rule.matchCount} matches</span>
									</div>
									<div className="h-2 rounded-full bg-card/50 overflow-hidden">
										<div
											className="h-full rounded-full transition-all duration-500"
											style={{
												width: `${barWidth}%`,
												background: `linear-gradient(90deg, ${gradient.from}, ${gradient.fromLight})`,
											}}
										/>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</PremiumSection>

			{/* Approval Funnel */}
			<PremiumSection title="Approval Funnel">
				<div className="flex flex-wrap gap-3">
					<FunnelChip label="Pending" count={stats.approvalFunnel.pending} color="amber" />
					<FunnelChip label="Approved" count={stats.approvalFunnel.approved} color="emerald" />
					<FunnelChip label="Rejected" count={stats.approvalFunnel.rejected} color="red" />
					<FunnelChip label="Expired" count={stats.approvalFunnel.expired} color="muted" />
				</div>
			</PremiumSection>
		</div>
	);
}

function StatCard({
	label,
	value,
	gradient,
	sub,
}: {
	label: string;
	value: number;
	gradient: { from: string; fromLight: string };
	sub?: string;
}) {
	return (
		<GlassmorphicCard padding="md">
			<p className="text-xs text-muted-foreground mb-1">{label}</p>
			<p className="text-2xl font-bold" style={{ color: gradient.from }}>
				{value.toLocaleString()}
			</p>
			{sub && <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>}
		</GlassmorphicCard>
	);
}

function FunnelChip({
	label,
	count,
	color,
}: {
	label: string;
	count: number;
	color: "amber" | "emerald" | "red" | "muted";
}) {
	const styles: Record<string, string> = {
		amber: "bg-amber-500/15 text-amber-400 border-amber-500/20",
		emerald: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
		red: "bg-red-500/15 text-red-400 border-red-500/20",
		muted: "bg-muted/30 text-muted-foreground border-border/30",
	};

	return (
		<span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border ${styles[color]}`}>
			{label}
			<span className="font-bold">{count}</span>
		</span>
	);
}

// ============================================================================
// Bulk Action Bar
// ============================================================================

function BulkActionBar({
	count,
	gradient,
	isPending,
	onApprove,
	onReject,
}: {
	count: number;
	gradient: { from: string; to: string; glow: string };
	isPending: boolean;
	onApprove: () => void;
	onReject: () => void;
}) {
	return (
		<div
			className="animate-in slide-in-from-top-2 fade-in duration-300 relative overflow-hidden rounded-xl border border-border/50 bg-card/80 backdrop-blur-xl"
			style={{ boxShadow: `0 4px 20px -4px ${gradient.glow}` }}
		>
			{/* Gradient accent bar */}
			<div
				className="absolute inset-x-0 top-0 h-0.5"
				style={{ background: `linear-gradient(90deg, ${gradient.from}, ${gradient.to})` }}
			/>

			<div className="flex items-center justify-between px-4 py-3">
				<div className="flex items-center gap-2">
					<div
						className="flex h-6 w-6 items-center justify-center rounded-full"
						style={{ background: `linear-gradient(135deg, ${gradient.from}20, ${gradient.to}20)` }}
					>
						<CheckCircle2 className="h-3.5 w-3.5" style={{ color: gradient.from }} />
					</div>
					<span className="text-sm font-medium text-foreground">
						{count} item{count === 1 ? "" : "s"} selected
					</span>
				</div>

				<div className="flex gap-2">
					<button
						type="button"
						onClick={onApprove}
						disabled={isPending}
						className="rounded-md px-3 py-1.5 text-xs font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
					>
						{isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Approve Selected"}
					</button>
					<button
						type="button"
						onClick={onReject}
						disabled={isPending}
						className="rounded-md px-3 py-1.5 text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
					>
						{isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Reject Selected"}
					</button>
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// Explain Dialog
// ============================================================================

function ExplainDialog({
	target,
	data,
	isPending,
	onClose,
}: {
	target: ExplainTarget | null;
	data: CleanupExplainResponse | null;
	isPending: boolean;
	onClose: () => void;
}) {
	return (
		<Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Rule Evaluation — {target?.title}</DialogTitle>
					<DialogDescription>
						How each cleanup rule evaluated this item.
					</DialogDescription>
				</DialogHeader>

				{isPending ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				) : data ? (
					<div className="space-y-2 max-h-80 overflow-y-auto">
						{data.results.map((r) => (
							<div
								key={r.ruleId}
								className="flex items-center gap-2 rounded-md bg-card/20 px-3 py-2 text-sm"
							>
								{r.filteredBy ? (
									<>
										<span className="text-muted-foreground/50 font-medium truncate">{r.ruleName}</span>
										<span className="ml-auto shrink-0 inline-flex items-center rounded-full bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground border border-border/30">
											Skipped: {r.filteredBy.replace(/_/g, " ")}
										</span>
									</>
								) : (
									<>
										<span className="font-medium truncate">{r.ruleName}</span>
										{r.retentionMode && <Shield className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
										<span className="ml-auto shrink-0">
											{r.matched ? (
												<span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
													<Check className="h-2.5 w-2.5" /> Matched
												</span>
											) : (
												<span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400/70 border border-red-500/15">
													<X className="h-2.5 w-2.5" /> No match
												</span>
											)}
										</span>
									</>
								)}
							</div>
						))}
						{data.results.length > 0 && data.results.some((r) => r.matched && r.reason) && (
							<div className="mt-2 space-y-1">
								{data.results.filter((r) => r.matched && r.reason).map((r) => (
									<p key={r.ruleId} className="text-xs text-muted-foreground">
										<span className="font-medium">{r.ruleName}:</span> {r.reason}
									</p>
								))}
							</div>
						)}
						{data.retentionProtected && (
							<div className="mt-3 rounded-md bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-xs text-emerald-400 flex items-center gap-2">
								<Shield className="h-4 w-4 shrink-0" />
								This item is protected by a retention rule.
							</div>
						)}
					</div>
				) : null}

				<DialogFooter>
					<GradientButton variant="secondary" onClick={onClose}>
						Close
					</GradientButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
