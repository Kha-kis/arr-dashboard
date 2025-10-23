"use client";

import React, { useState, useMemo } from "react";
import DOMPurify from "dompurify";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Input, toast } from "../../../components/ui";
import { useTrashQualityProfiles, useApplyQualityProfile, useTrackedQualityProfiles, useReapplyQualityProfile } from "../../../hooks/api/useTrashGuides";
import type { TrashQualityProfile } from "../../../lib/api-client/trash-guides";
import { QualityProfileCustomizationModalV3 as QualityProfileCustomizationModal } from "./quality-profile-customization-modal-v3";

interface QualityProfilesListProps {
	instanceId: string;
	instanceLabel: string;
	service?: "SONARR" | "RADARR";
}

export const QualityProfilesList = React.memo(function QualityProfilesList({
	instanceId,
	instanceLabel,
	service,
}: QualityProfilesListProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const [customizationModalOpen, setCustomizationModalOpen] = useState(false);
	const [selectedProfile, setSelectedProfile] = useState<TrashQualityProfile | null>(null);
	const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(new Set());

	// Fetch quality profiles for the selected service
	const { data, isLoading, error } = useTrashQualityProfiles(service || "RADARR");
	const { data: trackedData } = useTrackedQualityProfiles();
	const applyProfileMutation = useApplyQualityProfile();
	const reapplyProfileMutation = useReapplyQualityProfile();

	const qualityProfiles = data?.qualityProfiles || [];

	// Expand all descriptions by default when profiles load
	React.useEffect(() => {
		if (qualityProfiles.length > 0) {
			setExpandedDescriptions(new Set(qualityProfiles.map(p => p.fileName)));
		}
	}, [qualityProfiles]);

	// Filter tracked profiles for this instance
	const trackedProfiles = useMemo(() => {
		if (!trackedData?.profiles) return new Map();
		const map = new Map();
		trackedData.profiles
			.filter(tp => tp.serviceInstanceId === instanceId)
			.forEach(tp => {
				map.set(tp.profileFileName, tp);
			});
		return map;
	}, [trackedData, instanceId]);

	// Helper function to sanitize HTML descriptions
	const sanitizeHtml = (html: string) => {
		return DOMPurify.sanitize(html, {
			ALLOWED_TAGS: ['br', 'b', 'i', 'em', 'strong', 'a', 'p', 'ul', 'ol', 'li'],
			ALLOWED_ATTR: ['href', 'target', 'rel'],
		});
	};

	// Filter profiles by search query
	const filteredProfiles = qualityProfiles.filter((profile) =>
		profile.name.toLowerCase().includes(searchQuery.toLowerCase())
	);

	const handleApplyProfileClick = (profile: TrashQualityProfile) => {
		const isTracked = trackedProfiles.has(profile.fileName);

		if (isTracked) {
			// Re-apply tracked profile directly (no customization needed)
			handleReapplyProfile(profile);
		} else {
			// Open customization modal for new profiles
			setSelectedProfile(profile);
			setCustomizationModalOpen(true);
		}
	};

	const handleReapplyProfile = async (profile: TrashQualityProfile) => {
		if (!service) return;

		try {
			await reapplyProfileMutation.mutateAsync({
				instanceId,
				profileFileName: profile.fileName,
			});
			toast.success(`Successfully re-applied quality profile: ${profile.name} to ${instanceLabel}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to re-apply quality profile");
		}
	};

	const handleApplyWithCustomizations = async (customizations: Record<string, any>) => {
		if (!service || !selectedProfile) return;

		try {
			await applyProfileMutation.mutateAsync({
				instanceId,
				profileFileName: selectedProfile.fileName,
				service,
				customizations, // Pass customizations to backend
			});
			toast.success(`Successfully applied quality profile: ${selectedProfile.name} to ${instanceLabel}`);
			setCustomizationModalOpen(false);
			setSelectedProfile(null);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to apply quality profile");
		}
	};

	if (!service) {
		return (
			<Card>
				<CardContent className="py-12">
					<div className="text-center text-fg-muted">
						Invalid service type
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<CardTitle className="text-base">{instanceLabel}</CardTitle>
						<Badge variant="secondary" className="text-xs">
							{service}
						</Badge>
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{/* Search */}
				<div className="flex gap-3 items-center">
					<Input
						type="text"
						placeholder="Search quality profiles..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="flex-1"
					/>
				</div>

				{/* Loading state */}
				{isLoading && (
					<div className="flex items-center justify-center py-12">
						<div className="text-fg-muted">Loading TRaSH quality profiles...</div>
					</div>
				)}

				{/* Error state */}
				{error && (
					<div className="rounded-lg border border-danger bg-danger/10 px-4 py-3">
						<p className="text-sm text-danger">
							Failed to load TRaSH quality profiles. Please try again later.
						</p>
					</div>
				)}

				{/* Profiles list */}
				{!isLoading && !error && (
					<div className="space-y-1 max-h-[400px] overflow-y-auto">
						{filteredProfiles.length === 0 ? (
							<div className="flex items-center justify-center py-8">
								<p className="text-fg-muted text-sm">
									{searchQuery
										? "No quality profiles match your search"
										: "No quality profiles available"}
								</p>
							</div>
						) : (
							filteredProfiles.map((profile) => (
								<div
									key={profile.fileName}
									className="border rounded p-1.5 border-border bg-bg-subtle/30 hover:border-primary/50 transition-colors"
								>
									<div className="flex items-start gap-2">
										<div className="flex-1 min-w-0 space-y-1">
											<div className="flex items-center gap-2 flex-wrap">
												<h3 className="font-medium text-fg text-sm">
													{profile.name}
												</h3>
												{profile.trash_description && (
													<button
														type="button"
														onClick={() => {
															const expandedSet = new Set(expandedDescriptions);
															if (expandedSet.has(profile.fileName)) {
																expandedSet.delete(profile.fileName);
															} else {
																expandedSet.add(profile.fileName);
															}
															setExpandedDescriptions(expandedSet);
														}}
														className="text-primary hover:text-primary/80 transition-colors"
														title={expandedDescriptions.has(profile.fileName) ? "Hide details" : "Show details"}
													>
														<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
															<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
														</svg>
													</button>
												)}
												{trackedProfiles.has(profile.fileName) && (
													<Badge variant="default" className="text-xs bg-primary/20 text-primary border-primary/30 px-1.5 py-0">
														Tracked
													</Badge>
												)}
												{profile.upgradeAllowed !== undefined && (
													<Badge variant="secondary" className="text-xs px-1.5 py-0">
														{profile.upgradeAllowed ? "↑ Allowed" : "No ↑"}
													</Badge>
												)}
												{profile.trash_guide_url && (
													<a
														href={profile.trash_guide_url}
														target="_blank"
														rel="noopener noreferrer"
														className="text-primary hover:underline text-xs inline-flex items-center gap-0.5"
														onClick={(e) => e.stopPropagation()}
														>
															<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
																<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
															</svg>
															Guide
														</a>
												)}
											</div>
											<div className="flex gap-2 text-xs text-fg-muted items-center">
												{profile.minFormatScore !== undefined && profile.cutoffFormatScore !== undefined && (
													<span>Score: {profile.minFormatScore} - {profile.cutoffFormatScore}</span>
												)}
												{trackedProfiles.has(profile.fileName) && (
													<>
														<span>•</span>
														<span>Last: {new Date(trackedProfiles.get(profile.fileName)!.lastAppliedAt).toLocaleDateString()}</span>
													</>
												)}
											</div>
										</div>

										<Button
											size="sm"
											onClick={() => handleApplyProfileClick(profile)}
											disabled={applyProfileMutation.isPending || reapplyProfileMutation.isPending}
											className="shrink-0"
										>
											{trackedProfiles.has(profile.fileName) ? "Re-apply" : "Apply"}
										</Button>
									</div>
									{profile.trash_description && expandedDescriptions.has(profile.fileName) && (
										<div className="mt-2 p-2 bg-primary/5 border border-primary/20 rounded text-xs text-fg-muted">
											<div dangerouslySetInnerHTML={{ __html: sanitizeHtml(profile.trash_description) }} />
										</div>
									)}
								</div>
							))
						)}
					</div>
				)}

				{/* Footer info */}
				{!isLoading && !error && qualityProfiles.length > 0 && (
					<div className="text-sm text-fg-muted border-t border-border pt-3">
						<p>
							Showing {filteredProfiles.length} of {qualityProfiles.length} quality profiles from TRaSH Guides
						</p>
						<p className="text-xs mt-1">
							Source: <a
								href="https://trash-guides.info/"
								target="_blank"
								rel="noopener noreferrer"
								className="text-primary hover:underline"
							>
								trash-guides.info
							</a>
						</p>
					</div>
				)}
			</CardContent>

			{/* Customization Modal */}
			{selectedProfile && service && (
				<QualityProfileCustomizationModal
					isOpen={customizationModalOpen}
					onClose={() => {
						setCustomizationModalOpen(false);
						setSelectedProfile(null);
					}}
					profile={selectedProfile}
					service={service}
					instanceId={instanceId}
					onApply={handleApplyWithCustomizations}
					isApplying={applyProfileMutation.isPending}
				/>
			)}
		</Card>
	);
});
