"use client";

import { useQualityProfiles } from "../../../../hooks/api/useQualityProfiles";
import { Alert, AlertDescription, EmptyState, Skeleton, Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../../../components/ui";
import { FileText, Star, Languages, Gauge, Info } from "lucide-react";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";

interface QualityProfileSelectionProps {
	serviceType: "RADARR" | "SONARR";
	onSelect: (profile: QualityProfileSummary) => void;
}

export const QualityProfileSelection = ({
	serviceType,
	onSelect,
}: QualityProfileSelectionProps) => {
	const { data, isLoading, error } = useQualityProfiles(serviceType);

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

	return (
		<div className="space-y-6">
			{/* Introduction */}
			<Alert>
				<Info className="h-4 w-4" />
				<AlertDescription>
					<strong>Quality profiles</strong> are expert-curated configurations from TRaSH Guides that define quality preferences, custom format rules, and scoring systems. Choose a profile that matches your quality preferences.
				</AlertDescription>
			</Alert>

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
									dangerouslySetInnerHTML={{
										__html: profile.description,
									}}
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
