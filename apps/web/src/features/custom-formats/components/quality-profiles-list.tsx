"use client";

import React, { useState, useMemo } from "react";
import DOMPurify from "dompurify";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Input, toast } from "../../../components/ui";
import { useTrashQualityProfiles, useApplyQualityProfile, useTrackedQualityProfiles, useReapplyQualityProfile } from "../../../hooks/api/useTrashGuides";
import type { TrashQualityProfile } from "../../../lib/api-client/trash-guides";

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

	// Fetch quality profiles for the selected service
	const { data, isLoading, error } = useTrashQualityProfiles(service || "RADARR");
	const { data: trackedData } = useTrackedQualityProfiles();
	const applyProfileMutation = useApplyQualityProfile();
	const reapplyProfileMutation = useReapplyQualityProfile();

	const qualityProfiles = data?.qualityProfiles || [];

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

	const handleApplyProfile = async (profile: TrashQualityProfile) => {
		if (!service) return;

		const isTracked = trackedProfiles.has(profile.fileName);

		try {
			if (isTracked) {
				// Re-apply tracked profile
				await reapplyProfileMutation.mutateAsync({
					instanceId,
					profileFileName: profile.fileName,
				});
				toast.success(`Successfully re-applied quality profile: ${profile.name} to ${instanceLabel}`);
			} else {
				// Apply new profile
				await applyProfileMutation.mutateAsync({
					instanceId,
					profileFileName: profile.fileName,
					service,
				});
				toast.success(`Successfully applied quality profile: ${profile.name} to ${instanceLabel}`);
			}
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
					<div className="space-y-2">
						{filteredProfiles.length === 0 ? (
							<div className="flex items-center justify-center py-12">
								<p className="text-fg-muted">
									{searchQuery
										? "No quality profiles match your search"
										: "No quality profiles available"}
								</p>
							</div>
						) : (
							filteredProfiles.map((profile) => (
								<div
									key={profile.fileName}
									className="border rounded-lg p-4 border-border bg-bg-subtle/30 hover:border-primary/50 transition-colors"
								>
									<div className="flex items-start gap-4">
										<div className="flex-1 space-y-2">
											<div className="flex items-center gap-2 flex-wrap">
												<h3 className="font-medium text-fg">
													{profile.name}
												</h3>
												{trackedProfiles.has(profile.fileName) && (
													<Badge variant="default" className="text-xs bg-primary/20 text-primary border-primary/30">
														Tracked
													</Badge>
												)}
												{profile.upgradeAllowed !== undefined && (
													<Badge variant="secondary" className="text-xs">
														{profile.upgradeAllowed ? "Upgrades Allowed" : "No Upgrades"}
													</Badge>
												)}
											</div>
											{trackedProfiles.has(profile.fileName) && (
												<p className="text-xs text-fg-muted">
													Last applied: {new Date(trackedProfiles.get(profile.fileName)!.lastAppliedAt).toLocaleString()}
												</p>
											)}
											{profile.trash_description && (
												<div
													className="text-sm text-fg-muted prose prose-sm max-w-none prose-invert"
													dangerouslySetInnerHTML={{
														__html: sanitizeHtml(profile.trash_description)
													}}
												/>
											)}
											<div className="flex gap-2 text-xs text-fg-muted">
												{profile.minFormatScore !== undefined && (
													<span>Min Score: {profile.minFormatScore}</span>
												)}
												{profile.cutoffFormatScore !== undefined && (
													<span>Cutoff Score: {profile.cutoffFormatScore}</span>
												)}
												{profile.formatItems && profile.formatItems.length > 0 && (
													<span>{profile.formatItems.length} custom formats</span>
												)}
											</div>
										</div>

										<div className="flex gap-2 shrink-0">
											<Button
												size="sm"
												onClick={() => handleApplyProfile(profile)}
												disabled={applyProfileMutation.isPending || reapplyProfileMutation.isPending}
											>
												{trackedProfiles.has(profile.fileName) ? "Re-apply Profile" : "Apply Profile"}
											</Button>
										</div>
									</div>
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
		</Card>
	);
});
