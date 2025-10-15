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
 * ARR Sync Client
 * Main component for managing Custom Formats & TRaSH guides sync
 */
export const ArrSyncClient = () => {
	const { data: settingsData, isLoading } = useArrSyncSettings();
	const updateSettings = useUpdateArrSyncSettings();
	const previewSync = usePreviewArrSync();
	const applySync = useApplyArrSync();
	const testConnection = useTestArrSyncConnection();

	const [showPreview, setShowPreview] = useState(false);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<div className="text-fg-muted">Loading ARR Sync settings...</div>
			</div>
		);
	}

	const instances = settingsData?.settings || [];
	const enabledInstances = instances.filter((i) => i.settings?.enabled);

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
		const enabledInstanceIds = enabledInstances.map((i) => i.instanceId);

		if (enabledInstanceIds.length === 0) {
			return;
		}

		await previewSync.mutateAsync({
			instanceIds: enabledInstanceIds,
		});
		setShowPreview(true);
	};

	const handleApply = async () => {
		const enabledInstanceIds = enabledInstances.map((i) => i.instanceId);

		if (enabledInstanceIds.length === 0) {
			return;
		}

		await applySync.mutateAsync({
			instanceIds: enabledInstanceIds,
			dryRun: false,
		});
		setShowPreview(false);
	};

	const handleTestConnection = async (instanceId: string) => {
		await testConnection.mutateAsync(instanceId);
	};

	if (instances.length === 0) {
		return (
			<Card>
				<CardContent className="py-12">
					<div className="text-center space-y-4">
						<p className="text-fg-muted">
							No Sonarr or Radarr instances configured.
						</p>
						<p className="text-sm text-fg-subtle">
							Add instances in Settings → Services to get started with ARR Sync.
						</p>
						<Button asChild>
							<a href="/settings">Go to Settings</a>
						</Button>
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-6">
			{/* Action Card */}
			<Card>
				<CardHeader>
					<CardTitle>Quick Actions</CardTitle>
					<CardDescription>
						Preview and apply custom format changes from TRaSH guides
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex flex-wrap gap-3">
						<Button
							onClick={handlePreview}
							disabled={
								enabledInstances.length === 0 ||
								previewSync.isPending
							}
						>
							{previewSync.isPending ? "Previewing..." : "Preview Changes"}
						</Button>
						{showPreview && (
							<Button
								variant="ghost"
								onClick={() => setShowPreview(false)}
							>
								Clear Preview
							</Button>
						)}
						<div className="ml-auto text-sm text-fg-muted flex items-center gap-2">
							<span>{enabledInstances.length} of {instances.length} enabled</span>
						</div>
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
							{previewSync.data.plans.map((plan) => {
								const totalChanges =
									plan.customFormats.creates.length +
									plan.customFormats.updates.length +
									plan.customFormats.deletes.length +
									plan.qualityProfiles.updates.length;

								return (
									<div
										key={plan.instanceId}
										className="rounded-lg border border-border/50 bg-bg-subtle/30 p-4 space-y-3"
									>
										<div className="flex items-center justify-between">
											<h4 className="font-semibold text-fg">{plan.instanceLabel}</h4>
											<Badge variant={totalChanges > 0 ? "info" : "secondary"}>
												{totalChanges} {totalChanges === 1 ? "change" : "changes"}
											</Badge>
										</div>

										{/* Custom Formats Summary */}
										{totalChanges > 0 && (
											<div className="flex flex-wrap gap-2 text-sm">
												{plan.customFormats.creates.length > 0 && (
													<div className="flex items-center gap-1.5 px-2 py-1 rounded bg-success/10 text-success border border-success/20">
														<span className="font-medium">{plan.customFormats.creates.length}</span>
														<span>Create</span>
													</div>
												)}
												{plan.customFormats.updates.length > 0 && (
													<div className="flex items-center gap-1.5 px-2 py-1 rounded bg-info/10 text-info border border-info/20">
														<span className="font-medium">{plan.customFormats.updates.length}</span>
														<span>Update</span>
													</div>
												)}
												{plan.customFormats.deletes.length > 0 && (
													<div className="flex items-center gap-1.5 px-2 py-1 rounded bg-danger/10 text-danger border border-danger/20">
														<span className="font-medium">{plan.customFormats.deletes.length}</span>
														<span>Delete</span>
													</div>
												)}
												{plan.qualityProfiles.updates.length > 0 && (
													<div className="flex items-center gap-1.5 px-2 py-1 rounded bg-accent/10 text-fg border border-accent/20">
														<span className="font-medium">{plan.qualityProfiles.updates.length}</span>
														<span>Profile Update</span>
													</div>
												)}
											</div>
										)}

										{/* Warnings */}
										{plan.warnings.length > 0 && (
											<div className="space-y-1">
												{plan.warnings.map((warning, i) => (
													<div key={i} className="flex items-start gap-2 text-sm text-warning">
														<span>⚠️</span>
														<span>{warning}</span>
													</div>
												))}
											</div>
										)}

										{/* Errors */}
										{plan.errors.length > 0 && (
											<div className="space-y-1">
												{plan.errors.map((error, i) => (
													<div key={i} className="flex items-start gap-2 text-sm text-danger">
														<span>❌</span>
														<span>{error}</span>
													</div>
												))}
											</div>
										)}
									</div>
								);
							})}
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

			{/* Instance Settings Grid */}
			<div>
				<h2 className="text-xl font-semibold mb-4 text-fg">Configured Instances</h2>
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{instances.map((instance) => {
						const isEnabled = instance.settings?.enabled || false;

						return (
							<Card key={instance.instanceId}>
								<CardHeader>
									<div className="flex items-start justify-between gap-2">
										<div className="flex-1 min-w-0">
											<CardTitle className="text-base truncate">
												{instance.instanceLabel}
											</CardTitle>
											<div className="flex items-center gap-2 mt-1">
												<Badge
													variant="secondary"
													className="text-xs"
												>
													{instance.instanceService}
												</Badge>
												<Badge
													variant={isEnabled ? "success" : "secondary"}
													className="text-xs"
												>
													{isEnabled ? "Enabled" : "Disabled"}
												</Badge>
											</div>
										</div>
									</div>
								</CardHeader>
								<CardContent className="space-y-3">
									{instance.settings && (
										<div className="space-y-2 text-sm text-fg-muted">
											<div>
												<span className="font-medium text-fg">TRaSH Ref:</span>{" "}
												{instance.settings.trashRef}
											</div>
											{instance.settings.presets.length > 0 && (
												<div>
													<span className="font-medium text-fg">Presets:</span>{" "}
													{instance.settings.presets.join(", ")}
												</div>
											)}
										</div>
									)}
									<div className="flex gap-2 pt-2">
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
											variant={isEnabled ? "danger" : "primary"}
											onClick={() =>
												handleEnableSync(
													instance.instanceId,
													!isEnabled,
												)
											}
											disabled={updateSettings.isPending}
											className="flex-1"
										>
											{isEnabled ? "Disable" : "Enable"}
										</Button>
									</div>
								</CardContent>
							</Card>
						);
					})}
				</div>
			</div>
		</div>
	);
};
