"use client";

import React, { useState } from "react";
import { useCustomFormats } from "../../../hooks/api/useCustomFormats";
import { useTrashTracked, useAllTrashSyncSettings, useUpdateTrashSyncSettings } from "../../../hooks/api/useTrashGuides";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Button, toast, Tabs, TabsList, TabsTrigger, TabsContent } from "../../../components/ui";
import { ScoringMatrix } from "../../custom-formats/components/scoring-matrix";
import { InstanceSyncSettings } from "../../custom-formats/components/instance-sync-settings";
import { QualityProfilesList } from "../../custom-formats/components/quality-profiles-list";
import { TrackedQualityProfiles } from "../../custom-formats/components/tracked-quality-profiles";
import { TemplateOverlayPanel } from "../../custom-formats/components/template-overlay-panel";

/**
 * Profiles Management Client
 * Manage quality profiles, scoring, auto-sync, and templates across all instances
 */
export const ProfilesClient = () => {
	const { data, isLoading } = useCustomFormats();
	const { data: trashTrackedData } = useTrashTracked();
	const { data: allSyncSettings } = useAllTrashSyncSettings();
	const updateSyncSettingsMutation = useUpdateTrashSyncSettings();

	// Tab state
	const [activeTab, setActiveTab] = useState<"scoring" | "auto-sync" | "quality-profiles" | "templates">("scoring");
	const [scoringInstanceId, setScoringInstanceId] = useState<string>("");
	const [qualityProfileInstanceId, setQualityProfileInstanceId] = useState<string>("");
	const [templatesInstanceId, setTemplatesInstanceId] = useState<string>("");

	const instances = data?.instances || [];

	// Auto-sync handler for per-instance settings
	const handleUpdateInstanceSync = async (
		instanceId: string,
		enabled: boolean,
		intervalType: "DISABLED" | "HOURLY" | "DAILY" | "WEEKLY",
		intervalValue: number,
		syncFormats: boolean,
		syncCFGroups: boolean,
		syncQualityProfiles: boolean
	) => {
		try {
			await updateSyncSettingsMutation.mutateAsync({
				instanceId,
				settings: {
					enabled,
					intervalType,
					intervalValue,
					syncFormats,
					syncCFGroups,
					syncQualityProfiles,
				},
			});
			toast.success("Auto-sync settings saved successfully");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save auto-sync settings",
			);
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<div className="text-fg-muted">Loading profiles...</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<Tabs defaultValue={activeTab}>
				<TabsList>
					<TabsTrigger value="scoring">Scoring</TabsTrigger>
					<TabsTrigger value="auto-sync">Auto-Sync</TabsTrigger>
					<TabsTrigger value="quality-profiles">Quality Profiles</TabsTrigger>
					<TabsTrigger value="templates">Templates & Overrides</TabsTrigger>
				</TabsList>

				{/* Scoring Tab */}
				<TabsContent value="scoring" className="space-y-6 mt-6">
					{instances.length === 0 ? (
						<Card>
							<CardContent className="py-12">
								<div className="text-center space-y-4">
									<p className="text-fg-muted">
										No Sonarr or Radarr instances configured.
									</p>
									<p className="text-sm text-fg-subtle">
										Add instances in Settings → Services to get started.
									</p>
									<Button asChild>
										<a href="/settings">Go to Settings</a>
									</Button>
								</div>
							</CardContent>
						</Card>
					) : (
						<>
							{/* Instance selector */}
							<Card>
								<CardHeader>
									<CardTitle>Quality Profile Scoring</CardTitle>
									<CardDescription>
										Manage custom format scores across quality profiles
									</CardDescription>
								</CardHeader>
								<CardContent>
									<div className="space-y-2">
										<label htmlFor="scoring-instance" className="text-sm font-medium text-fg">
											Select Instance
										</label>
										<select
											id="scoring-instance"
											value={scoringInstanceId}
											onChange={(e) => setScoringInstanceId(e.target.value)}
											className="w-full max-w-md rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
										>
											<option value="">Choose an instance...</option>
											{instances.map((instance) => (
												<option key={instance.instanceId} value={instance.instanceId}>
													{instance.instanceLabel} ({instance.instanceService})
												</option>
											))}
										</select>
										<p className="text-xs text-fg-muted">
											View and edit custom format scores for each quality profile
										</p>
									</div>
								</CardContent>
							</Card>

							{/* Scoring matrix */}
							{scoringInstanceId && (
								<ScoringMatrix
									instanceId={scoringInstanceId}
									instanceLabel={
										instances.find((i) => i.instanceId === scoringInstanceId)
											?.instanceLabel || ""
									}
								/>
							)}
						</>
					)}
				</TabsContent>

				{/* Auto-Sync Tab */}
				<TabsContent value="auto-sync" className="space-y-6 mt-6">
					{instances.length === 0 ? (
						<Card>
							<CardContent className="py-12">
								<div className="text-center space-y-4">
									<p className="text-fg-muted">
										No Sonarr or Radarr instances configured.
									</p>
									<p className="text-sm text-fg-subtle">
										Add instances in Settings → Services to get started.
									</p>
									<Button asChild>
										<a href="/settings">Go to Settings</a>
									</Button>
								</div>
							</CardContent>
						</Card>
					) : (
						<>
							{/* Header card */}
							<Card>
								<CardHeader>
									<CardTitle>Automatic TRaSH Sync</CardTitle>
									<CardDescription>
										Configure automatic sync schedules for each instance independently.
										TRaSH-managed custom formats will be automatically updated on the schedule you set.
									</CardDescription>
								</CardHeader>
							</Card>

							{/* Instance cards */}
							<div className="space-y-4">
								{instances.map((instance) => {
									const trackedCount = trashTrackedData?.tracked?.[instance.instanceId]?.length || 0;
									const instanceSettings = allSyncSettings?.settings?.find(
										(s) => s.serviceInstanceId === instance.instanceId
									);

									const currentSettings = instanceSettings || {
										enabled: false,
										intervalType: "DISABLED" as const,
										intervalValue: 24,
										syncFormats: true,
										syncCFGroups: true,
										syncQualityProfiles: true,
										lastRunAt: null,
										lastRunStatus: null,
										lastErrorMessage: null,
										formatsSynced: 0,
										formatsFailed: 0,
										cfGroupsSynced: 0,
										qualityProfilesSynced: 0,
										nextRunAt: null,
									};

									return (
										<InstanceSyncSettings
											key={instance.instanceId}
											instanceId={instance.instanceId}
											instanceLabel={instance.instanceLabel}
											instanceService={instance.instanceService}
											trashFormatCount={trackedCount}
											currentSettings={currentSettings}
											onSave={(enabled, intervalType, intervalValue, syncFormats, syncCFGroups, syncQualityProfiles) =>
												handleUpdateInstanceSync(
													instance.instanceId,
													enabled,
													intervalType,
													intervalValue,
													syncFormats,
													syncCFGroups,
													syncQualityProfiles
												)
											}
											isSaving={updateSyncSettingsMutation.isPending}
										/>
									);
								})}
							</div>
						</>
					)}
				</TabsContent>

				{/* Quality Profiles Tab */}
				<TabsContent value="quality-profiles" className="space-y-6 mt-6">
					{instances.length === 0 ? (
						<Card>
							<CardContent className="py-12">
								<div className="text-center space-y-4">
									<p className="text-fg-muted">
										No Sonarr or Radarr instances configured.
									</p>
									<p className="text-sm text-fg-subtle">
										Add instances in Settings → Services to get started.
									</p>
									<Button asChild>
										<a href="/settings">Go to Settings</a>
									</Button>
								</div>
							</CardContent>
						</Card>
					) : (
						<>
							{/* Header card */}
							<Card>
								<CardHeader>
									<CardTitle>TRaSH Quality Profiles</CardTitle>
									<CardDescription>
										Browse and apply pre-configured quality profiles from TRaSH Guides to your Sonarr and Radarr instances.
									</CardDescription>
								</CardHeader>
								<CardContent>
									<div className="space-y-2">
										<label htmlFor="qp-instance" className="text-sm font-medium text-fg">
											Select Instance
										</label>
										<select
											id="qp-instance"
											value={qualityProfileInstanceId}
											onChange={(e) => setQualityProfileInstanceId(e.target.value)}
											className="w-full max-w-md rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
										>
											<option value="">Choose an instance...</option>
											{instances.map((instance) => (
												<option key={instance.instanceId} value={instance.instanceId}>
													{instance.instanceLabel} ({instance.instanceService})
												</option>
											))}
										</select>
										<p className="text-xs text-fg-muted">
											Select an instance to view and apply TRaSH quality profiles
										</p>
									</div>
								</CardContent>
							</Card>

							{/* Quality Profiles List */}
							{qualityProfileInstanceId && (
								<QualityProfilesList
									instanceId={qualityProfileInstanceId}
									instanceLabel={
										instances.find((i) => i.instanceId === qualityProfileInstanceId)
											?.instanceLabel || ""
									}
									service={
										instances.find((i) => i.instanceId === qualityProfileInstanceId)
											?.instanceService as "SONARR" | "RADARR" | undefined
									}
								/>
							)}

							{/* Tracked Quality Profiles */}
							<TrackedQualityProfiles />
						</>
					)}
				</TabsContent>

				{/* Templates & Overrides Tab */}
				<TabsContent value="templates" className="space-y-6 mt-6">
					{instances.length === 0 ? (
						<Card>
							<CardContent className="py-12">
								<div className="text-center space-y-4">
									<p className="text-fg-muted">
										No Sonarr or Radarr instances configured.
									</p>
									<p className="text-sm text-fg-subtle">
										Add instances in Settings → Services to get started.
									</p>
									<Button asChild>
										<a href="/settings">Go to Settings</a>
									</Button>
								</div>
							</CardContent>
						</Card>
					) : (
						<>
							{/* Header card */}
							<Card>
								<CardHeader>
									<CardTitle>Template Overlay System</CardTitle>
									<CardDescription>
										Configure template includes, excludes, and per-CF overrides for each instance.
										Preview changes before applying to your ARR instances.
									</CardDescription>
								</CardHeader>
								<CardContent>
									<div className="space-y-2">
										<label htmlFor="templates-instance" className="text-sm font-medium text-fg">
											Select Instance
										</label>
										<select
											id="templates-instance"
											value={templatesInstanceId}
											onChange={(e) => setTemplatesInstanceId(e.target.value)}
											className="w-full max-w-md rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
										>
											<option value="">Choose an instance...</option>
											{instances.map((instance) => (
												<option key={instance.instanceId} value={instance.instanceId}>
													{instance.instanceLabel} ({instance.instanceService})
												</option>
											))}
										</select>
										<p className="text-xs text-fg-muted">
											Select an instance to configure its template overlay
										</p>
									</div>
								</CardContent>
							</Card>

							{/* Template Overlay Panel */}
							{templatesInstanceId && (
								<TemplateOverlayPanel
									instanceId={templatesInstanceId}
									instanceLabel={
										instances.find((i) => i.instanceId === templatesInstanceId)
											?.instanceLabel || ""
									}
									instanceService={
										instances.find((i) => i.instanceId === templatesInstanceId)
											?.instanceService || ""
									}
								/>
							)}
						</>
					)}
				</TabsContent>
			</Tabs>
		</div>
	);
};
