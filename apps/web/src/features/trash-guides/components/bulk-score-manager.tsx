/**
 * Bulk Score Manager Component
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
import { Search, Save, X, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { CustomFormatScoreEntry } from "@arr/shared";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useDeleteOverride, useBulkDeleteOverrides } from "../../../hooks/api/useQualityProfileOverrides";
import { useBulkUpdateScores, type BulkScoreUpdateEntry } from "../../../hooks/api/useQualityProfileScores";
import { useBulkScores } from "../../../hooks/api/useBulkScores";
import { useQueryClient } from "@tanstack/react-query";
import { Select, SelectOption, Input } from "../../../components/ui";

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
	const queryClient = useQueryClient();

	// Fetch available instances
	const { data: instances = [] } = useServicesQuery();

	// Filter state
	const [instanceId, setInstanceId] = useState<string>("");
	const [searchTerm, setSearchTerm] = useState("");
	const [modifiedOnly, setModifiedOnly] = useState(false);

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
	const fetchOverridesForProfiles = useCallback(async (profileIds: number[]) => {
		if (!instanceId || profileIds.length === 0) return;

		try {
			// Single bulk API call instead of per-profile requests
			const response = await fetch(`/api/trash-guides/instances/${instanceId}/quality-profiles/bulk-overrides`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ profileIds }),
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch bulk overrides: ${response.status}`);
			}

			const data = await response.json();

			// Build override map: ${profileId}-${cfId} → override data
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
			console.error("Error fetching bulk overrides:", error);
		}
	}, [instanceId]);

	// Sync scores from query data and fetch overrides
	useEffect(() => {
		if (bulkScoresData?.data?.scores) {
			const queryScores = bulkScoresData.data.scores;
			setScores(queryScores);

			// Extract unique quality profile IDs for override fetching
			// templateId format: instanceId-profileId
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

			// Fetch overrides for all quality profiles
			void fetchOverridesForProfiles(profileIdArray);
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

		// Update the display immediately
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

		// Group score changes by quality profile (templateId format: {instanceId}-{profileId})
		const profileUpdates = new Map<string, Array<{ cfTrashId: string; score: number }>>();

		for (const [cfTrashId, templateScores] of modifiedScores.entries()) {
			for (const [templateId, newScore] of templateScores.entries()) {
				if (!profileUpdates.has(templateId)) {
					profileUpdates.set(templateId, []);
				}
				profileUpdates.get(templateId)!.push({ cfTrashId, score: newScore });
			}
		}

		// Build entries for the bulk update mutation
		const entries: BulkScoreUpdateEntry[] = Array.from(profileUpdates.entries()).map(
			([templateId, changes]) => {
				// Parse templateId to get profileId (format: instanceId-profileId)
				const profileId = parseInt(templateId.split("-").pop() || "0");
				return {
					profileId,
					instanceId,
					changes,
				};
			}
		);

		const changeCount = modifiedScores.size;

		try {
			await bulkUpdateScores.mutateAsync(entries);
			toast.success(
				`Successfully saved ${changeCount} custom format score change${changeCount === 1 ? "" : "s"}`
			);
			setModifiedScores(new Map());
			await queryClient.invalidateQueries({ queryKey: ["bulk-scores"] });
			onOperationComplete?.();
		} catch (error) {
			console.error("Error saving scores:", error);
			toast.error(error instanceof Error ? error.message : "Failed to save scores");
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

		// Extract profileId from templateId (format: instanceId-profileId)
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

			// Refresh scores to show updated values
			await queryClient.invalidateQueries({ queryKey: ["bulk-scores"] });
			toast.success(`Override removed for "${customFormatName}"`);
		} catch (error) {
			console.error("Failed to delete override:", error);
			toast.error(error instanceof Error ? error.message : "Failed to delete override");
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

		// Group selected CFs by quality profile to handle multi-profile scenarios
		// Map: profileId -> Set of customFormatIds
		const profileToCFs = new Map<number, Set<number>>();

		for (const trashId of selectedCFs) {
			const cfId = parseInt(trashId.replace('cf-', ''));
			if (isNaN(cfId)) continue;

			// Find all profiles that have overrides for this CF
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

		// Build confirmation message with profile breakdown
		const profileCount = profileToCFs.size;
		const totalOverrides = Array.from(profileToCFs.values()).reduce((sum, cfs) => sum + cfs.size, 0);
		const confirmMessage = profileCount === 1
			? `Reset ${totalOverrides} override(s) to template defaults?\n\nThis will remove instance-level overrides.`
			: `Reset ${totalOverrides} override(s) across ${profileCount} quality profiles to template defaults?\n\nThis will remove instance-level overrides for the selected custom formats in all affected profiles.`;

		if (!confirm(confirmMessage)) {
			return;
		}

		try {
			// Reset overrides for each profile in parallel
			const resetPromises = Array.from(profileToCFs.entries()).map(([profileId, cfIds]) =>
				bulkDeleteOverrides.mutateAsync({
					instanceId,
					qualityProfileId: profileId,
					payload: { customFormatIds: Array.from(cfIds) },
				})
			);

			const results = await Promise.all(resetPromises);
			const totalDeleted = results.reduce((sum, r) => sum + (r.deletedCount || 0), 0);

			// Clear selection
			setSelectedCFs(new Set());

			// Refresh scores
			await queryClient.invalidateQueries({ queryKey: ["bulk-scores"] });

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

	// Filtered scores (client-side filtering already done by search and modifiedOnly)
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
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-2xl font-semibold text-fg">Bulk Score Management</h2>
					<p className="text-sm text-fg/70">
						Manage custom format scores across multiple templates
					</p>
				</div>
			</div>

			{/* Filters */}
			<div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-subtle p-4 sm:flex-row sm:items-center sm:flex-wrap">
				<Select
					value={instanceId}
					onChange={(e) => setInstanceId(e.target.value)}
					className="min-w-[200px]"
				>
					<SelectOption value="">Select Instance</SelectOption>
					{instances
						.filter((instance) => instance.service === "radarr" || instance.service === "sonarr")
						.map((instance) => (
							<SelectOption key={instance.id} value={instance.id}>
								{instance.label} ({instance.service.toUpperCase()})
							</SelectOption>
						))}
				</Select>

				<div className="flex-1 min-w-[200px]">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-fg/40" />
						<Input
							type="text"
							placeholder="Search custom formats..."
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							className="w-full pl-10"
						/>
					</div>
				</div>

				<label className="flex items-center gap-2 px-4 py-2 rounded-lg bg-bg-subtle cursor-pointer hover:bg-bg-hover text-sm text-fg whitespace-nowrap">
					<input
						type="checkbox"
						checked={modifiedOnly}
						onChange={(e) => setModifiedOnly(e.target.checked)}
						className="rounded border-border"
					/>
					<span>Modified Only</span>
				</label>

				{isLoading && (
					<div className="flex items-center gap-2 text-sm text-fg/60">
						<div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
						<span>Loading...</span>
					</div>
				)}
			</div>

			{/* Save/Discard Changes Bar */}
			{modifiedScores.size > 0 && (
				<div className="rounded-lg border border-primary/30 bg-primary/10 p-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20">
								<span className="text-sm font-semibold text-primary">{modifiedScores.size}</span>
							</div>
							<p className="text-sm text-fg">
								{modifiedScores.size} custom format{modifiedScores.size === 1 ? '' : 's'} modified
							</p>
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={handleDiscardChanges}
								disabled={bulkUpdateScores.isPending}
								className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-4 py-2 text-sm font-medium text-fg transition hover:bg-bg-hover disabled:opacity-50"
							>
								Discard Changes
							</button>
							<button
								type="button"
								onClick={handleSaveChanges}
								disabled={bulkUpdateScores.isPending}
								className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-fg transition hover:bg-primary/90 disabled:opacity-50"
							>
								<Save className="h-4 w-4" />
								{bulkUpdateScores.isPending ? "Saving..." : "Save Changes"}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Bulk Reset Bar */}
			{selectedCFs.size > 0 && (
				<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-500/20">
								<span className="text-sm font-semibold text-amber-400">{selectedCFs.size}</span>
							</div>
							<p className="text-sm text-fg">
								{selectedCFs.size} custom format{selectedCFs.size === 1 ? '' : 's'} selected
							</p>
						</div>
						<button
							type="button"
							onClick={handleBulkResetToTemplate}
							className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-fg transition hover:bg-amber-700"
						>
							<RotateCcw className="h-4 w-4" />
							Reset to Template
						</button>
					</div>
				</div>
			)}

			{/* Scores Table */}
			<div className="overflow-x-auto rounded-lg border border-border">
				<table className="w-full table-fixed">
					<thead className="border-b border-border bg-bg-subtle">
						<tr>
							<th className="sticky left-0 z-20 w-12 bg-bg-subtle px-3 py-3 text-center">
								<input
									type="checkbox"
									checked={filteredScores.length > 0 && selectedCFs.size === filteredScores.length}
									onChange={toggleSelectAll}
									className="rounded border-border"
									title="Select/deselect all"
								/>
							</th>
							<th className="sticky left-12 z-10 w-64 bg-bg-subtle px-4 py-3 text-left text-sm font-medium text-fg">
								Custom Format
							</th>
							{/* Dynamic columns for each unique template */}
							{filteredScores.length > 0 &&
								filteredScores[0]?.templateScores.map((templateScore) => (
									<th
										key={templateScore.templateId}
										className="w-24 px-3 py-3 text-center text-sm font-medium text-fg"
									>
										<div className="flex flex-col gap-0.5">
											<div className="text-xs text-fg/90">{templateScore.qualityProfileName}</div>
											<div className="text-xs font-normal text-fg/50">
												{templateScore.templateName}
											</div>
										</div>
									</th>
								))}
						</tr>
					</thead>
					<tbody>
						{filteredScores.length === 0 ? (
							<tr>
								<td colSpan={100} className="px-4 py-8 text-center text-fg/60">
									{instanceId ? "No scores found for this instance." : "Select an instance to view scores."}
								</td>
							</tr>
						) : (
							filteredScores.map((score) => (
								<tr
									key={score.trashId}
									className="border-t border-border transition hover:bg-bg-subtle"
								>
									<td className="sticky left-0 z-20 bg-bg-subtle px-3 py-2 text-center hover:bg-bg-subtle">
										<input
											type="checkbox"
											checked={selectedCFs.has(score.trashId)}
											onChange={() => toggleCFSelection(score.trashId)}
											className="rounded border-border"
										/>
									</td>
									<td className="sticky left-12 z-10 bg-bg-subtle px-4 py-2 text-sm text-fg hover:bg-bg-subtle">
										<div className="flex items-center gap-2">
											<span>{score.name}</span>
											{score.hasAnyModifications && (
												<span className="text-xs text-yellow-400" title="Has modifications">
													⚠️
												</span>
											)}
										</div>
									</td>
									{/* Editable score cells for each template */}
									{score.templateScores.map((templateScore) => {
										// Extract CF ID from trashId (format: "cf-{id}")
										const cfId = parseInt(score.trashId.replace('cf-', ''));
										// Extract profile ID from templateId
										const parts = templateScore.templateId.split('-');
										const lastPart = parts[parts.length - 1];
										const profileId = parseInt(lastPart || '0');

										// Check if this CF has an instance-level override for this profile
										const overrideKey = `${profileId}-${cfId}`;
										const hasOverride = overrideMap.has(overrideKey);

										// Only show override UI for template-managed profiles
										const showOverrideUI = hasOverride && templateScore.isTemplateManaged;

										return (
											<td key={templateScore.templateId} className="px-2 py-1">
												<div className="relative">
													<input
														type="number"
														value={templateScore.currentScore}
														onChange={(e) => {
															const newScore = parseInt(e.target.value) || 0;
															handleScoreChange(score.trashId, templateScore.templateId, newScore);
														}}
														className={`w-full rounded border px-2 py-1 text-center text-sm transition ${
															showOverrideUI
																? "border-blue-500/50 bg-blue-500/10 font-semibold text-blue-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
																: templateScore.isModified
																? "border-yellow-500/50 bg-yellow-500/10 font-semibold text-yellow-200 focus:border-yellow-500 focus:ring-1 focus:ring-yellow-500"
																: "border-border bg-bg-subtle text-fg/70 focus:border-primary focus:ring-1 focus:ring-primary"
														}`}
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
															className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 border border-border text-fg hover:bg-blue-600 transition"
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

			{/* Summary */}
			<div className="text-sm text-fg/60">
				Showing {filteredScores.length} custom format{filteredScores.length === 1 ? '' : 's'}
				{modifiedScores.size > 0 && ` • ${modifiedScores.size} unsaved change${modifiedScores.size === 1 ? '' : 's'}`}
			</div>
		</div>
	);
}
