"use client";

import { Card, CardHeader, CardTitle, CardContent, Button, Badge } from "../../../components/ui";
import { useTrackedQualityProfiles, useReapplyQualityProfile } from "../../../hooks/api/useTrashGuides";
import { toast } from "../../../components/ui/toast";

export function TrackedQualityProfiles() {
	const { data, isLoading, error } = useTrackedQualityProfiles();
	const reapplyMutation = useReapplyQualityProfile();

	const trackedProfiles = data?.profiles || [];

	const handleReapply = async (instanceId: string, profileFileName: string) => {
		try {
			const result = await reapplyMutation.mutateAsync({
				instanceId,
				profileFileName,
			});
			toast.success(`Successfully re-applied quality profile (${result.action})`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to re-apply quality profile");
		}
	};

	if (isLoading) {
		return (
			<Card>
				<CardContent className="py-12">
					<div className="text-center text-fg-muted">Loading tracked quality profiles...</div>
				</CardContent>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<CardContent className="py-12">
					<div className="text-center text-danger">Failed to load tracked quality profiles</div>
				</CardContent>
			</Card>
		);
	}

	if (trackedProfiles.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Tracked Quality Profiles</CardTitle>
				</CardHeader>
				<CardContent className="py-12">
					<div className="text-center text-fg-muted">
						No quality profiles tracked yet. Apply a quality profile to start tracking.
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Tracked Quality Profiles</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{trackedProfiles.map((profile) => (
					<div
						key={profile.id}
						className="border rounded-lg p-4 border-border bg-bg-subtle/30 hover:border-primary/50 transition-colors"
					>
						<div className="flex items-start gap-4">
							<div className="flex-1 space-y-2">
								<div className="flex items-center gap-2">
									<h3 className="font-medium text-fg">{profile.profileName}</h3>
									<Badge variant="secondary" className="text-xs">
										{profile.service}
									</Badge>
									{profile.qualityProfileId && (
										<Badge variant="secondary" className="text-xs">
											Profile ID: {profile.qualityProfileId}
										</Badge>
									)}
								</div>
								<div className="flex gap-4 text-sm text-fg-muted">
									<span>Instance: {profile.instanceLabel}</span>
									<span>
										Last applied:{" "}
										{new Date(profile.lastAppliedAt).toLocaleDateString(undefined, {
											year: "numeric",
											month: "short",
											day: "numeric",
											hour: "2-digit",
											minute: "2-digit",
										})}
									</span>
								</div>
								<div className="text-xs text-fg-muted">Git ref: {profile.gitRef}</div>
							</div>

							<div className="flex gap-2 shrink-0">
								<Button
									size="sm"
									onClick={() => handleReapply(profile.serviceInstanceId, profile.profileFileName)}
									disabled={reapplyMutation.isPending}
								>
									Re-apply
								</Button>
							</div>
						</div>
					</div>
				))}

				<div className="text-sm text-fg-muted border-t border-border pt-3">
					<p>
						Showing {trackedProfiles.length} tracked quality profile
						{trackedProfiles.length !== 1 ? "s" : ""}
					</p>
					<p className="text-xs mt-1">
						Re-apply will update the quality profile with the latest version from TRaSH Guides
					</p>
				</div>
			</CardContent>
		</Card>
	);
}
