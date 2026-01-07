"use client";

/**
 * Template Diff Modal
 *
 * Premium modal for reviewing changes between local template and TRaSH Guides with:
 * - SEMANTIC_COLORS for change type indicators
 * - Theme-aware styling using THEME_GRADIENTS
 * - Glassmorphic content cards
 */

import { useState } from "react";
import {
	LegacyDialog,
	LegacyDialogHeader,
	LegacyDialogTitle,
	LegacyDialogDescription,
	LegacyDialogContent,
	LegacyDialogFooter,
	LegacyDialogClose,
} from "../../../components/ui";
import { Skeleton, Button } from "../../../components/ui";
import {
	AlertCircle,
	Plus,
	Minus,
	Edit,
	Check,
	GitCompare,
	ChevronDown,
	ChevronRight,
	Lightbulb,
	TrendingUp,
	History,
	Clock,
	Loader2,
} from "lucide-react";
import { useTemplateDiff, useSyncTemplate } from "../../../hooks/api/useTemplateUpdates";
import { cn } from "../../../lib/utils";
import { toast } from "sonner";
import type { CustomFormatDiffItem } from "../../../lib/api-client/trash-guides";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/** Maps UI strategy names to API strategy names */
function mapStrategyToApiStrategy(selectedStrategy: string): "keep_custom" | "replace" | "merge" {
	switch (selectedStrategy) {
		case "keep_custom":
			return "keep_custom";
		case "sync_new":
			return "replace";
		default:
			return "merge";
	}
}

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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
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
			const result = await syncTemplate.mutateAsync({
				templateId,
				payload: {
					strategy: mapStrategyToApiStrategy(selectedStrategy),
				},
			});

			// Show success toast with sync statistics
			const stats = result.data?.mergeStats;
			if (stats) {
				const changes: string[] = [];
				if (stats.customFormatsAdded > 0) changes.push(`${stats.customFormatsAdded} CFs added`);
				if (stats.customFormatsUpdated > 0) changes.push(`${stats.customFormatsUpdated} CFs updated`);
				if (stats.scoresUpdated > 0) changes.push(`${stats.scoresUpdated} scores updated`);

				toast.success("Template synced", {
					description: changes.length > 0 ? changes.join(", ") : "Template is now up to date",
				});
			} else {
				toast.success("Template synced successfully");
			}

			onSyncSuccess?.();
			onClose();
		} catch (err) {
			console.error("Sync failed:", err);
			toast.error("Sync failed", {
				description: err instanceof Error ? err.message : "An unexpected error occurred",
			});
		}
	};

	const getChangeTypeIcon = (changeType: string) => {
		switch (changeType) {
			case "added":
				return <Plus className="h-4 w-4" style={{ color: SEMANTIC_COLORS.success.from }} />;
			case "removed":
				return <Minus className="h-4 w-4" style={{ color: SEMANTIC_COLORS.error.from }} />;
			case "modified":
				return <Edit className="h-4 w-4" style={{ color: SEMANTIC_COLORS.warning.from }} />;
			case "unchanged":
				return <Check className="h-4 w-4 text-muted-foreground" />;
			default:
				return null;
		}
	};

	const getChangeTypeStyles = (changeType: string) => {
		switch (changeType) {
			case "added":
				return {
					backgroundColor: SEMANTIC_COLORS.success.bg,
					borderColor: SEMANTIC_COLORS.success.border,
					color: SEMANTIC_COLORS.success.text,
				};
			case "removed":
				return {
					backgroundColor: SEMANTIC_COLORS.error.bg,
					borderColor: SEMANTIC_COLORS.error.border,
					color: SEMANTIC_COLORS.error.text,
				};
			case "modified":
				return {
					backgroundColor: SEMANTIC_COLORS.warning.bg,
					borderColor: SEMANTIC_COLORS.warning.border,
					color: SEMANTIC_COLORS.warning.text,
				};
			case "unchanged":
				return {
					backgroundColor: "rgba(100, 116, 139, 0.1)",
					borderColor: "rgba(100, 116, 139, 0.3)",
					color: "#94a3b8",
				};
			default:
				return {};
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

	const isHistorical = data?.data?.isHistorical ?? false;

	// Format relative time for historical sync timestamp
	const formatRelativeTime = (timestamp: string | undefined): string => {
		if (!timestamp) return "";
		const date = new Date(timestamp);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return "just now";
		if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
		if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
		return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
	};

	return (
		<LegacyDialog open={open} onOpenChange={onClose} size="xl">
			<LegacyDialogClose onClick={onClose} />
			<LegacyDialogHeader
				icon={
					isHistorical ? (
						<History className="h-6 w-6" style={{ color: SEMANTIC_COLORS.success.from }} />
					) : (
						<GitCompare className="h-6 w-6" style={{ color: themeGradient.from }} />
					)
				}
			>
				<div>
					<LegacyDialogTitle>
						{isHistorical ? "Recently Applied Changes" : "Pending Changes"}
					</LegacyDialogTitle>
					<LegacyDialogDescription>
						{isHistorical ? (
							<span className="flex items-center gap-2 flex-wrap">
								<span>Changes that were auto-synced{templateName && ` for "${templateName}"`}</span>
								{data?.data?.historicalSyncTimestamp && (
									<span
										className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
										style={{
											backgroundColor: SEMANTIC_COLORS.success.bg,
											border: `1px solid ${SEMANTIC_COLORS.success.border}`,
											color: SEMANTIC_COLORS.success.text,
										}}
									>
										<Clock className="h-3 w-3" />
										{formatRelativeTime(data.data.historicalSyncTimestamp)}
									</span>
								)}
							</span>
						) : (
							<>
								Review changes between your template and the latest TRaSH Guides
								{templateName && ` for "${templateName}"`}
							</>
						)}
					</LegacyDialogDescription>
				</div>
			</LegacyDialogHeader>

			<LegacyDialogContent className="space-y-5">
				{isLoading && (
					<div className="space-y-4">
						<Skeleton className="h-24 w-full rounded-xl" />
						<Skeleton className="h-48 w-full rounded-xl" />
					</div>
				)}

				{error && (
					<div
						className="rounded-xl p-4"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
						}}
					>
						<div className="flex items-start gap-3">
							<AlertCircle
								className="h-5 w-5 mt-0.5 shrink-0"
								style={{ color: SEMANTIC_COLORS.error.from }}
							/>
							<div>
								<p className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
									Failed to load diff
								</p>
								<p className="text-sm mt-1 opacity-80" style={{ color: SEMANTIC_COLORS.error.text }}>
									{error instanceof Error ? error.message : "Please try again"}
								</p>
							</div>
						</div>
					</div>
				)}

				{data?.data && (
					<>
						{/* Historical Badge */}
						{isHistorical && (
							<div
								className="rounded-xl p-4"
								style={{
									backgroundColor: SEMANTIC_COLORS.success.bg,
									border: `1px solid ${SEMANTIC_COLORS.success.border}`,
								}}
							>
								<div className="flex items-center gap-2">
									<History className="h-4 w-4 shrink-0" style={{ color: SEMANTIC_COLORS.success.from }} />
									<span className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.success.text }}>
										These changes were already applied via auto-sync
									</span>
								</div>
								<p className="text-xs mt-1 ml-6 opacity-80" style={{ color: SEMANTIC_COLORS.success.text }}>
									This is a historical view of changes that were synced automatically. No further action is needed.
								</p>
							</div>
						)}

						{/* Summary Statistics */}
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4">
							<h3 className="text-sm font-semibold text-foreground mb-3">Change Summary</h3>
							<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
								<div className="space-y-1">
									<p className="text-xs text-muted-foreground">Total Changes</p>
									<p className="text-2xl font-semibold text-foreground">
										{data.data.summary.totalChanges}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.success.text }}>Added</p>
									<p className="text-2xl font-semibold" style={{ color: SEMANTIC_COLORS.success.from }}>
										{data.data.summary.addedCFs}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>Modified</p>
									<p className="text-2xl font-semibold" style={{ color: SEMANTIC_COLORS.warning.from }}>
										{data.data.summary.modifiedCFs}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>Removed</p>
									<p className="text-2xl font-semibold" style={{ color: SEMANTIC_COLORS.error.from }}>
										{data.data.summary.removedCFs}
									</p>
								</div>
							</div>

							{/* Suggestions Row */}
							{(data.data.suggestedAdditions?.length || data.data.suggestedScoreChanges?.length) && (
								<div className="mt-3 pt-3 border-t border-border/30">
									<div className="grid grid-cols-2 gap-4">
										{data.data.suggestedAdditions?.length ? (
											<div className="flex items-center gap-2 text-sm">
												<Lightbulb className="h-4 w-4" style={{ color: themeGradient.from }} />
												<span className="text-muted-foreground">
													{data.data.suggestedAdditions.length} suggested addition{data.data.suggestedAdditions.length !== 1 ? 's' : ''}
												</span>
											</div>
										) : null}
										{data.data.suggestedScoreChanges?.length ? (
											<div className="flex items-center gap-2 text-sm">
												<TrendingUp className="h-4 w-4" style={{ color: SEMANTIC_COLORS.info.from }} />
												<span className="text-muted-foreground">
													{data.data.suggestedScoreChanges.length} score update{data.data.suggestedScoreChanges.length !== 1 ? 's' : ''}
												</span>
											</div>
										) : null}
									</div>
								</div>
							)}

							{data.data.hasUserModifications && (
								<div className="mt-3 pt-3 border-t border-border/30">
									<div className="flex items-center gap-2 text-sm">
										<AlertCircle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.warning.from }} />
										<span className="text-muted-foreground">
											This template has custom modifications
										</span>
									</div>
								</div>
							)}
						</div>

						{/* Merge Strategy Selection - hidden for historical views */}
						{!isHistorical && (
							<div className="space-y-3">
								<h3 className="text-sm font-semibold text-foreground">Merge Strategy</h3>
								<div className="grid gap-3">
									{(["keep_custom", "sync_new", "smart_merge"] as MergeStrategy[]).map(
										(strategy) => (
											<button
												key={strategy}
												type="button"
												onClick={() => setSelectedStrategy(strategy)}
												className="text-left rounded-xl border p-4 transition-all"
												style={{
													borderColor: selectedStrategy === strategy
														? themeGradient.from
														: "hsl(var(--border) / 0.5)",
													backgroundColor: selectedStrategy === strategy
														? `${themeGradient.from}10`
														: "transparent",
													boxShadow: selectedStrategy === strategy
														? `0 0 0 1px ${themeGradient.from}`
														: undefined,
												}}
											>
												<div className="flex items-start gap-3">
													<div className="mt-0.5">
														{selectedStrategy === strategy ? (
															<div
																className="h-5 w-5 rounded-full flex items-center justify-center"
																style={{ background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})` }}
															>
																<Check className="h-3 w-3 text-white" />
															</div>
														) : (
															<div className="h-5 w-5 rounded-full border-2 border-border/50" />
														)}
													</div>
													<div className="flex-1 min-w-0">
														<p className="text-sm font-medium text-foreground capitalize">
															{strategy.replace(/_/g, " ")}
														</p>
														<p className="text-xs text-muted-foreground mt-1">
															{getStrategyDescription(strategy)}
														</p>
													</div>
												</div>
											</button>
										),
									)}
								</div>
							</div>
						)}

						{/* Custom Format Changes */}
						{data.data.customFormatDiffs.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-semibold text-foreground">
									Custom Format Changes ({data.data.customFormatDiffs.filter(d => d.changeType !== "unchanged").length})
								</h3>
								<div className="space-y-2 max-h-80 overflow-y-auto pr-1">
									{data.data.customFormatDiffs
										.filter((diff) => diff.changeType !== "unchanged")
										.map((diff) => {
											const hasDetails = diff.hasSpecificationChanges ||
												diff.currentSpecifications ||
												diff.newSpecifications ||
												diff.currentScore !== undefined ||
												diff.newScore !== undefined;
											const isExpanded = expandedItems.has(diff.trashId);
											const styles = getChangeTypeStyles(diff.changeType);

											return (
												<div
													key={diff.trashId}
													className="rounded-xl border overflow-hidden"
													style={{
														backgroundColor: styles.backgroundColor,
														borderColor: styles.borderColor,
													}}
												>
													<button
														type="button"
														onClick={() => hasDetails && toggleExpanded(diff.trashId)}
														className={cn(
															"w-full text-left p-3",
															hasDetails && "cursor-pointer hover:opacity-80"
														)}
														disabled={!hasDetails}
													>
														<div className="flex items-center justify-between gap-3">
															<div className="flex items-center gap-2 flex-1 min-w-0">
																{getChangeTypeIcon(diff.changeType)}
																<span className="text-sm font-medium truncate" style={{ color: styles.color }}>
																	{diff.name}
																</span>
																{diff.currentScore !== undefined &&
																	diff.changeType !== "added" &&
																	!(diff.changeType === "modified" && diff.currentScore !== diff.newScore) && (
																	<span className="text-xs opacity-70 shrink-0" style={{ color: styles.color }}>
																		Score: {diff.currentScore}
																	</span>
																)}
																{diff.newScore !== undefined && diff.changeType === "added" && (
																	<span className="text-xs opacity-70 shrink-0" style={{ color: styles.color }}>
																		Score: {diff.newScore}
																	</span>
																)}
																{diff.changeType === "modified" && diff.currentScore !== diff.newScore && (
																	<span className="text-xs opacity-70 shrink-0" style={{ color: styles.color }}>
																		{diff.currentScore} → {diff.newScore}
																	</span>
																)}
															</div>
															{hasDetails && (
																<span className="shrink-0" style={{ color: styles.color }}>
																	{isExpanded ? (
																		<ChevronDown className="h-4 w-4" />
																	) : (
																		<ChevronRight className="h-4 w-4" />
																	)}
																</span>
															)}
														</div>
													</button>

													{isExpanded && hasDetails && (
														<div
															className="px-3 pb-3 space-y-2 text-xs border-t"
															style={{ borderColor: styles.borderColor, color: styles.color }}
														>
															{diff.changeType === "removed" && diff.currentSpecifications && (
																<div className="pt-2">
																	<p className="font-medium opacity-80 mb-1">
																		Specifications (will be removed):
																	</p>
																	<pre className="p-2 rounded-lg bg-black/10 overflow-x-auto text-[10px] leading-relaxed">
																		{JSON.stringify(diff.currentSpecifications, null, 2)}
																	</pre>
																</div>
															)}
															{diff.changeType === "added" && diff.newSpecifications && (
																<div className="pt-2">
																	<p className="font-medium opacity-80 mb-1">
																		Specifications (will be added):
																	</p>
																	<pre className="p-2 rounded-lg bg-black/10 overflow-x-auto text-[10px] leading-relaxed">
																		{JSON.stringify(diff.newSpecifications, null, 2)}
																	</pre>
																</div>
															)}
															{diff.changeType === "modified" && (
																<>
																	{diff.currentSpecifications && (
																		<div className="pt-2">
																			<p className="font-medium opacity-80 mb-1">Current:</p>
																			<pre className="p-2 rounded-lg bg-black/10 overflow-x-auto text-[10px] leading-relaxed">
																				{JSON.stringify(diff.currentSpecifications, null, 2)}
																			</pre>
																		</div>
																	)}
																	{diff.newSpecifications && (
																		<div>
																			<p className="font-medium opacity-80 mb-1">New:</p>
																			<pre className="p-2 rounded-lg bg-black/10 overflow-x-auto text-[10px] leading-relaxed">
																				{JSON.stringify(diff.newSpecifications, null, 2)}
																			</pre>
																		</div>
																	)}
																</>
															)}
														</div>
													)}
												</div>
											);
										})}
								</div>
							</div>
						)}

						{/* Suggested Score Changes Section */}
						{data.data.suggestedScoreChanges && data.data.suggestedScoreChanges.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-fg flex items-center gap-2">
									<TrendingUp className="h-4 w-4 text-purple-600 dark:text-purple-400" />
									Suggested Score Updates ({data.data.suggestedScoreChanges.length})
								</h3>
								<div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 max-h-60 overflow-y-auto">
									<div className="space-y-2 text-sm">
										{data.data.suggestedScoreChanges.map((change) => (
											<div
												key={change.trashId}
												className="flex items-center justify-between py-1 border-b border-purple-500/10 last:border-0"
											>
												<span className="text-fg-muted truncate mr-2">{change.name}</span>
												<span className="flex items-center gap-1 shrink-0 text-xs">
													<span className="text-fg-muted">{change.currentScore}</span>
													<span className="text-purple-500">→</span>
													<span className="text-purple-600 dark:text-purple-400 font-medium">
														{change.recommendedScore}
													</span>
												</span>
											</div>
										))}
									</div>
								</div>
								<div className="space-y-1">
									<p className="text-xs text-fg-muted">
										Score set: <span className="font-mono text-xs">{data.data.suggestedScoreChanges[0]?.scoreSet || "default"}</span>
									</p>
									{data.data.suggestedScoreChanges.every(c => c.currentScore === 0) && (
										<p className="text-xs text-amber-600 dark:text-amber-400">
											⚠️ All current scores show 0 - this template may predate TRaSH&apos;s profile-specific scores.
											Syncing will add the recommended scores.
										</p>
									)}
								</div>
							</div>
						)}

						{/* No Changes Message */}
						{data.data.summary.totalChanges === 0 && !data.data.suggestedAdditions?.length && !data.data.suggestedScoreChanges?.length && (
							<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-8 text-center">
								<Check className="h-12 w-12 mx-auto mb-3" style={{ color: SEMANTIC_COLORS.success.from }} />
								<p className="text-sm font-medium text-foreground">
									{isHistorical ? "No changes recorded" : "Template is up to date"}
								</p>
								<p className="text-xs text-muted-foreground mt-1">
									{isHistorical
										? "No detailed change information is available for this sync operation"
										: "No changes between your template and latest TRaSH Guides"}
								</p>
							</div>
						)}

						{/* Suggested Additions Section */}
						{data.data.suggestedAdditions && data.data.suggestedAdditions.length > 0 && (
							<div className="space-y-3">
								<div className="flex items-center gap-2">
									<Lightbulb className="h-4 w-4" style={{ color: themeGradient.from }} />
									<h3 className="text-sm font-semibold text-foreground">
										Suggested Additions ({data.data.suggestedAdditions.length})
									</h3>
								</div>
								<p className="text-xs text-muted-foreground">
									These Custom Formats are available in your CF Groups or Quality Profile but not yet in your template.
									Edit the template to add them if desired.
								</p>
								<div className="space-y-2 max-h-60 overflow-y-auto pr-1">
									{data.data.suggestedAdditions.map((suggestion) => (
										<div
											key={suggestion.trashId}
											className="rounded-xl border p-3"
											style={{
												borderColor: `${themeGradient.from}30`,
												backgroundColor: `${themeGradient.from}08`,
											}}
										>
											<div className="flex items-center justify-between gap-3">
												<div className="flex items-center gap-2 flex-1 min-w-0">
													<Plus className="h-4 w-4 shrink-0" style={{ color: themeGradient.from }} />
													<span className="text-sm font-medium truncate" style={{ color: themeGradient.from }}>
														{suggestion.name}
													</span>
													<span className="text-xs shrink-0 opacity-70" style={{ color: themeGradient.from }}>
														Score: {suggestion.recommendedScore}
													</span>
												</div>
												<span
													className="text-xs px-2 py-0.5 rounded-full shrink-0"
													style={{
														backgroundColor: `${themeGradient.from}20`,
														color: themeGradient.from,
													}}
												>
													{suggestion.source === "cf_group"
														? `From: ${suggestion.sourceGroupName}`
														: `From: ${suggestion.sourceProfileName}`}
												</span>
											</div>
										</div>
									))}
								</div>
							</div>
						)}
					</>
				)}
			</LegacyDialogContent>

			<LegacyDialogFooter>
				<Button variant="outline" onClick={onClose} className="rounded-xl">
					{isHistorical ? "Close" : "Cancel"}
				</Button>
				{!isHistorical && (
					<Button
						onClick={handleSync}
						disabled={syncTemplate.isPending || !data?.data}
						className="gap-2 rounded-xl font-medium"
						style={
							data?.data
								? {
										background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
										boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
									}
								: undefined
						}
					>
						{syncTemplate.isPending ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Syncing...
							</>
						) : data?.data?.summary.totalChanges === 0 &&
						  !data?.data?.suggestedScoreChanges?.length &&
						  !data?.data?.suggestedAdditions?.length ? (
							"Mark as Current"
						) : (
							`Sync with ${selectedStrategy.replace(/_/g, " ")}`
						)}
					</Button>
				)}
			</LegacyDialogFooter>
		</LegacyDialog>
	);
};
