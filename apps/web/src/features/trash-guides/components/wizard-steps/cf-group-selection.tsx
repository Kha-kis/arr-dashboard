"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, Skeleton } from "../../../../components/ui";
import { ChevronRight, ChevronLeft, ChevronDown, Info, CheckCircle2, Star } from "lucide-react";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { apiRequest } from "../../../../lib/api-client/base";

interface CFGroupSelectionProps {
	serviceType: "RADARR" | "SONARR";
	qualityProfile: QualityProfileSummary;
	initialSelection: Set<string>;
	onNext: (selectedGroups: Set<string>) => void;
	onBack: () => void;
	onSkip?: () => void;
}

export const CFGroupSelection = ({
	serviceType,
	qualityProfile,
	initialSelection,
	onNext,
	onBack,
	onSkip,
}: CFGroupSelectionProps) => {
	const [selectedGroups, setSelectedGroups] = useState<Set<string>>(initialSelection);
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

	const { data, isLoading, error } = useQuery({
		queryKey: ["quality-profile-details", serviceType, qualityProfile.trashId],
		queryFn: async () => {
			return await apiRequest<any>(
				`/api/trash-guides/quality-profiles/${serviceType}/${qualityProfile.trashId}`,
			);
		},
	});

	// Get profile formatItems for displaying which CFs will be enabled
	const profileFormatIds = data?.profile?.formatItems
		? Object.values(data.profile.formatItems)
		: [];

	// Auto-select recommended groups on initial load
	useEffect(() => {
		if (data?.cfGroups && selectedGroups.size === 0 && initialSelection.size === 0) {
			// Auto-select groups that are "required" or have high priority for this profile
			const recommendedGroups = data.cfGroups
				.filter((group: any) => {
					// Check if group is marked as required or has high score
					const hasHighScore = group.quality_profiles?.score && group.quality_profiles.score > 0;
					return hasHighScore;
				})
				.map((g: any) => g.trash_id);

			if (recommendedGroups.length > 0) {
				setSelectedGroups(new Set(recommendedGroups));
			}
		}
	}, [data]);

	const toggleGroup = (groupTrashId: string) => {
		setSelectedGroups((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(groupTrashId)) {
				newSet.delete(groupTrashId);
			} else {
				newSet.add(groupTrashId);
			}
			return newSet;
		});
	};

	const toggleExpand = (groupTrashId: string) => {
		setExpandedGroups((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(groupTrashId)) {
				newSet.delete(groupTrashId);
			} else {
				newSet.add(groupTrashId);
			}
			return newSet;
		});
	};

	const selectAll = () => {
		setSelectedGroups(new Set(data?.cfGroups.map((g: any) => g.trash_id) || []));
	};

	const deselectAll = () => {
		setSelectedGroups(new Set());
	};

	if (isLoading) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-32" />
				<Skeleton className="h-48" />
				<Skeleton className="h-48" />
			</div>
		);
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertDescription>
					{error instanceof Error
						? error.message
						: "Failed to load quality profile details"}
				</AlertDescription>
			</Alert>
		);
	}

	const cfGroups = data?.cfGroups || [];

	return (
		<div className="space-y-6">
			{/* Introduction */}
			<div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
				<h4 className="font-medium text-white mb-2">🎯 TRaSH Guides Recommendations</h4>
				<p className="text-sm text-white/70 mb-3">
					TRaSH Guides has pre-configured this quality profile with specific Custom Format Groups. <strong className="text-white">Groups marked as "Recommended" are suggested by TRaSH for optimal results.</strong>
				</p>
				<div className="space-y-2 text-sm text-white/70 ml-4 mb-3">
					<div>• <strong className="text-white">✅ Enabled CFs</strong> - Will be automatically enabled based on TRaSH recommendations</div>
					<div>• <strong className="text-white">⚪ Available CFs</strong> - Optional formats you can enable in the next step</div>
					<div>• <strong className="text-white">🔒 Required CFs</strong> - Must be enabled for this profile</div>
				</div>
				<p className="text-xs text-white/60 italic">
					💡 Tip: Start with recommended groups. Expand each group to see exactly which Custom Formats will be enabled.
				</p>
			</div>

			{/* Overview */}
			<div className="rounded-xl border border-white/10 bg-white/5 p-6">
				<h3 className="text-lg font-medium text-white">{qualityProfile.name}</h3>
				<p className="mt-2 text-sm text-white/70">
					The following Custom Format Groups are applicable to this quality profile. Select the ones you want to include.
				</p>
				<div className="mt-4 flex items-center gap-2 text-sm text-white/60">
					<Info className="h-4 w-4" />
					<span>
						{cfGroups.length} CF Groups available • {selectedGroups.size} selected
					</span>
				</div>
			</div>

			{/* Bulk Actions */}
			<div className="flex gap-2">
				<button
					type="button"
					onClick={selectAll}
					className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
				>
					Select All
				</button>
				<button
					type="button"
					onClick={deselectAll}
					className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
				>
					Deselect All
				</button>
			</div>

			{/* CF Groups List */}
			<div className="space-y-3">
				{cfGroups.map((group: any) => {
					const isSelected = selectedGroups.has(group.trash_id);
					const isExpanded = expandedGroups.has(group.trash_id);
					const cfCount = Array.isArray(group.custom_formats)
						? group.custom_formats.length
						: 0;

					// Get Custom Format names from the group
					const customFormats = Array.isArray(group.custom_formats)
						? group.custom_formats
						: [];

					// Check if this group is recommended (has positive score)
					const isRecommended = group.quality_profiles?.score && group.quality_profiles.score > 0;

					// Count how many CFs from this group will be enabled
					const enabledCFsCount = customFormats.filter((cf: any) => {
						const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
						const isRequired = typeof cf === 'object' && cf.required === true;
						const isInProfile = profileFormatIds.includes(cfTrashId);
						return isRequired || isInProfile;
					}).length;

					return (
						<div
							key={group.trash_id}
							className={`rounded-xl border transition ${
								isSelected
									? "border-primary bg-primary/10"
									: "border-white/10 bg-white/5"
							}`}
						>
							<div className="flex items-start gap-4 p-6">
								{/* Selection Checkbox */}
								<input
									type="checkbox"
									checked={isSelected}
									onChange={() => toggleGroup(group.trash_id)}
									className="mt-1 h-5 w-5 rounded border-white/20 bg-white/10 text-primary focus:ring-primary"
								/>

								<div className="flex-1">
									<div className="flex items-start justify-between">
										<div className="flex-1">
											<div className="flex items-center gap-2 flex-wrap">
												<h4 className="font-medium text-white">{group.name}</h4>
												{isRecommended && (
													<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
														<Star className="h-3 w-3" />
														Recommended
													</span>
												)}
											</div>

											{group.trash_description && (
												<p
													className="mt-2 text-sm text-white/70"
													dangerouslySetInnerHTML={{
														__html: group.trash_description,
													}}
												/>
											)}

											<div className="mt-3 flex items-center gap-3 text-xs text-white/60">
												<span>{cfCount} Custom Formats</span>
												{enabledCFsCount > 0 && (
													<>
														<span>•</span>
														<span className="text-green-400">
															✅ {enabledCFsCount} will be enabled
														</span>
													</>
												)}
												{group.quality_profiles?.score && (
													<>
														<span>•</span>
														<span>Score: {group.quality_profiles.score}</span>
													</>
												)}
											</div>
										</div>

										{/* Expand/Collapse Button */}
										<button
											type="button"
											onClick={() => toggleExpand(group.trash_id)}
											className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white transition"
										>
											<ChevronDown
												className={`h-5 w-5 transition-transform ${
													isExpanded ? "rotate-180" : ""
												}`}
											/>
										</button>
									</div>

									{/* Expanded Custom Formats List */}
									{isExpanded && customFormats.length > 0 && (
										<div className="mt-4 space-y-2 border-t border-white/10 pt-4">
											<p className="text-xs font-medium text-white/70 uppercase tracking-wide">
												Custom Formats in this group:
											</p>
											<div className="space-y-1">
												{customFormats.map((cf: any) => {
													const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
													const cfName = typeof cf === 'string' ? cf : cf.name;
													const isRequired = typeof cf === 'object' && cf.required === true;
													const isInProfile = profileFormatIds.includes(cfTrashId);
													const willBeEnabled = isRequired || isInProfile;

													return (
														<div
															key={cfTrashId}
															className={`rounded px-3 py-2 text-sm flex items-center justify-between ${
																willBeEnabled
																	? "bg-green-500/10 border border-green-500/30 text-green-200"
																	: "bg-white/5 text-white/70"
															}`}
														>
															<div className="flex items-center gap-2">
																<span className="text-lg">
																	{willBeEnabled ? "✅" : "⚪"}
																</span>
																<span>{cfName}</span>
															</div>
															{isRequired && (
																<span className="rounded bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-300">
																	Required
																</span>
															)}
														</div>
													);
												})}
											</div>
											<p className="mt-3 text-xs text-white/60 italic">
												✅ Green items will be enabled by default based on TRaSH recommendations
												<br />
												⚪ Gray items are available but not recommended for this profile
											</p>
										</div>
									)}
								</div>
							</div>
						</div>
					);
				})}
			</div>

			{cfGroups.length === 0 && (
				<div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center">
					<p className="text-white/60">
						No Custom Format Groups available for this quality profile.
					</p>
				</div>
			)}

			{/* Navigation */}
			<div className="flex items-center justify-between border-t border-white/10 pt-6">
				<button
					type="button"
					onClick={onBack}
					className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
				>
					<ChevronLeft className="h-4 w-4" />
					Back
				</button>

				<div className="flex items-center gap-2">
					{onSkip && (
						<button
							type="button"
							onClick={onSkip}
							className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
							title="Skip group selection and customize individual formats"
						>
							Skip (Power User)
						</button>
					)}
					<button
						type="button"
						onClick={() => onNext(selectedGroups)}
						className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90"
					>
						Next: Customize Formats
						<ChevronRight className="h-4 w-4" />
					</button>
				</div>
			</div>
		</div>
	);
};
