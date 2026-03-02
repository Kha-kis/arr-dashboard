"use client";

import type { CleanupRuleResponse, CreateCleanupRule } from "@arr/shared";
import {
	ChevronDown,
	ChevronUp,
	Eraser,
	Eye,
	ListChecks,
	Loader2,
	Pencil,
	Play,
	Plus,
	ScrollText,
	Settings2,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	GlassmorphicCard,
	GradientButton,
	PremiumPageHeader,
	PremiumPageLoading,
	type PremiumTab,
	PremiumTabs,
	StatusBadge,
} from "@/components/layout";
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
	useCleanupApprovalQueue,
	useCleanupConfig,
	useCleanupExecute,
	useCleanupLogs,
	useCleanupPreview,
	useCreateCleanupRule,
	useDeleteCleanupRule,
	useRejectCleanupItem,
	useReorderCleanupRules,
	useUpdateCleanupConfig,
	useUpdateCleanupRule,
} from "../../../hooks/api/useLibraryCleanup";
import { CleanupRuleDialog } from "./cleanup-rule-dialog";

type Tab = "config" | "approvals" | "logs";

const tabConfig: PremiumTab[] = [
	{ id: "config", label: "Rules & Config", icon: Settings2 },
	{ id: "approvals", label: "Approval Queue", icon: ListChecks },
	{ id: "logs", label: "Activity Log", icon: ScrollText },
];

export function LibraryCleanupClient() {
	const { gradient } = useThemeGradient();
	const [activeTab, setActiveTab] = useState<Tab>("config");
	const { data: config, isLoading } = useCleanupConfig();
	const updateConfig = useUpdateCleanupConfig();
	const preview = useCleanupPreview();
	const execute = useCleanupExecute();

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

			<div className="mt-6 space-y-6">
				{activeTab === "config" && config && (
					<ConfigTab
						config={config}
						gradient={gradient}
						onUpdateConfig={(data) => updateConfig.mutate(data)}
						onPreview={() => preview.mutate(undefined)}
						onExecute={() => execute.mutate(undefined)}
						previewData={preview.data}
						isPreviewLoading={preview.isPending}
						isExecuting={execute.isPending}
						executeResult={execute.data}
					/>
				)}

				{activeTab === "approvals" && <ApprovalsTab />}
				{activeTab === "logs" && <LogsTab />}
			</div>
		</>
	);
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
}: {
	config: NonNullable<ReturnType<typeof useCleanupConfig>["data"]>;
	gradient: { from: string; fromLight: string };
	onUpdateConfig: (data: Record<string, unknown>) => void;
	onPreview: () => void;
	onExecute: () => void;
	previewData?: { totalEvaluated: number; totalFlagged: number; items: unknown[] };
	isPreviewLoading: boolean;
	isExecuting: boolean;
	executeResult?: { itemsRemoved: number; itemsFlagged: number; itemsUnmonitored?: number; itemsFilesDeleted?: number; status: string };
}) {
	const createRule = useCreateCleanupRule();
	const updateRule = useUpdateCleanupRule();
	const deleteRule = useDeleteCleanupRule();
	const reorderRules = useReorderCleanupRules();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingRule, setEditingRule] = useState<CleanupRuleResponse | null>(null);
	const [confirmRunOpen, setConfirmRunOpen] = useState(false);

	const actionCounts = useMemo(() => {
		if (!previewData?.items) return null;
		const items = previewData.items as Array<Record<string, unknown>>;
		const counts = { delete: 0, unmonitor: 0, delete_files: 0 };
		for (const item of items) {
			const action = String(item.action ?? "delete");
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
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
							value={config.intervalHours}
							onChange={(e) => onUpdateConfig({ intervalHours: Number(e.target.value) })}
							min={1}
							max={168}
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

			{/* Preview results */}
			{previewData && (
				<GlassmorphicCard padding="md">
					<h4 className="text-h4 mb-3">
						Preview Results ({previewData.totalFlagged} of {previewData.totalEvaluated} items
						flagged)
					</h4>
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
							{(previewData.items as Array<Record<string, unknown>>).map((item, i) => (
								<div
									key={String(item.title) + String(i)}
									className="flex items-center justify-between rounded-md bg-card/20 px-3 py-2 text-sm"
								>
									<span className="truncate">{String(item.title)}</span>
									<div className="flex items-center gap-2 shrink-0 ml-3">
										{item.action != null && String(item.action) !== "delete" && (
											<StatusBadge status={String(item.action) === "unmonitor" ? "warning" : "info"}>
												{String(item.action) === "unmonitor" ? "Unmonitor" : "Delete Files"}
											</StatusBadge>
										)}
										<span className="text-xs text-muted-foreground">
											{String(item.matchedRuleName)}: {String(item.reason)}
										</span>
									</div>
								</div>
							))}
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
										title="Move up"
									>
										<ChevronUp className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										disabled={index === config.rules.length - 1 || reorderRules.isPending}
										onClick={() => handleMoveRule(index, "down")}
										className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
										title="Move down"
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
								{rule.action && rule.action !== "delete" && (
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
									title="Edit rule"
								>
									<Pencil className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									onClick={() => deleteRule.mutate(rule.id)}
									className="text-xs text-muted-foreground hover:text-red-400 transition-colors"
								>
									Delete
								</button>
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

function ApprovalsTab() {
	const [page] = useState(1);
	const { data, isLoading } = useCleanupApprovalQueue(page);
	const approve = useApproveCleanupItem();
	const reject = useRejectCleanupItem();

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!data || data.items.length === 0) {
		return (
			<GlassmorphicCard padding="lg">
				<div className="text-center py-8">
					<ListChecks className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
					<p className="text-muted-foreground">No pending approvals.</p>
				</div>
			</GlassmorphicCard>
		);
	}

	return (
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
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2">
								<span className="font-medium truncate">{item.title}</span>
								{item.year && <span className="text-xs text-muted-foreground">({item.year})</span>}
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
					</div>
				</GlassmorphicCard>
			))}
		</div>
	);
}

// ============================================================================
// Logs Tab
// ============================================================================

function LogsTab() {
	const [page] = useState(1);
	const { data, isLoading } = useCleanupLogs(page);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!data || data.items.length === 0) {
		return (
			<GlassmorphicCard padding="lg">
				<div className="text-center py-8">
					<ScrollText className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
					<p className="text-muted-foreground">No cleanup runs yet.</p>
				</div>
			</GlassmorphicCard>
		);
	}

	return (
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
						{data.items.map((log) => (
							<tr key={log.id} className="border-b border-border/10 hover:bg-card/20">
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
						))}
					</tbody>
				</table>
			</div>
		</GlassmorphicCard>
	);
}
