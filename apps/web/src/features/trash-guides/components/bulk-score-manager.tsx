/**
 * Premium Bulk Score Manager Component
 *
 * Provides interface for managing custom format scores across multiple templates:
 * - View and filter scores from all templates
 * - Bulk update scores for selected custom formats
 * - Copy scores from one template to others
 * - Reset scores to TRaSH Guides defaults
 * - Export/import score configurations
 */

"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import {
	Search,
	Save,
	X,
	RotateCcw,
	SlidersHorizontal,
	ChevronDown,
	CheckSquare,
	Square,
	AlertCircle,
	Loader2,
	Filter,
	Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import type { CustomFormatScoreEntry } from "@arr/shared";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useDeleteOverride, useBulkDeleteOverrides } from "../../../hooks/api/useQualityProfileOverrides";
import { useBulkUpdateScores, type BulkScoreUpdateEntry } from "../../../hooks/api/useQualityProfileScores";
import { useBulkScores } from "../../../hooks/api/useBulkScores";
import { useQueryClient } from "@tanstack/react-query";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

/**
 * Service-specific colors for Radarr/Sonarr identification
 * Using centralized SERVICE_GRADIENTS
 */
const SERVICE_COLORS = {
	radarr: SERVICE_GRADIENTS.radarr,
	sonarr: SERVICE_GRADIENTS.sonarr,
};

interface BulkScoreManagerProps {
	/** User ID for data fetching */
	userId: string;
	/** Callback when operations complete */
	onOperationComplete?: () => void;
}

