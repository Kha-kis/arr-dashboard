/**
 * Quality Profile Importer Component
 *
 * Import complete quality profiles from *arr instances
 * - Select instance and profile
 * - Preview imported settings
 * - Create template from profile
 */

"use client";

import { useState } from "react";
import { Button, Alert, AlertDescription, NativeSelect, SelectOption } from "../../../components/ui";
import { useInstanceProfiles, useImportProfile } from "../../../hooks/api/useProfileClone";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import type { CompleteQualityProfile } from "@arr/shared";
import {
	Download,
	CheckCircle,
	AlertCircle,
	ChevronRight,
	Info,
} from "lucide-react";
import { getErrorMessage } from "../../../lib/error-utils";

interface QualityProfileImporterProps {
	serviceType: "RADARR" | "SONARR";
	onImportComplete?: (profile: CompleteQualityProfile) => void;
	onClose?: () => void;
}

export function QualityProfileImporter({
	serviceType,
	onImportComplete,
	onClose,
}: QualityProfileImporterProps) {
	const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(
		null,
	);
	const [selectedProfileId, setSelectedProfileId] = useState<number | null>(
		null,
	);
	const [importedProfile, setImportedProfile] =
		useState<CompleteQualityProfile | null>(null);

	// Fetch instances and filter by service type (compare case-insensitively)
	const { data: allInstances, isLoading: loadingInstances } = useServicesQuery();
	const instances = allInstances?.filter((i) => i.service.toUpperCase() === serviceType);

	// Fetch profiles for selected instance
	const { data: profiles, isLoading: loadingProfiles } =
		useInstanceProfiles(selectedInstanceId);

	// Import mutation
	const importMutation = useImportProfile();

	// Handle instance selection
	const handleInstanceSelect = (instanceId: string) => {
		setSelectedInstanceId(instanceId);
		setSelectedProfileId(null);
		setImportedProfile(null);
	};

	// Handle profile selection
	const handleProfileSelect = (profileId: number) => {
		setSelectedProfileId(profileId);
		setImportedProfile(null);
	};

	// Import profile
	const handleImport = async () => {
		if (!selectedInstanceId || selectedProfileId === null) return;

		try {
			const result = await importMutation.mutateAsync({
				instanceId: selectedInstanceId,
				profileId: selectedProfileId,
			});
			setImportedProfile(result.profile);
		} catch (error) {
			console.error("Failed to import profile:", error);
		}
	};

	// Complete import
	const handleComplete = () => {
		if (importedProfile) {
			onImportComplete?.(importedProfile);
			onClose?.();
		}
	};

	// Get selected instance name
	const selectedInstance = instances?.find((i) => i.id === selectedInstanceId);
	const _selectedProfile = profiles?.find((p) => p.id === selectedProfileId);

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-semibold text-foreground">
					Import Quality Profile
				</h3>
				{onClose && (
					<Button size="sm" variant="ghost" onClick={onClose}>
						Close
					</Button>
				)}
			</div>

			<Alert>
				<Info className="h-4 w-4" />
				<AlertDescription className="text-xs">
					Import a complete quality profile from an *arr instance. This will
					capture all quality definitions, cutoffs, upgrade settings, and custom
					format scores.
				</AlertDescription>
			</Alert>

			{/* Step 1: Select Instance */}
			<div className="space-y-2">
				<label className="block text-sm font-medium text-foreground">
					Step 1: Select Instance
				</label>
				<NativeSelect
					value={selectedInstanceId || ""}
					onChange={(e) => handleInstanceSelect(e.target.value)}
					disabled={loadingInstances}
					className="w-full"
				>
					<SelectOption value="">Select an instance...</SelectOption>
					{instances?.map((instance) => (
						<SelectOption key={instance.id} value={instance.id}>
							{instance.label} ({instance.service})
						</SelectOption>
					))}
				</NativeSelect>
			</div>

			{/* Step 2: Select Profile */}
			{selectedInstanceId && (
				<div className="space-y-2">
					<label className="block text-sm font-medium text-foreground">
						Step 2: Select Quality Profile
					</label>
					{loadingProfiles ? (
						<div className="text-sm text-muted-foreground">Loading profiles...</div>
					) : profiles && profiles.length > 0 ? (
						<div className="space-y-2">
							{profiles.map((profile) => (
								<button
									key={profile.id}
									onClick={() => handleProfileSelect(profile.id)}
									className={`w-full rounded border p-3 text-left transition ${
										selectedProfileId === profile.id
											? "border-primary bg-primary/10"
											: "border-border bg-muted hover:bg-card"
									}`}
								>
									<div className="flex items-center justify-between">
										<div className="flex-1">
											<div className="font-medium text-foreground">{profile.name}</div>
											<div className="text-xs text-muted-foreground mt-1">
												Cutoff: {profile.cutoffQuality?.name || "Unknown"} •
												Upgrade: {profile.upgradeAllowed ? "Yes" : "No"} • Min
												Score: {profile.minFormatScore} •{" "}
												{profile.formatItemsCount} Custom Formats
											</div>
										</div>
										{selectedProfileId === profile.id && (
											<CheckCircle className="h-5 w-5 text-primary ml-2" />
										)}
									</div>
								</button>
							))}
						</div>
					) : (
						<Alert>
							<AlertCircle className="h-4 w-4" />
							<AlertDescription className="text-xs">
								No quality profiles found for this instance.
							</AlertDescription>
						</Alert>
					)}
				</div>
			)}

			{/* Step 3: Import */}
			{selectedProfileId !== null && !importedProfile && (
				<div className="flex justify-end pt-2 border-t border-border/30">
					<Button
						onClick={handleImport}
						disabled={importMutation.isPending}
						className="gap-2"
					>
						<Download className="h-4 w-4" />
						{importMutation.isPending ? "Importing..." : "Import Profile"}
					</Button>
				</div>
			)}

			{/* Import Error */}
			{importMutation.isError && (
				<Alert variant="danger">
					<AlertCircle className="h-4 w-4" />
					<AlertDescription className="text-xs">
						{getErrorMessage(importMutation.error, "Failed to import profile")}
					</AlertDescription>
				</Alert>
			)}

			{/* Import Success */}
			{importedProfile && (
				<div className="space-y-4 rounded border border-border/30 p-4 bg-card/40">
					<div className="flex items-center gap-2">
						<CheckCircle className="h-5 w-5 text-success" />
						<span className="font-medium text-foreground">Profile Imported Successfully</span>
					</div>

					<div className="space-y-2 text-sm">
						<div className="grid grid-cols-2 gap-2">
							<div>
								<span className="text-muted-foreground">Profile Name:</span>
								<div className="font-medium text-foreground">
									{importedProfile.sourceProfileName}
								</div>
							</div>
							<div>
								<span className="text-muted-foreground">Source Instance:</span>
								<div className="font-medium text-foreground">
									{selectedInstance?.label}
								</div>
							</div>
							<div>
								<span className="text-muted-foreground">Upgrade Allowed:</span>
								<div className="font-medium text-foreground">
									{importedProfile.upgradeAllowed ? "Yes" : "No"}
								</div>
							</div>
							<div>
								<span className="text-muted-foreground">Cutoff:</span>
								<div className="font-medium text-foreground">
									{importedProfile.cutoffQuality?.name || "Unknown"}
								</div>
							</div>
							<div>
								<span className="text-muted-foreground">Quality Items:</span>
								<div className="font-medium text-foreground">
									{importedProfile.items.length} items
								</div>
							</div>
							<div>
								<span className="text-muted-foreground">Min Format Score:</span>
								<div className="font-medium text-foreground">
									{importedProfile.minFormatScore}
								</div>
							</div>
						</div>
					</div>

					<div className="flex justify-end gap-2 pt-2 border-t border-border/30">
						<Button variant="secondary" onClick={() => setImportedProfile(null)}>
							Import Different Profile
						</Button>
						<Button onClick={handleComplete} className="gap-2">
							<ChevronRight className="h-4 w-4" />
							Use This Profile
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
