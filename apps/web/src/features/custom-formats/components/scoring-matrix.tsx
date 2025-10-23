/**
 * Scoring Matrix Component
 * Visual matrix for managing custom format scores across quality profiles
 */

"use client";

import React, { useState, useEffect } from "react";
import { useCustomFormats } from "../../../hooks/api/useCustomFormats";
import { useQualityProfiles, useUpdateProfileScores } from "../../../hooks/api/useQualityProfiles";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Button, toast, Badge } from "../../../components/ui";

interface ScoringMatrixProps {
	instanceId: string;
	instanceLabel: string;
}

/**
 * Scoring Matrix for a single instance
 * Shows custom formats as rows and quality profiles as columns
 */
const ScoringMatrixComponent = ({ instanceId, instanceLabel }: ScoringMatrixProps) => {
	const { data: customFormatsData, isLoading: isLoadingFormats } = useCustomFormats(instanceId);
	const { data: profilesData, isLoading: isLoadingProfiles } = useQualityProfiles(instanceId);
	const updateScores = useUpdateProfileScores();

	// Local state for score editing
	const [scores, setScores] = useState<Record<string, number>>({});
	const [hasChanges, setHasChanges] = useState(false);

	// Get custom formats and profiles for this instance
	const customFormats = customFormatsData?.instances?.find(
		(i) => i.instanceId === instanceId
	)?.customFormats || [];
	const profiles = profilesData?.profiles || [];

	// Initialize scores from quality profiles
	useEffect(() => {
		if (!profiles.length) return;

		const initialScores: Record<string, number> = {};
		for (const profile of profiles) {
			for (const formatItem of profile.formatItems || []) {
				const key = `${profile.id}-${formatItem.format}`;
				initialScores[key] = formatItem.score;
			}
		}
		setScores(initialScores);
		setHasChanges(false);
	}, [profiles]);

	const getScore = (profileId: number, formatId: number): number => {
		const key = `${profileId}-${formatId}`;
		return scores[key] ?? 0;
	};

	const setScore = (profileId: number, formatId: number, score: number) => {
		const key = `${profileId}-${formatId}`;
		setScores((prev) => ({
			...prev,
			[key]: score,
		}));
		setHasChanges(true);
	};

	const handleSave = async () => {
		// Group score updates by profile
		const updatesByProfile = new Map<number, Array<{ customFormatId: number; score: number }>>();

		for (const profile of profiles) {
			const profileScores: Array<{ customFormatId: number; score: number }> = [];

			for (const format of customFormats) {
				if (!format.id) continue;

				const score = getScore(profile.id!, format.id);
				profileScores.push({
					customFormatId: format.id,
					score,
				});
			}

			if (profileScores.length > 0) {
				updatesByProfile.set(profile.id!, profileScores);
			}
		}

		// Update each profile
		try {
			const updatePromises = Array.from(updatesByProfile.entries()).map(
				([profileId, customFormatScores]) =>
					updateScores.mutateAsync({
						instanceId,
						profileId,
						customFormatScores,
					})
			);

			await Promise.all(updatePromises);
			toast.success("Scores updated successfully");
			setHasChanges(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update scores"
			);
		}
	};

	const handleReset = () => {
		// Reset to original scores from profiles
		const originalScores: Record<string, number> = {};
		for (const profile of profiles) {
			for (const formatItem of profile.formatItems || []) {
				const key = `${profile.id}-${formatItem.format}`;
				originalScores[key] = formatItem.score;
			}
		}
		setScores(originalScores);
		setHasChanges(false);
	};

	if (isLoadingFormats || isLoadingProfiles) {
		return (
			<Card>
				<CardContent className="py-12">
					<div className="text-center text-fg-muted">
						Loading scoring matrix...
					</div>
				</CardContent>
			</Card>
		);
	}

	if (customFormats.length === 0) {
		return (
			<Card>
				<CardContent className="py-12">
					<div className="text-center space-y-2">
						<p className="text-fg-muted">No custom formats found</p>
						<p className="text-sm text-fg-subtle">
							Create custom formats first to manage their scores
						</p>
					</div>
				</CardContent>
			</Card>
		);
	}

	if (profiles.length === 0) {
		return (
			<Card>
				<CardContent className="py-12">
					<div className="text-center space-y-2">
						<p className="text-fg-muted">No quality profiles found</p>
						<p className="text-sm text-fg-subtle">
							Configure quality profiles in your {instanceLabel} instance
						</p>
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>Scoring Matrix - {instanceLabel}</CardTitle>
						<CardDescription>
							Assign scores to custom formats for each quality profile
						</CardDescription>
					</div>
					<div className="flex gap-2">
						{hasChanges && (
							<Button
								variant="ghost"
								onClick={handleReset}
								disabled={updateScores.isPending}
							>
								Reset
							</Button>
						)}
						<Button
							onClick={handleSave}
							disabled={!hasChanges || updateScores.isPending}
						>
							{updateScores.isPending ? "Saving..." : "Save Changes"}
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				<div className="overflow-x-auto">
					<table className="w-full border-collapse">
						<thead>
							<tr className="border-b-2 border-border">
								<th className="text-left p-3 text-sm font-medium text-fg sticky left-0 bg-bg z-10 min-w-[200px]">
									Custom Format
								</th>
								{profiles.map((profile) => (
									<th
										key={profile.id}
										className="text-center p-3 text-sm font-medium text-fg min-w-[120px]"
									>
										<div className="flex flex-col items-center gap-1">
											<span>{profile.name}</span>
											{profile.upgradeAllowed && (
												<Badge variant="secondary" className="text-xs">
													Upgrades
												</Badge>
											)}
										</div>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{customFormats.map((format) => (
								<tr
									key={format.id}
									className="border-b border-border hover:bg-bg-subtle/30 transition-colors"
								>
									<td className="p-3 text-sm text-fg sticky left-0 bg-bg">
										<div className="font-medium truncate" title={format.name}>
											{format.name}
										</div>
										<div className="text-xs text-fg-muted">
											{format.specifications?.length || 0} spec
											{format.specifications?.length !== 1 ? "s" : ""}
										</div>
									</td>
									{profiles.map((profile) => (
										<td key={profile.id} className="p-2 text-center">
											<input
												type="number"
												value={getScore(profile.id!, format.id!)}
												onChange={(e) =>
													setScore(
														profile.id!,
														format.id!,
														Number(e.target.value)
													)
												}
												className="w-20 px-2 py-1.5 text-center rounded border border-border bg-bg text-fg text-sm focus:ring-2 focus:ring-primary focus:ring-offset-1 focus:border-primary transition-all"
												step="1"
											/>
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>

				{/* Info section */}
				<div className="mt-4 p-4 rounded-lg border border-border bg-bg-subtle/30 space-y-2">
					<p className="text-sm text-fg">
						<strong>How scoring works:</strong>
					</p>
					<ul className="text-sm text-fg-muted space-y-1 list-disc list-inside">
						<li>
							Positive scores increase priority for releases matching that format
						</li>
						<li>
							Negative scores decrease priority or reject releases
						</li>
						<li>
							Zero score means the format is tracked but doesn&apos;t affect priority
						</li>
						<li>
							Total score from all matching formats determines release selection
						</li>
					</ul>
				</div>
			</CardContent>
		</Card>
	);
};

export const ScoringMatrix = React.memo(ScoringMatrixComponent);
ScoringMatrix.displayName = 'ScoringMatrix';
