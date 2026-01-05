"use client";

import { useState } from "react";
import { useQualityProfiles } from "../../../../hooks/api/useQualityProfiles";
import { Alert, AlertDescription, EmptyState, Skeleton, Card, CardHeader, CardTitle, CardDescription, CardContent, Button } from "../../../../components/ui";
import { FileText, Star, Languages, Gauge, Info, Download, Layers } from "lucide-react";
import { THEME_GRADIENTS } from "../../../../lib/theme-gradients";
import { useColorTheme } from "../../../../providers/color-theme-provider";
import { createSanitizedHtml } from "../../../../lib/sanitize-html";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import type { CompleteQualityProfile } from "@arr/shared";
import { QualityProfileImporter } from "../quality-profile-importer";

interface QualityProfileSelectionProps {
	serviceType: "RADARR" | "SONARR";
	onSelect: (profile: QualityProfileSummary) => void;
}

export const QualityProfileSelection = ({
	serviceType,
	onSelect,
}: QualityProfileSelectionProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const [showCloneImporter, setShowCloneImporter] = useState(false);
	const { data, isLoading, error } = useQualityProfiles(serviceType);

	// Handle imported profile from cloning
	const handleProfileImported = (importedProfile: CompleteQualityProfile) => {
		// Generate unique ID using crypto if available, falling back to timestamp
		const uniqueSuffix = typeof crypto !== "undefined" && crypto.randomUUID
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

		// Count custom formats from profile items (items with negative IDs indicate custom formats)
		const customFormatCount = importedProfile.items.filter(
			(item) => item.id !== undefined && item.id < 0
		).length;

		// Use friendly instance label if available, fall back to instance ID
		const instanceDisplayName = importedProfile.sourceInstanceLabel || importedProfile.sourceInstanceId;

		// Convert CompleteQualityProfile to QualityProfileSummary format for wizard
		const profileSummary: QualityProfileSummary = {
			trashId: `cloned-${importedProfile.sourceInstanceId}-${importedProfile.sourceProfileId}-${uniqueSuffix}`,
			name: importedProfile.sourceProfileName,
			description: `Cloned from ${instanceDisplayName}`,
			scoreSet: undefined,
			customFormatCount,
			qualityCount: importedProfile.items.length,
			language: importedProfile.language?.name,
			cutoff: importedProfile.cutoffQuality?.name || "Unknown",
			upgradeAllowed: importedProfile.upgradeAllowed,
		};

		onSelect(profileSummary);
		setShowCloneImporter(false);
	};

	if (isLoading) {
		return (
			<div className="grid gap-4 md:grid-cols-2">
				<Skeleton className="h-48" />
				<Skeleton className="h-48" />
				<Skeleton className="h-48" />
				<Skeleton className="h-48" />
			</div>
		);
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertDescription>
					{error instanceof Error ? error.message : "Failed to load quality profiles"}
				</AlertDescription>
			</Alert>
		);
	}

	if (!data?.profiles.length) {
		return (
			<EmptyState
				icon={FileText}
				title="No quality profiles available"
				description="No TRaSH Guides quality profiles found for this service"
			/>
		);
	}

	// Show clone importer if user selected that option
	if (showCloneImporter) {
		return (
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<div>
						<h3 className="text-lg font-semibold text-fg">Clone from Instance</h3>
						<p className="text-sm text-fg-muted mt-1">
							Import a complete quality profile from an existing *arr instance
						</p>
					</div>
					<Button
						variant="secondary"
						onClick={() => setShowCloneImporter(false)}
					>
						Back to TRaSH Guides
					</Button>
				</div>

				<QualityProfileImporter
					serviceType={serviceType}
					onImportComplete={handleProfileImported}
					onClose={() => setShowCloneImporter(false)}
				/>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Introduction */}
			<Alert>
				<Info className="h-4 w-4" />
				<AlertDescription>
					<strong>Quality profiles</strong> are expert-curated configurations from TRaSH Guides that define quality preferences, custom format rules, and scoring systems. Choose a profile that matches your quality preferences.
				</AlertDescription>
			</Alert>

			{/* Source Selection */}
			<div className="flex gap-3">
				<Card className="flex-1 border-primary shadow-md bg-primary/5">
					<CardContent className="pt-6">
						<div className="flex items-center gap-3">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/20">
								<Layers className="h-5 w-5 text-primary" />
							</div>
							<div className="flex-1">
								<div className="font-medium text-fg">TRaSH Guides Profiles</div>
								<div className="text-xs text-fg-muted mt-0.5">
									Expert-curated configurations (selected)
								</div>
							</div>
						</div>
					</CardContent>
				</Card>

				<Card
					className="flex-1 cursor-pointer transition-all hover:border-primary hover:shadow-md"
					onClick={() => setShowCloneImporter(true)}
				>
					<CardContent className="pt-6">
						<div className="flex items-center gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-lg"
								style={{ backgroundColor: themeGradient.fromLight }}
							>
								<Download className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div className="flex-1">
								<div className="font-medium text-fg">Clone from Instance</div>
								<div className="text-xs text-fg-muted mt-0.5">
									Import from existing *arr instance
								</div>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>

			<div className="grid gap-4 md:grid-cols-2">
				{data.profiles.map((profile) => (
					<Card
						key={profile.trashId}
						className="cursor-pointer transition-all hover:border-primary hover:shadow-lg hover:shadow-primary/10"
						onClick={() => onSelect(profile)}
					>
						<CardHeader>
							<div className="flex items-start justify-between gap-2">
								<CardTitle>{profile.name}</CardTitle>
								{profile.scoreSet && (
									<span className="rounded bg-primary/20 px-2 py-1 text-xs text-primary whitespace-nowrap">
										{profile.scoreSet}
									</span>
								)}
							</div>

							{profile.description && (
								<CardDescription
									className="line-clamp-2"
									dangerouslySetInnerHTML={createSanitizedHtml(profile.description)}
								/>
							)}
						</CardHeader>

						<CardContent>
							<div className="space-y-3">
								<div className="flex flex-wrap gap-3 text-xs text-fg-muted">
									<span className="inline-flex items-center gap-1">
										<Star className="h-3 w-3" />
										{profile.customFormatCount} formats
									</span>
									<span className="inline-flex items-center gap-1">
										<Gauge className="h-3 w-3" />
										{profile.qualityCount} qualities
									</span>
									{profile.language && (
										<span className="inline-flex items-center gap-1">
											<Languages className="h-3 w-3" />
											{profile.language}
										</span>
									)}
								</div>

								<div className="flex items-center justify-between text-xs">
									<span className="text-fg-muted">Cutoff: {profile.cutoff}</span>
									<span
										className={`rounded px-2 py-1 ${
											profile.upgradeAllowed
												? "bg-green-500/20 text-green-300"
												: "bg-bg-hover text-fg-muted"
										}`}
									>
										{profile.upgradeAllowed ? "Upgrades On" : "Upgrades Off"}
									</span>
								</div>
							</div>
						</CardContent>
					</Card>
				))}
			</div>
		</div>
	);
};
