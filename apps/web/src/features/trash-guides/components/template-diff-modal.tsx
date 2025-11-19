"use client";

import { useState } from "react";
import {
	Dialog,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogContent,
	DialogFooter,
} from "../../../components/ui/dialog";
import { Skeleton } from "../../../components/ui";
import {
	AlertCircle,
	Plus,
	Minus,
	Edit,
	Check,
	X,
	GitCompare,
	ChevronDown,
	ChevronRight,
} from "lucide-react";
import { useTemplateDiff, useSyncTemplate } from "../../../hooks/api/useTemplateUpdates";
import { cn } from "../../../lib/utils";
import type { CustomFormatDiffItem } from "../../../lib/api-client/trash-guides";

interface TemplateDiffModalProps {
	open: boolean;
	onClose: () => void;
	templateId: string | null;
	templateName?: string;
	onSyncSuccess?: () => void;
}

type MergeStrategy = "keep_custom" | "sync_new" | "smart_merge";

export const TemplateDiffModal = ({
	open,
	onClose,
	templateId,
	templateName,
	onSyncSuccess,
}: TemplateDiffModalProps) => {
	const { data, isLoading, error } = useTemplateDiff(templateId);
	const syncTemplate = useSyncTemplate();
	const [selectedStrategy, setSelectedStrategy] = useState<MergeStrategy>("smart_merge");
	const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

	const toggleExpanded = (trashId: string) => {
		setExpandedItems((prev) => {
			const next = new Set(prev);
			if (next.has(trashId)) {
				next.delete(trashId);
			} else {
				next.add(trashId);
			}
			return next;
		});
	};

	const handleSync = async () => {
		if (!templateId) return;

		try {
			await syncTemplate.mutateAsync({
				templateId,
				payload: {
					strategy: selectedStrategy === "keep_custom" ? "keep_custom" : selectedStrategy === "sync_new" ? "replace" : "merge",
				},
			});
			onSyncSuccess?.();
			onClose();
		} catch (err) {
			console.error("Sync failed:", err);
		}
	};

	const getChangeTypeIcon = (changeType: string) => {
		switch (changeType) {
			case "added":
				return <Plus className="h-4 w-4 text-green-600 dark:text-green-400" />;
			case "removed":
				return <Minus className="h-4 w-4 text-red-600 dark:text-red-400" />;
			case "modified":
				return <Edit className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
			case "unchanged":
				return <Check className="h-4 w-4 text-gray-600 dark:text-gray-400" />;
			default:
				return null;
		}
	};

	const getChangeTypeColor = (changeType: string) => {
		switch (changeType) {
			case "added":
				return "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-300";
			case "removed":
				return "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300";
			case "modified":
				return "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300";
			case "unchanged":
				return "bg-gray-500/10 border-gray-500/30 text-gray-700 dark:text-gray-300";
			default:
				return "";
		}
	};

	const getStrategyDescription = (strategy: MergeStrategy) => {
		switch (strategy) {
			case "keep_custom":
				return "Keep all your custom modifications. Don't sync any changes from TRaSH Guides.";
			case "sync_new":
				return "Replace everything with latest TRaSH Guides. All custom modifications will be lost.";
			case "smart_merge":
				return "Add new Custom Formats and update specifications, but preserve your score overrides.";
		}
	};

	return (
		<Dialog open={open} onOpenChange={onClose} size="xl">
			<DialogHeader>
				<DialogTitle>
					<div className="flex items-center gap-2">
						<GitCompare className="h-5 w-5" />
						Template Update Changes
					</div>
				</DialogTitle>
				<DialogDescription>
					Review changes between your template and the latest TRaSH Guides
					{templateName && ` for "${templateName}"`}
				</DialogDescription>
			</DialogHeader>

			<DialogContent className="space-y-4">
				{isLoading && (
					<div className="space-y-4">
						<Skeleton className="h-24 w-full" />
						<Skeleton className="h-48 w-full" />
					</div>
				)}

				{error && (
					<div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
						<div className="flex items-start gap-3">
							<AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
							<div>
								<p className="text-sm font-medium text-fg">Failed to load diff</p>
								<p className="text-sm text-fg-muted mt-1">
									{error instanceof Error ? error.message : "Please try again"}
								</p>
							</div>
						</div>
					</div>
				)}

				{data?.data && (
					<>
						{/* Summary Statistics */}
						<div className="rounded-lg border border-border bg-bg-subtle p-4">
							<h3 className="text-sm font-medium text-fg mb-3">Change Summary</h3>
							<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
								<div className="space-y-1">
									<p className="text-xs text-fg-muted">Total Changes</p>
									<p className="text-2xl font-semibold text-fg">
										{data.data.summary.totalChanges}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs text-green-700 dark:text-green-300">Added</p>
									<p className="text-2xl font-semibold text-green-600 dark:text-green-400">
										{data.data.summary.addedCFs}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs text-amber-700 dark:text-amber-300">Modified</p>
									<p className="text-2xl font-semibold text-amber-600 dark:text-amber-400">
										{data.data.summary.modifiedCFs}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs text-red-700 dark:text-red-300">Removed</p>
									<p className="text-2xl font-semibold text-red-600 dark:text-red-400">
										{data.data.summary.removedCFs}
									</p>
								</div>
							</div>

							{data.data.hasUserModifications && (
								<div className="mt-3 pt-3 border-t border-border">
									<div className="flex items-center gap-2 text-sm">
										<AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
										<span className="text-fg-muted">
											This template has custom modifications
										</span>
									</div>
								</div>
							)}
						</div>

						{/* Merge Strategy Selection */}
						<div className="space-y-3">
							<h3 className="text-sm font-medium text-fg">Merge Strategy</h3>
							<div className="grid gap-3">
								{(["keep_custom", "sync_new", "smart_merge"] as MergeStrategy[]).map(
									(strategy) => (
										<button
											key={strategy}
											type="button"
											onClick={() => setSelectedStrategy(strategy)}
											className={cn(
												"text-left rounded-lg border p-4 transition-all",
												selectedStrategy === strategy
													? "border-primary bg-primary/10 ring-2 ring-primary/20"
													: "border-border hover:border-border-hover",
											)}
										>
											<div className="flex items-start gap-3">
												<div className="mt-0.5">
													{selectedStrategy === strategy ? (
														<div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center">
															<Check className="h-3 w-3 text-white" />
														</div>
													) : (
														<div className="h-5 w-5 rounded-full border-2 border-border" />
													)}
												</div>
												<div className="flex-1 min-w-0">
													<p className="text-sm font-medium text-fg capitalize">
														{strategy.replace(/_/g, " ")}
													</p>
													<p className="text-xs text-fg-muted mt-1">
														{getStrategyDescription(strategy)}
													</p>
												</div>
											</div>
										</button>
									),
								)}
							</div>
						</div>

						{/* Custom Format Changes */}
						{data.data.customFormatDiffs.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-fg">
									Custom Format Changes ({data.data.customFormatDiffs.length})
								</h3>
								<div className="space-y-2 max-h-64 overflow-y-auto">
									{data.data.customFormatDiffs
										.filter((diff) => diff.changeType !== "unchanged")
										.map((diff) => (
											<div
												key={diff.trashId}
												className={cn(
													"rounded-lg border p-3",
													getChangeTypeColor(diff.changeType),
												)}
											>
												<div className="flex items-start justify-between gap-3">
													<div className="flex items-start gap-2 flex-1 min-w-0">
														{getChangeTypeIcon(diff.changeType)}
														<div className="flex-1 min-w-0">
															<p className="text-sm font-medium truncate">
																{diff.name}
															</p>
															{diff.changeType === "modified" && (
																<p className="text-xs mt-1 opacity-80">
																	Specifications changed
																</p>
															)}
															{diff.currentScore !== undefined && (
																<p className="text-xs mt-1 opacity-80">
																	Score: {diff.currentScore}
																</p>
															)}
														</div>
													</div>

													{diff.hasSpecificationChanges && (
														<button
															type="button"
															onClick={() => toggleExpanded(diff.trashId)}
															className="shrink-0 p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded"
														>
															{expandedItems.has(diff.trashId) ? (
																<ChevronDown className="h-4 w-4" />
															) : (
																<ChevronRight className="h-4 w-4" />
															)}
														</button>
													)}
												</div>

												{expandedItems.has(diff.trashId) &&
													diff.hasSpecificationChanges && (
														<div className="mt-3 pt-3 border-t border-current/20 space-y-2 text-xs">
															<div>
																<p className="font-medium opacity-80 mb-1">
																	Current Specifications:
																</p>
																<code className="block p-2 rounded bg-black/10 dark:bg-white/10 overflow-x-auto">
																	{JSON.stringify(
																		diff.currentSpecifications,
																		null,
																		2,
																	)}
																</code>
															</div>
															<div>
																<p className="font-medium opacity-80 mb-1">
																	New Specifications:
																</p>
																<code className="block p-2 rounded bg-black/10 dark:bg-white/10 overflow-x-auto">
																	{JSON.stringify(diff.newSpecifications, null, 2)}
																</code>
															</div>
														</div>
													)}
											</div>
										))}
								</div>
							</div>
						)}

						{/* No Changes Message */}
						{data.data.summary.totalChanges === 0 && (
							<div className="rounded-lg border border-border bg-bg-subtle p-8 text-center">
								<Check className="h-12 w-12 text-green-600 dark:text-green-400 mx-auto mb-3" />
								<p className="text-sm font-medium text-fg">Template is up to date</p>
								<p className="text-xs text-fg-muted mt-1">
									No changes between your template and latest TRaSH Guides
								</p>
							</div>
						)}
					</>
				)}
			</DialogContent>

			<DialogFooter>
				<button
					type="button"
					onClick={onClose}
					className="px-4 py-2 text-sm font-medium text-fg-muted hover:text-fg transition-colors"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={handleSync}
					disabled={
						syncTemplate.isPending ||
						!data?.data ||
						data.data.summary.totalChanges === 0
					}
					className="px-4 py-2 text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
				>
					{syncTemplate.isPending
						? "Syncing..."
						: `Sync with ${selectedStrategy.replace(/_/g, " ")}`}
				</button>
			</DialogFooter>
		</Dialog>
	);
};
