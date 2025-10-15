"use client";

import { useState } from "react";
import {
	useArrSyncSettings,
	useUpdateArrSyncSettings,
	usePreviewArrSync,
	useApplyArrSync,
	useTestArrSyncConnection,
} from "../../../hooks/api/useArrSync";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Button, Badge } from "../../../components/ui";
import type { ArrSyncSettings } from "@arr/shared";
import { cn } from "../../../lib/utils";

/**
 * ARR Sync Tab
 * Manage Custom Formats & TRaSH guides sync for Sonarr/Radarr instances
 */
export const ArrSyncTab = () => {
	const { data: settingsData, isLoading } = useArrSyncSettings();
	const updateSettings = useUpdateArrSyncSettings();
	const previewSync = usePreviewArrSync();
	const applySync = useApplyArrSync();
	const testConnection = useTestArrSyncConnection();

	const [editingInstanceId, setEditingInstanceId] = useState<string | null>(null);
	const [showPreview, setShowPreview] = useState(false);

	if (isLoading) {
		return <div className="text-fg-muted">Loading ARR Sync settings...</div>;
	}

	const instances = settingsData?.settings || [];

	const handleEnableSync = async (instanceId: string, enabled: boolean) => {
		const instance = instances.find((i) => i.instanceId === instanceId);
		if (!instance) return;

		const settings: ArrSyncSettings = instance.settings || {
			enabled: false,
			trashRef: "stable",
			presets: [],
			overrides: {},
		};

		await updateSettings.mutateAsync({
			instanceId,
			settings: { ...settings, enabled },
		});
	};

	const handlePreview = async () => {
		const enabledInstances = instances
			.filter((i) => i.settings?.enabled)
			.map((i) => i.instanceId);

		if (enabledInstances.length === 0) {
			return;
		}

		await previewSync.mutateAsync({
			instanceIds: enabledInstances,
		});
		setShowPreview(true);
	};

	const handleApply = async () => {
		const enabledInstances = instances
			.filter((i) => i.settings?.enabled)
			.map((i) => i.instanceId);

		if (enabledInstances.length === 0) {
			return;
		}

		await applySync.mutateAsync({
			instanceIds: enabledInstances,
			dryRun: false,
		});
		setShowPreview(false);
	};

	const handleTestConnection = async (instanceId: string) => {
		await testConnection.mutateAsync(instanceId);
	};

	return (
		<div className="space-y-6">
			{/* Header Card */}
			<Card>
				<CardHeader>
					<CardTitle>ARR Custom Formats & TRaSH Sync</CardTitle>
					<CardDescription>
						Automatically sync custom formats and quality profiles from TRaSH guides to your Sonarr/Radarr instances.
						This provides a GUI alternative to Recyclarr's CLI.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex gap-3">
						<Button
							onClick={handlePreview}
							disabled={
								instances.filter((i) => i.settings?.enabled).length === 0 ||
								previewSync.isPending
							}
						>
							{previewSync.isPending ? "Previewing..." : "Preview Changes"}
						</Button>
						<Button
							variant="secondary"
							onClick={() => setShowPreview(false)}
							disabled={!showPreview}
						>
							Clear Preview
						</Button>
					</div>
				</CardContent>
			</Card>

			{/* Preview Results */}
			{showPreview && previewSync.data && (
				<Card>
					<CardHeader>
						<CardTitle>Preview Results</CardTitle>
						<CardDescription>
							Review the changes that will be made before applying
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-4">
							{previewSync.data.plans.map((plan) => (
								<div
									key={plan.instanceId}
									className="rounded-lg border border-border/50 p-4 space-y-3"
								>
									<h4 className="font-semibold text-fg">{plan.instanceLabel}</h4>

									{/* Custom Formats Summary */}
									<div className="flex gap-3 text-sm">
										{plan.customFormats.creates.length > 0 && (
											<Badge variant="success">
												{plan.customFormats.creates.length} Create
											</Badge>
										)}
										{plan.customFormats.updates.length > 0 && (
											<Badge variant="info">
												{plan.customFormats.updates.length} Update
											</Badge>
										)}
										{plan.customFormats.deletes.length > 0 && (
											<Badge variant="danger">
												{plan.customFormats.deletes.length} Delete
											</Badge>
										)}
										{plan.qualityProfiles.updates.length > 0 && (
											<Badge variant="info">
												{plan.qualityProfiles.updates.length} Profile Update
											</Badge>
										)}
									</div>

									{/* Warnings */}
									{plan.warnings.length > 0 && (
										<div className="space-y-1">
											{plan.warnings.map((warning, i) => (
												<p key={i} className="text-sm text-warning">
													⚠️ {warning}
												</p>
											))}
										</div>
									)}
								</div>
							))}
						</div>

						<div className="mt-6 flex gap-3">
							<Button
								onClick={handleApply}
								disabled={applySync.isPending}
							>
								{applySync.isPending ? "Applying..." : "Apply Changes"}
							</Button>
							<Button
								variant="ghost"
								onClick={() => setShowPreview(false)}
							>
								Cancel
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Instance Settings */}
			<div className="space-y-4">
				{instances.map((instance) => (
					<Card key={instance.instanceId}>
						<CardHeader>
							<div className="flex items-center justify-between">
								<div>
									<CardTitle>
										{instance.instanceLabel}
										<Badge
											variant="secondary"
											className="ml-2"
										>
											{instance.instanceService}
										</Badge>
									</CardTitle>
									<CardDescription>
										{instance.settings?.enabled
											? "Sync enabled"
											: "Sync disabled"}
									</CardDescription>
								</div>
								<div className="flex gap-2">
									<Button
										size="sm"
										variant="ghost"
										onClick={() => handleTestConnection(instance.instanceId)}
										disabled={testConnection.isPending}
									>
										Test
									</Button>
									<Button
										size="sm"
										variant={instance.settings?.enabled ? "danger" : "primary"}
										onClick={() =>
											handleEnableSync(
												instance.instanceId,
												!instance.settings?.enabled,
											)
										}
										disabled={updateSettings.isPending}
									>
										{instance.settings?.enabled ? "Disable" : "Enable"}
									</Button>
								</div>
							</div>
						</CardHeader>
						{instance.settings && (
							<CardContent>
								<div className="space-y-2 text-sm text-fg-muted">
									<p>
										<strong>TRaSH Ref:</strong> {instance.settings.trashRef}
									</p>
									{instance.settings.presets.length > 0 && (
										<p>
											<strong>Presets:</strong>{" "}
											{instance.settings.presets.join(", ")}
										</p>
									)}
								</div>
							</CardContent>
						)}
					</Card>
				))}
			</div>

			{instances.length === 0 && (
				<Card>
					<CardContent>
						<p className="text-center text-fg-muted py-8">
							No Sonarr or Radarr instances configured. Add instances in the Services tab first.
						</p>
					</CardContent>
				</Card>
			)}
		</div>
	);
};
