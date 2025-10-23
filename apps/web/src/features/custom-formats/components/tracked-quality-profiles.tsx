"use client";

import React, { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge } from "../../../components/ui";
import { useTrackedQualityProfiles, useReapplyQualityProfile, useUntrackQualityProfile } from "../../../hooks/api/useTrashGuides";
import { toast } from "../../../components/ui/toast";
import { Trash2 } from "lucide-react";

export const TrackedQualityProfiles = React.memo(function TrackedQualityProfiles() {
	const { data, isLoading, error } = useTrackedQualityProfiles();
	const reapplyMutation = useReapplyQualityProfile();
	const untrackMutation = useUntrackQualityProfile();
	const [untrackingId, setUntrackingId] = useState<string | null>(null);

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

	const handleUntrack = async (instanceId: string, profileFileName: string, profileName: string) => {
		if (!confirm(`Are you sure you want to untrack "${profileName}"?\n\nThis will:\n- Remove tracking for this quality profile\n- Convert associated custom formats to individual tracking\n- NOT delete any custom formats from your instance`)) {
			return;
		}

		setUntrackingId(`${instanceId}-${profileFileName}`);
		try {
			const result = await untrackMutation.mutateAsync({
				instanceId,
				profileFileName,
			});
			toast.success(`${result.message} (${result.convertedCFs} CFs converted to individual tracking)`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to untrack quality profile");
		} finally {
			setUntrackingId(null);
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
								<div className="flex gap-2 items-center text-xs text-fg-muted">
									<span>Git ref: {profile.gitRef}</span>
									{profile.commitSha && (
										<Badge variant="secondary" className="text-xs font-mono">
											{profile.commitSha.slice(0, 7)}
										</Badge>
									)}
								</div>
							</div>

							<div className="flex gap-2 shrink-0">
								<Button
									size="sm"
									onClick={() => handleReapply(profile.serviceInstanceId, profile.profileFileName)}
									disabled={reapplyMutation.isPending || untrackingId === `${profile.serviceInstanceId}-${profile.profileFileName}`}
								>
									Re-apply
								</Button>
								<Button
									size="sm"
									variant="danger"
									onClick={() => handleUntrack(profile.serviceInstanceId, profile.profileFileName, profile.profileName)}
									disabled={untrackingId === `${profile.serviceInstanceId}-${profile.profileFileName}`}
									title="Stop tracking this quality profile"
								>
									{untrackingId === `${profile.serviceInstanceId}-${profile.profileFileName}` ? (
										"Untracking..."
									) : (
										<>
											<Trash2 className="w-4 h-4" />
										</>
									)}
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
});
