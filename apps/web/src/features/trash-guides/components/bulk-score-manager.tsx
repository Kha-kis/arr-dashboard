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
import { Search, Save, ArrowUpCircle, X, RotateCcw } from "lucide-react";
import type {
	CustomFormatScoreEntry,
	BulkScoreFilters,
} from "@arr/shared";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useQualityProfileOverrides, useDeleteOverride, useBulkDeleteOverrides } from "../../../hooks/api/useQualityProfileOverrides";
import { PromoteOverrideDialog } from "./promote-override-dialog";
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
	// Fetch available instances
	const { data: instances = [] } = useServicesQuery();

	// Filter state
	const [instanceId, setInstanceId] = useState<string>("");
	const [searchTerm, setSearchTerm] = useState("");
	const [modifiedOnly, setModifiedOnly] = useState(false);

	// Data state
	const [scores, setScores] = useState<CustomFormatScoreEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	// Track modified scores for saving
	const [modifiedScores, setModifiedScores] = useState<Map<string, Map<string, number>>>(new Map());

	// Track selected CFs for bulk operations
	const [selectedCFs, setSelectedCFs] = useState<Set<string>>(new Set());

	// Delete override hooks
	const deleteOverride = useDeleteOverride();
	const bulkDeleteOverrides = useBulkDeleteOverrides();

	// Promote override dialog state
	const [promoteDialogOpen, setPromoteDialogOpen] = useState(false);
	const [promoteData, setPromoteData] = useState<{
		qualityProfileId: number;
		customFormatId: number;
		customFormatName: string;
		currentScore: number;
		templateId: string;
		templateName: string;
	} | null>(null);

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

	// Fetch overrides for multiple quality profiles
	const fetchOverridesForProfiles = useCallback(async (profileIds: number[]) => {
		if (!instanceId || profileIds.length === 0) return;

		try {
			// Fetch overrides for each profile in parallel
			const overridePromises = profileIds.map(profileId =>
				fetch(`/api/trash-guides/instances/${instanceId}/quality-profiles/${profileId}/overrides`)
					.then(res => res.ok ? res.json() : null)
					.then(data => ({ profileId, data }))
			);

			const results = await Promise.all(overridePromises);

			// Build override map: ${profileId}-${cfId} → override data
			const newOverrides = new Map<string, { customFormatId: number; score: number }>();
			for (const result of results) {
				if (result.data?.success && result.data.overrides) {
					for (const override of result.data.overrides) {
						const key = `${result.profileId}-${override.customFormatId}`;
						newOverrides.set(key, {
							customFormatId: override.customFormatId,
							score: override.score,
						});
					}
				}
			}

			setAllOverrides(newOverrides);
		} catch (error) {
			console.error("Error fetching overrides:", error);
		}
	}, [instanceId]);

	// Fetch scores based on filters
	const fetchScores = useCallback(async () => {
		if (!instanceId) {
			return;
		}

		setIsLoading(true);
		try {
			const filters: BulkScoreFilters = {
				instanceId,
				search: searchTerm || undefined,
				modifiedOnly,
			};

			const response = await fetch(
				`/api/trash-guides/bulk-scores?${new URLSearchParams(
					Object.entries(filters).reduce((acc, [key, value]) => {
						if (value !== undefined) acc[key] = String(value);
						return acc;
					}, {} as Record<string, string>)
				)}`,
				{
					headers: { "Content-Type": "application/json" },
				}
			);

			if (!response.ok) throw new Error("Failed to fetch scores");
			const data = await response.json();
			setScores(data.data.scores);

			// Extract unique quality profile IDs for override fetching
			// templateId format: instanceId-profileId
			const profileIds = new Set<number>();
			if (data.data.scores.length > 0) {
				for (const score of data.data.scores) {
					for (const templateScore of score.templateScores) {
						const profileId = parseInt(templateScore.templateId.split('-').pop() || '0');
						if (profileId > 0) {
							profileIds.add(profileId);
						}
					}
				}
			}
			const profileIdArray = Array.from(profileIds);
			setQualityProfileIds(profileIdArray);

			// Fetch overrides for all quality profiles
			await fetchOverridesForProfiles(profileIdArray);
		} catch (error) {
			console.error("Error fetching scores:", error);
		} finally {
			setIsLoading(false);
		}
	}, [instanceId, searchTerm, modifiedOnly, fetchOverridesForProfiles]);

	// Auto-fetch scores when instance changes
	useEffect(() => {
		if (instanceId) {
			// Clear previous data and fetch new scores
			setScores([]);
			setModifiedScores(new Map());
			setSelectedCFs(new Set());
			fetchScores();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- Only trigger on instanceId change, not on filter/callback changes
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
			alert("No changes to save");
			return;
		}

		if (!instanceId) {
			alert("No instance selected");
			return;
		}

		setIsSaving(true);
		try {
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

			// Update each quality profile via the API
			const updatePromises = Array.from(profileUpdates.entries()).map(async ([templateId, changes]) => {
				// Parse templateId to get profileId (format: instanceId-profileId)
				const profileId = parseInt(templateId.split('-').pop() || '0');

				// Build the update payload
				const scoreUpdates = changes.map(({ cfTrashId, score }) => {
					// Extract CF ID from trashId (format: "cf-{id}")
					const cfId = parseInt(cfTrashId.replace('cf-', ''));
					return { customFormatId: cfId, score };
				});

				// Call the update API
				return fetch(`/api/trash-guides/instances/${instanceId}/quality-profiles/${profileId}/scores`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ scoreUpdates }),
				});
			});

			const responses = await Promise.all(updatePromises);
			const failedUpdates = responses.filter((r) => !r.ok);

			if (failedUpdates.length > 0) {
				// Get error details
				const errors = await Promise.all(
					failedUpdates.map(async (r) => {
						try {
							const body = await r.json();
							return body.error || r.statusText;
						} catch {
							return r.statusText;
						}
					})
				);
				throw new Error(`Failed to update ${failedUpdates.length} quality profile(s): ${errors.join(', ')}`);
			}

			alert(`Successfully saved ${modifiedScores.size} custom format score change${modifiedScores.size === 1 ? '' : 's'}`);
			setModifiedScores(new Map());
			await fetchScores();
			onOperationComplete?.();
		} catch (error) {
			console.error("Error saving scores:", error);
			alert(error instanceof Error ? error.message : "Failed to save scores");
		} finally {
			setIsSaving(false);
		}
	};

	// Discard unsaved changes
	const handleDiscardChanges = () => {
		if (modifiedScores.size === 0) return;

		if (confirm("Are you sure you want to discard all unsaved changes?")) {
			setModifiedScores(new Map());
			fetchScores();
		}
	};

	// Handle promote override button click
	const handlePromoteOverride = (
		templateId: string,
		customFormatId: number,
		customFormatName: string,
		currentScore: number,
		templateName: string
	) => {
		// Extract profileId from templateId (format: instanceId-profileId)
		const profileId = parseInt(templateId.split('-').pop() || '0');
		if (profileId === 0) {
			alert("Invalid quality profile ID");
			return;
		}

		// Note: For promote functionality, we need actual template IDs, not quality profile IDs
		// The current bulk-score-manager shows instance quality profiles, not templates
		// This is a design issue - we can't promote to a template without knowing which template
		// For now, we'll skip this feature in bulk-score-manager
		// Promote should be done from the instance quality profile view instead
		alert("Promote feature is not available in bulk score manager. Please use the instance quality profile view to promote overrides.");
	};

	// Handle delete individual override
	const handleDeleteOverride = async (
		templateId: string,
		customFormatId: number,
		customFormatName: string
	) => {
		if (!instanceId) {
			alert("No instance selected");
			return;
		}

		// Extract profileId from templateId (format: instanceId-profileId)
		const profileId = parseInt(templateId.split('-').pop() || '0');
		if (profileId === 0) {
			alert("Invalid quality profile ID");
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
			await fetchScores();
			alert(`Override removed for "${customFormatName}"`);
		} catch (error) {
			console.error("Failed to delete override:", error);
			alert(error instanceof Error ? error.message : "Failed to delete override");
		}
	};

	// Handle bulk reset to template
	const handleBulkResetToTemplate = async () => {
		if (!instanceId) {
			alert("No instance selected");
			return;
		}

		if (selectedCFs.size === 0) {
			alert("No custom formats selected");
			return;
		}

		// Extract profileId from first score (all should have same profile in bulk manager)
		const firstScore = scores[0];
		if (!firstScore || firstScore.templateScores.length === 0) {
			alert("No scores available");
			return;
		}

		const firstTemplateScore = firstScore.templateScores[0];
		if (!firstTemplateScore) {
			alert("No template scores available");
			return;
		}

		const firstTemplateId = firstTemplateScore.templateId;
		const profileId = parseInt(firstTemplateId.split('-').pop() || '0');
		if (profileId === 0) {
			alert("Invalid quality profile ID");
			return;
		}

		// Extract custom format IDs from selected trashIds
		const customFormatIds = Array.from(selectedCFs).map(trashId =>
			parseInt(trashId.replace('cf-', ''))
		);

		if (!confirm(`Reset ${selectedCFs.size} custom format(s) to template defaults?\n\nThis will remove instance-level overrides.`)) {
			return;
		}

		try {
			const result = await bulkDeleteOverrides.mutateAsync({
				instanceId,
				qualityProfileId: profileId,
				payload: { customFormatIds },
			});

			// Clear selection
			setSelectedCFs(new Set());

			// Refresh scores
			await fetchScores();
			alert(result.message);
		} catch (error) {
			console.error("Failed to bulk reset:", error);
			alert(error instanceof Error ? error.message : "Failed to bulk reset overrides");
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
					<h2 className="text-2xl font-semibold text-white">Bulk Score Management</h2>
					<p className="text-sm text-white/70">
						Manage custom format scores across multiple templates
					</p>
				</div>
			</div>

			{/* Filters */}
			<div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/5 p-4 sm:flex-row sm:items-center sm:flex-wrap">
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
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
						<Input
							type="text"
							placeholder="Search custom formats..."
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							className="w-full pl-10"
						/>
					</div>
				</div>

				<label className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 cursor-pointer hover:bg-white/20 text-sm text-white whitespace-nowrap">
					<input
						type="checkbox"
						checked={modifiedOnly}
						onChange={(e) => setModifiedOnly(e.target.checked)}
						className="rounded border-white/20"
					/>
					<span>Modified Only</span>
				</label>

				{isLoading && (
					<div className="flex items-center gap-2 text-sm text-white/60">
						<div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-primary" />
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
							<p className="text-sm text-white">
								{modifiedScores.size} custom format{modifiedScores.size === 1 ? '' : 's'} modified
							</p>
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={handleDiscardChanges}
								disabled={isSaving}
								className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20 disabled:opacity-50"
							>
								Discard Changes
							</button>
							<button
								type="button"
								onClick={handleSaveChanges}
								disabled={isSaving}
								className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
							>
								<Save className="h-4 w-4" />
								{isSaving ? "Saving..." : "Save Changes"}
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
							<p className="text-sm text-white">
								{selectedCFs.size} custom format{selectedCFs.size === 1 ? '' : 's'} selected
							</p>
						</div>
						<button
							type="button"
							onClick={handleBulkResetToTemplate}
							className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-700"
						>
							<RotateCcw className="h-4 w-4" />
							Reset to Template
						</button>
					</div>
				</div>
			)}

			{/* Scores Table */}
			<div className="overflow-x-auto rounded-lg border border-white/10">
				<table className="w-full table-fixed">
					<thead className="border-b border-white/10 bg-white/5">
						<tr>
							<th className="sticky left-0 z-20 w-12 bg-white/5 px-3 py-3 text-center">
								<input
									type="checkbox"
									checked={filteredScores.length > 0 && selectedCFs.size === filteredScores.length}
									onChange={toggleSelectAll}
									className="rounded border-white/20"
									title="Select/deselect all"
								/>
							</th>
							<th className="sticky left-12 z-10 w-64 bg-white/5 px-4 py-3 text-left text-sm font-medium text-white">
								Custom Format
							</th>
							{/* Dynamic columns for each unique template */}
							{filteredScores.length > 0 &&
								filteredScores[0]?.templateScores.map((templateScore) => (
									<th
										key={templateScore.templateId}
										className="w-24 px-3 py-3 text-center text-sm font-medium text-white"
									>
										<div className="flex flex-col gap-0.5">
											<div className="text-xs text-white/90">{templateScore.qualityProfileName}</div>
											<div className="text-xs font-normal text-white/50">
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
								<td colSpan={100} className="px-4 py-8 text-center text-white/60">
									{instanceId ? "No scores found for this instance." : "Select an instance to view scores."}
								</td>
							</tr>
						) : (
							filteredScores.map((score) => (
								<tr
									key={score.trashId}
									className="border-t border-white/10 transition hover:bg-white/5"
								>
									<td className="sticky left-0 z-20 bg-white/5 px-3 py-2 text-center hover:bg-white/10">
										<input
											type="checkbox"
											checked={selectedCFs.has(score.trashId)}
											onChange={() => toggleCFSelection(score.trashId)}
											className="rounded border-white/20"
										/>
									</td>
									<td className="sticky left-12 z-10 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10">
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
																: "border-white/20 bg-white/5 text-white/70 focus:border-primary focus:ring-1 focus:ring-primary"
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
															className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 border border-white/20 text-white hover:bg-blue-600 transition"
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
			<div className="text-sm text-white/60">
				Showing {filteredScores.length} custom format{filteredScores.length === 1 ? '' : 's'}
				{modifiedScores.size > 0 && ` • ${modifiedScores.size} unsaved change${modifiedScores.size === 1 ? '' : 's'}`}
			</div>
		</div>
	);
}
