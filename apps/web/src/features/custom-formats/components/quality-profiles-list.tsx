"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Input, toast } from "../../../components/ui";
import { useTrashQualityProfiles, useApplyQualityProfile } from "../../../hooks/api/useTrashGuides";
import type { TrashQualityProfile } from "../../../lib/api-client/trash-guides";

interface QualityProfilesListProps {
	instanceId: string;
	instanceLabel: string;
	service?: "SONARR" | "RADARR";
}

export function QualityProfilesList({
	instanceId,
	instanceLabel,
	service,
}: QualityProfilesListProps) {
	const [searchQuery, setSearchQuery] = useState("");

	// Fetch quality profiles for the selected service
	const { data, isLoading, error } = useTrashQualityProfiles(service || "RADARR");
	const applyProfileMutation = useApplyQualityProfile();

	const qualityProfiles = data?.qualityProfiles || [];

	// Filter profiles by search query
	const filteredProfiles = qualityProfiles.filter((profile) =>
		profile.name.toLowerCase().includes(searchQuery.toLowerCase())
	);

	const handleApplyProfile = async (profile: TrashQualityProfile) => {
		if (!service) return;

		try {
			await applyProfileMutation.mutateAsync({
				instanceId,
				profileFileName: profile.fileName,
				service,
			});
			toast.success(`Successfully applied quality profile: ${profile.name} to ${instanceLabel}`);
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
											<div className="flex items-center gap-2">
												<h3 className="font-medium text-fg">
													{profile.name}
												</h3>
												{profile.upgradeAllowed !== undefined && (
													<Badge variant="secondary" className="text-xs">
														{profile.upgradeAllowed ? "Upgrades Allowed" : "No Upgrades"}
													</Badge>
												)}
											</div>
											{profile.trash_description && (
												<p className="text-sm text-fg-muted">
													{profile.trash_description}
												</p>
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
												disabled={applyProfileMutation.isPending}
											>
												Apply Profile
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
}