export function BulkScoreManager({
	userId,
	onOperationComplete,
}: BulkScoreManagerProps) {
	const { gradient: themeGradient } = useThemeGradient();
	const queryClient = useQueryClient();

	// Fetch available instances
	const { data: instances = [] } = useServicesQuery();

	// Filter state
	const [instanceId, setInstanceId] = useState<string>("");
	const [searchTerm, setSearchTerm] = useState("");
	const [modifiedOnly, setModifiedOnly] = useState(false);

	// Get selected instance for service color
	const selectedInstance = instances.find(i => i.id === instanceId);
	const serviceColor = selectedInstance?.service
		? SERVICE_COLORS[selectedInstance.service as keyof typeof SERVICE_COLORS]
		: null;

	// Fetch bulk scores using TanStack Query
	const { data: bulkScoresData, isLoading } = useBulkScores({
		instanceId,
		search: searchTerm || undefined,
		modifiedOnly,
	});

	// Local scores state (derived from query data, can be modified locally)
	const [scores, setScores] = useState<CustomFormatScoreEntry[]>([]);

	// Track modified scores for saving
	const [modifiedScores, setModifiedScores] = useState<Map<string, Map<string, number>>>(new Map());

	// Track selected CFs for bulk operations
	const [selectedCFs, setSelectedCFs] = useState<Set<string>>(new Set());

	// Delete override hooks
	const deleteOverride = useDeleteOverride();
	const bulkDeleteOverrides = useBulkDeleteOverrides();

	// Bulk update scores hook
	const bulkUpdateScores = useBulkUpdateScores();

	// Track quality profile IDs and their overrides
	const [qualityProfileIds, setQualityProfileIds] = useState<number[]>([]);
	const [allOverrides, setAllOverrides] = useState<Map<string, { customFormatId: number; score: number }>>(new Map());

	// Create override map for quick lookups: `${profileId}-${cfId}` → has override
	const overrideMap = useMemo(() => {
		const map = new Map<string, boolean>();
		for (const [key] of allOverrides) {
			map.set(key, true);
		}
		return map;
	}, [allOverrides]);

	// Fetch overrides for multiple quality profiles using bulk API
	const fetchOverridesForProfiles = useCallback(async (profileIds: number[], signal?: AbortSignal) => {
		if (!instanceId || profileIds.length === 0) return;

		try {
			const response = await fetch(`/api/trash-guides/instances/${instanceId}/quality-profiles/bulk-overrides`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ profileIds }),
				signal,
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch bulk overrides: ${response.status}`);
			}

			const data = await response.json();

			const newOverrides = new Map<string, { customFormatId: number; score: number }>();

			if (data?.success && data.overridesByProfile) {
				for (const [profileIdStr, overrides] of Object.entries(data.overridesByProfile)) {
					const profileId = parseInt(profileIdStr);
					for (const override of overrides as Array<{ customFormatId: number; score: number }>) {
						const key = `${profileId}-${override.customFormatId}`;
						newOverrides.set(key, {
							customFormatId: override.customFormatId,
							score: override.score,
						});
					}
				}
			}

			setAllOverrides(newOverrides);
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				return;
			}
			console.error("Error fetching bulk overrides:", error);
			toast.error("Failed to fetch quality profile overrides");
		}
	}, [instanceId]);

	// Sync scores from query data and fetch overrides
	useEffect(() => {
		if (bulkScoresData?.data?.scores) {
			const queryScores = bulkScoresData.data.scores;
			setScores(queryScores);

			const profileIds = new Set<number>();
			for (const score of queryScores) {
				for (const templateScore of score.templateScores) {
					const raw = templateScore.templateId.split('-').pop() || '';
					const profileId = parseInt(raw, 10);
					if (Number.isFinite(profileId) && profileId > 0) {
						profileIds.add(profileId);
					}
				}
			}
			const profileIdArray = Array.from(profileIds);
			setQualityProfileIds(profileIdArray);

			const controller = new AbortController();
			void fetchOverridesForProfiles(profileIdArray, controller.signal);

			return () => {
				controller.abort();
			};
		}
	}, [bulkScoresData, fetchOverridesForProfiles]);

	// Clear local state when instance changes
	useEffect(() => {
		setScores([]);
		setModifiedScores(new Map());
		setSelectedCFs(new Set());
	}, [instanceId]);

	// Handle score change in table
	const handleScoreChange = (cfTrashId: string, templateId: string, newScore: number) => {
		setModifiedScores((prev) => {
			const newMap = new Map(prev);
			if (!newMap.has(cfTrashId)) {
				newMap.set(cfTrashId, new Map());
			}
			newMap.get(cfTrashId)!.set(templateId, newScore);
			return newMap;
		});

		setScores((prev) =>
			prev.map((score) => {
				if (score.trashId === cfTrashId) {
					return {
						...score,
						templateScores: score.templateScores.map((ts) => {
							if (ts.templateId === templateId) {
								return {
									...ts,
									currentScore: newScore,
									isModified: newScore !== ts.defaultScore,
								};
							}
							return ts;
						}),
						hasAnyModifications: true,
					};
				}
				return score;
			})
		);
	};

	// Save all modified scores
	const handleSaveChanges = async () => {
		if (modifiedScores.size === 0) {
			toast.error("No changes to save");
			return;
		}

		if (!instanceId) {
			toast.error("No instance selected");
			return;
		}

		const profileUpdates = new Map<string, Array<{ cfTrashId: string; score: number }>>();

		for (const [cfTrashId, templateScores] of modifiedScores.entries()) {
			for (const [templateId, newScore] of templateScores.entries()) {
				if (!profileUpdates.has(templateId)) {
					profileUpdates.set(templateId, []);
				}
				profileUpdates.get(templateId)!.push({ cfTrashId, score: newScore });
			}
		}

		const entries: BulkScoreUpdateEntry[] = Array.from(profileUpdates.entries()).map(
			([templateId, changes]) => {
				const profileId = parseInt(templateId.split("-").pop() || "0");
				return {
					profileId,
					instanceId,
					changes,
				};
			}
		);

		try {
			await bulkUpdateScores.mutateAsync(entries);
			setModifiedScores(new Map());
			onOperationComplete?.();
		} catch (error) {
			console.error("Error saving scores:", error);
		}
	};

	// Discard unsaved changes
	const handleDiscardChanges = () => {
		if (modifiedScores.size === 0) return;

		if (confirm("Are you sure you want to discard all unsaved changes?")) {
			setModifiedScores(new Map());
			void queryClient.invalidateQueries({ queryKey: ["bulk-scores"] });
		}
	};

	// Handle delete individual override
	const handleDeleteOverride = async (
		templateId: string,
		customFormatId: number,
		customFormatName: string
	) => {
		if (!instanceId) {
			toast.error("No instance selected");
			return;
		}

		const profileId = parseInt(templateId.split('-').pop() || '0');
		if (profileId === 0) {
			toast.error("Invalid quality profile ID");
			return;
		}

		if (!confirm(`Remove override for "${customFormatName}"?\n\nScore will revert to template/default value.`)) {
			return;
		}

		try {
			await deleteOverride.mutateAsync({
				instanceId,
				qualityProfileId: profileId,
				customFormatId,
			});
		} catch (error) {
			// Error toast handled by mutation hook
		}
	};

	// Handle bulk reset to template
	const handleBulkResetToTemplate = async () => {
		if (!instanceId) {
			toast.error("Please select an instance first");
			return;
		}

		if (selectedCFs.size === 0) {
			toast.error("Please select at least one custom format to reset");
			return;
		}

		const profileToCFs = new Map<number, Set<number>>();

		for (const trashId of selectedCFs) {
			const cfId = parseInt(trashId.replace('cf-', ''));
			if (isNaN(cfId)) continue;

			for (const profileId of qualityProfileIds) {
				const overrideKey = `${profileId}-${cfId}`;
				if (overrideMap.has(overrideKey)) {
					if (!profileToCFs.has(profileId)) {
						profileToCFs.set(profileId, new Set());
					}
					profileToCFs.get(profileId)!.add(cfId);
				}
			}
		}

		if (profileToCFs.size === 0) {
			toast.error("No instance-level overrides found for the selected custom formats. They are already using template defaults.");
			return;
		}

		const profileCount = profileToCFs.size;
		const totalOverrides = Array.from(profileToCFs.values()).reduce((sum, cfs) => sum + cfs.size, 0);
		const confirmMessage = profileCount === 1
			? `Reset ${totalOverrides} override(s) to template defaults?\n\nThis will remove instance-level overrides.`
			: `Reset ${totalOverrides} override(s) across ${profileCount} quality profiles to template defaults?\n\nThis will remove instance-level overrides for the selected custom formats in all affected profiles.`;

		if (!confirm(confirmMessage)) {
			return;
		}

		try {
			const resetPromises = Array.from(profileToCFs.entries()).map(([profileId, cfIds]) =>
				bulkDeleteOverrides.mutateAsync({
					instanceId,
					qualityProfileId: profileId,
					payload: { customFormatIds: Array.from(cfIds) },
				})
			);

			const results = await Promise.all(resetPromises);
			const totalDeleted = results.reduce((sum, r) => sum + (r.deletedCount || 0), 0);

			setSelectedCFs(new Set());
			toast.success(`Successfully reset ${totalDeleted} override${totalDeleted === 1 ? "" : "s"} to template defaults`);
		} catch (error) {
			console.error("Failed to bulk reset:", error);
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			toast.error(`Failed to reset overrides: ${errorMessage}. Some overrides may have been reset. Please refresh to see the current state.`);
		}
	};

	// Toggle CF selection
	const toggleCFSelection = (cfTrashId: string) => {
		setSelectedCFs(prev => {
			const newSet = new Set(prev);
			if (newSet.has(cfTrashId)) {
				newSet.delete(cfTrashId);
			} else {
				newSet.add(cfTrashId);
			}
			return newSet;
		});
	};

	// Select/deselect all
	const toggleSelectAll = () => {
		if (selectedCFs.size === filteredScores.length) {
			setSelectedCFs(new Set());
		} else {
			setSelectedCFs(new Set(filteredScores.map(s => s.trashId)));
		}
	};

	// Filtered scores
	const filteredScores = useMemo(() => {
		return scores.filter((score) => {
			if (searchTerm && !score.name.toLowerCase().includes(searchTerm.toLowerCase())) {
				return false;
			}
			if (modifiedOnly && !score.hasAnyModifications) {
				return false;
			}
			return true;
		});
	}, [scores, searchTerm, modifiedOnly]);

	return (
		<div className="space-y-6 animate-in fade-in duration-300">
			{/* Header */}
			<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-6">
				<div className="flex items-center gap-4 mb-6">
					<div
						className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: `1px solid ${themeGradient.from}30`,
						}}
					>
						<SlidersHorizontal className="h-6 w-6" style={{ color: themeGradient.from }} />
					</div>
					<div>
						<h2
							className="text-xl font-bold"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								WebkitBackgroundClip: "text",
								WebkitTextFillColor: "transparent",
							}}
						>
							Bulk Score Management
						</h2>
						<p className="text-sm text-muted-foreground">
							Manage custom format scores across multiple quality profiles
						</p>
					</div>
				</div>

				{/* Filters */}
				<div className="flex flex-wrap gap-3 items-center">
					{/* Instance Selector */}
					<div className="relative min-w-[200px]">
						<select
							value={instanceId}
							onChange={(e) => setInstanceId(e.target.value)}
							className="w-full appearance-none rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 pr-10 text-sm font-medium text-foreground focus:outline-none focus:ring-2 transition-all"
							style={{ ["--tw-ring-color" as string]: themeGradient.from }}
						>
							<option value="">Select Instance</option>
							{instances
								.filter((instance) => instance.service === "radarr" || instance.service === "sonarr")
								.map((instance) => (
									<option key={instance.id} value={instance.id}>
										{instance.label} ({instance.service.toUpperCase()})
									</option>
								))}
						</select>
						<ChevronDown className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
					</div>

					{/* Search */}
					<div className="relative flex-1 min-w-[200px]">
						<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<input
							type="text"
							placeholder="Search custom formats..."
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							className="w-full rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 transition-all"
							style={{ ["--tw-ring-color" as string]: themeGradient.from, paddingLeft: "2.5rem" }}
						/>
					</div>

					{/* Modified Only Toggle */}
					<button
						type="button"
						onClick={() => setModifiedOnly(!modifiedOnly)}
						className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 border"
						style={{
							backgroundColor: modifiedOnly ? `${SEMANTIC_COLORS.warning.from}15` : "rgba(var(--card), 0.5)",
							borderColor: modifiedOnly ? SEMANTIC_COLORS.warning.from : "rgba(var(--border), 0.5)",
							color: modifiedOnly ? SEMANTIC_COLORS.warning.from : undefined,
						}}
					>
						<Filter className="h-4 w-4" />
						Modified Only
					</button>

					{/* Loading Indicator */}
					{isLoading && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" style={{ color: themeGradient.from }} />
							<span>Loading...</span>
						</div>
					)}
				</div>
			</div>

			{/* Save/Discard Changes Bar */}
			{modifiedScores.size > 0 && (
				<div
					className="rounded-2xl border p-4 animate-in slide-in-from-top-2 duration-200"
					style={{
						backgroundColor: `${themeGradient.from}10`,
						borderColor: `${themeGradient.from}30`,
					}}
				>
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}30, ${themeGradient.to}30)`,
								}}
							>
								<span className="text-sm font-bold" style={{ color: themeGradient.from }}>
									{modifiedScores.size}
								</span>
							</div>
							<div>
								<p className="font-medium text-foreground">
									{modifiedScores.size} custom format{modifiedScores.size === 1 ? '' : 's'} modified
								</p>
								<p className="text-xs text-muted-foreground">Changes are not saved yet</p>
							</div>
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={handleDiscardChanges}
								disabled={bulkUpdateScores.isPending}
								className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors border border-border/50 bg-card/50 hover:bg-card/80 text-foreground disabled:opacity-50"
							>
								<X className="h-4 w-4" />
								Discard
							</button>
							<button
								type="button"
								onClick={handleSaveChanges}
								disabled={bulkUpdateScores.isPending}
								className="inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-medium text-white transition-all duration-200 disabled:opacity-50"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
								}}
							>
								{bulkUpdateScores.isPending ? (
									<>
										<Loader2 className="h-4 w-4 animate-spin" />
										Saving...
									</>
								) : (
									<>
										<Save className="h-4 w-4" />
										Save Changes
									</>
								)}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Bulk Reset Bar */}
			{selectedCFs.size > 0 && (
				<div
					className="rounded-2xl border p-4 animate-in slide-in-from-top-2 duration-200"
					style={{
						backgroundColor: SEMANTIC_COLORS.warning.bg,
						borderColor: SEMANTIC_COLORS.warning.border,
					}}
				>
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl"
								style={{ backgroundColor: `${SEMANTIC_COLORS.warning.from}30` }}
							>
								<span className="text-sm font-bold" style={{ color: SEMANTIC_COLORS.warning.from }}>
									{selectedCFs.size}
								</span>
							</div>
							<div>
								<p className="font-medium text-foreground">
									{selectedCFs.size} custom format{selectedCFs.size === 1 ? '' : 's'} selected
								</p>
								<p className="text-xs text-muted-foreground">Select formats to reset their overrides</p>
							</div>
						</div>
						<button
							type="button"
							onClick={handleBulkResetToTemplate}
							className="inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-medium text-white transition-all duration-200"
							style={{
								background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}, #d97706)`,
								boxShadow: `0 4px 12px -4px rgba(245, 158, 11, 0.5)`,
							}}
						>
							<RotateCcw className="h-4 w-4" />
							Reset to Template
						</button>
					</div>
				</div>
			)}

			{/* Scores Table */}
			<div className="overflow-hidden rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm">
				<div className="overflow-x-auto">
					<table className="w-full table-fixed">
						<thead>
							<tr className="border-b border-border/50">
								<th className="sticky left-0 z-sticky w-12 bg-card/95 backdrop-blur-sm px-3 py-4 text-center">
									<button
										type="button"
										onClick={toggleSelectAll}
										aria-label={filteredScores.length > 0 && selectedCFs.size === filteredScores.length ? "Deselect all custom formats" : "Select all custom formats"}
										className="flex h-6 w-6 mx-auto items-center justify-center rounded-lg transition-all duration-200"
										style={{
											backgroundColor: filteredScores.length > 0 && selectedCFs.size === filteredScores.length
												? themeGradient.from
												: "rgba(var(--muted), 0.3)",
											border: `1px solid ${filteredScores.length > 0 && selectedCFs.size === filteredScores.length ? themeGradient.from : "rgba(var(--border), 0.5)"}`,
										}}
									>
										{filteredScores.length > 0 && selectedCFs.size === filteredScores.length ? (
											<CheckSquare className="h-4 w-4 text-white" />
										) : (
											<Square className="h-4 w-4 text-muted-foreground" />
										)}
									</button>
								</th>
								<th className="sticky left-12 z-10 w-64 bg-card/95 backdrop-blur-sm px-4 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
									Custom Format
								</th>
								{/* Dynamic columns for each unique template */}
								{filteredScores.length > 0 &&
									filteredScores[0]?.templateScores.map((templateScore) => (
										<th
											key={templateScore.templateId}
											className="w-28 px-3 py-4 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground"
										>
											<div className="flex flex-col gap-0.5">
												<div className="text-foreground/90">{templateScore.qualityProfileName}</div>
												<div className="font-normal text-muted-foreground normal-case">
													{templateScore.templateName}
												</div>
											</div>
										</th>
									))}
							</tr>
						</thead>
						<tbody className="divide-y divide-border/30">
							{filteredScores.length === 0 ? (
								<tr>
									<td colSpan={100} className="px-6 py-12 text-center">
										<div className="flex flex-col items-center gap-3">
											{instanceId ? (
												<>
													<AlertCircle className="h-10 w-10 text-muted-foreground" />
													<p className="text-muted-foreground">No scores found for this instance.</p>
												</>
											) : (
												<>
													<SlidersHorizontal className="h-10 w-10 text-muted-foreground" />
													<p className="text-muted-foreground">Select an instance to view scores.</p>
												</>
											)}
										</div>
									</td>
								</tr>
							) : (
								filteredScores.map((score, rowIndex) => (
									<tr
										key={score.trashId}
										className="transition-colors hover:bg-card/50 animate-in fade-in"
										style={{
											animationDelay: `${rowIndex * 20}ms`,
											animationFillMode: "backwards",
										}}
									>
										<td className="sticky left-0 z-sticky bg-card/95 backdrop-blur-sm px-3 py-3 text-center">
											<button
												type="button"
												onClick={() => toggleCFSelection(score.trashId)}
												aria-label={selectedCFs.has(score.trashId) ? `Deselect ${score.name}` : `Select ${score.name}`}
												className="flex h-6 w-6 mx-auto items-center justify-center rounded-lg transition-all duration-200"
												style={{
													backgroundColor: selectedCFs.has(score.trashId)
														? themeGradient.from
														: "rgba(var(--muted), 0.3)",
													border: `1px solid ${selectedCFs.has(score.trashId) ? themeGradient.from : "rgba(var(--border), 0.5)"}`,
												}}
											>
												{selectedCFs.has(score.trashId) ? (
													<CheckSquare className="h-4 w-4 text-white" />
												) : (
													<Square className="h-4 w-4 text-muted-foreground" />
												)}
											</button>
										</td>
										<td className="sticky left-12 z-10 bg-card/95 backdrop-blur-sm px-4 py-3 text-sm">
											<div className="flex items-center gap-2">
												<span className="font-medium text-foreground">{score.name}</span>
												{score.hasAnyModifications && (
													<span
														className="flex h-5 w-5 items-center justify-center rounded-full"
														style={{
															backgroundColor: SEMANTIC_COLORS.warning.bg,
															border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
														}}
														title="Has modifications"
													>
														<Sparkles className="h-3 w-3" style={{ color: SEMANTIC_COLORS.warning.from }} />
													</span>
												)}
											</div>
										</td>
										{/* Editable score cells for each template */}
										{score.templateScores.map((templateScore) => {
											const cfId = parseInt(score.trashId.replace('cf-', ''));
											const parts = templateScore.templateId.split('-');
											const lastPart = parts[parts.length - 1];
											const profileId = parseInt(lastPart || '0');

											const overrideKey = `${profileId}-${cfId}`;
											const hasOverride = overrideMap.has(overrideKey);
											const showOverrideUI = hasOverride && templateScore.isTemplateManaged;

											return (
												<td key={templateScore.templateId} className="px-2 py-2">
													<div className="relative">
														<input
															type="number"
															value={templateScore.currentScore}
															onChange={(e) => {
																const newScore = parseInt(e.target.value) || 0;
																handleScoreChange(score.trashId, templateScore.templateId, newScore);
															}}
															className="w-full rounded-xl border px-3 py-2 text-center text-sm font-medium transition-all duration-200 focus:outline-none focus:ring-2"
															style={{
																borderColor: showOverrideUI
																	? themeGradient.from
																	: templateScore.isModified
																	? SEMANTIC_COLORS.warning.border
																	: "rgba(var(--border), 0.5)",
																backgroundColor: showOverrideUI
																	? `${themeGradient.from}15`
																	: templateScore.isModified
																	? SEMANTIC_COLORS.warning.bg
																	: "rgba(var(--card), 0.5)",
																color: showOverrideUI
																	? themeGradient.from
																	: templateScore.isModified
																	? SEMANTIC_COLORS.warning.text
																	: undefined,
																["--tw-ring-color" as string]: themeGradient.from,
															}}
															title={
																showOverrideUI
																	? "Template-managed profile with instance override (persists across syncs)"
																	: !templateScore.isTemplateManaged
																	? "User-created profile (not managed by template)"
																	: templateScore.isModified
																	? `Modified from default (${templateScore.defaultScore})`
																	: `Default: ${templateScore.defaultScore}`
															}
														/>
														{showOverrideUI && (
															<button
																type="button"
																onClick={() => handleDeleteOverride(templateScore.templateId, cfId, score.name)}
																className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full text-white transition-all duration-200 hover:scale-110"
																style={{
																	background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
																	boxShadow: `0 2px 6px -2px ${themeGradient.glow}`,
																}}
																aria-label={`Remove override for ${score.name}`}
																title="Remove override (revert to template score on next sync)"
															>
																<X className="h-3 w-3" />
															</button>
														)}
													</div>
												</td>
											);
										})}
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</div>

			{/* Summary Footer */}
			<div className="flex items-center justify-between text-sm text-muted-foreground">
				<span>
					Showing <span className="font-medium text-foreground">{filteredScores.length}</span> custom format{filteredScores.length === 1 ? '' : 's'}
				</span>
				{modifiedScores.size > 0 && (
					<span className="flex items-center gap-2">
						<Sparkles className="h-4 w-4" style={{ color: SEMANTIC_COLORS.warning.from }} />
						<span className="font-medium text-foreground">{modifiedScores.size}</span> unsaved change{modifiedScores.size === 1 ? '' : 's'}
					</span>
				)}
			</div>
		</div>
	);
}
