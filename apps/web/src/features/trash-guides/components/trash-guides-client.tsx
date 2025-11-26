"use client";

import { Alert, AlertTitle, AlertDescription, EmptyState, Skeleton } from "../../../components/ui";
import { AlertCircle, HardDrive } from "lucide-react";
import { TemplateList } from "./template-list";
import { TemplateEditor } from "./template-editor";
import { TemplateImportDialog } from "./template-import-dialog";
import { QualityProfileWizard } from "./quality-profile-wizard";
import { SchedulerStatusDashboard } from "./scheduler-status-dashboard";
import { DeploymentHistoryTable } from "./deployment-history-table";
import { BulkScoreManager } from "./bulk-score-manager";
import { CustomFormatsBrowser } from "./custom-formats-browser";
import {
	TrashGuidesTabs,
	CacheStatusSection,
} from "../../../components/presentational";
import { useTrashGuidesState } from "../hooks/use-trash-guides-state";
import { useTrashGuidesData } from "../hooks/use-trash-guides-data";
import { useTrashGuidesActions } from "../hooks/use-trash-guides-actions";
import { useTrashGuidesModals } from "../hooks/use-trash-guides-modals";
import { CONFIG_TYPE_LABELS } from "../lib/constants";
import { useCurrentUser } from "../../../hooks/api/useAuth";

/**
 * Main TRaSH Guides client component.
 * Orchestrates the TRaSH Guides interface with tab navigation, data display,
 * and modal management for templates, quality profiles, and cache operations.
 *
 * Refactored to use business logic hooks for better separation of concerns.
 *
 * @component
 */
export const TrashGuidesClient = () => {
	// Get current user
	const { data: currentUser, isLoading: isAuthLoading } = useCurrentUser();

	// State management
	const { activeTab, setActiveTab } = useTrashGuidesState();

	// Data fetching
	const { cacheStatus, isLoading, error, refetchCache } = useTrashGuidesData();

	// Cache refresh actions
	const { handleRefresh, refreshing, refreshMutation } = useTrashGuidesActions();

	// Modal management
	const {
		editorOpen,
		importOpen,
		qualityProfileBrowserOpen,
		selectedServiceType,
		editingTemplate,
		handleCreateNew,
		handleCloseEditor,
		handleImport,
		handleCloseImport,
		handleBrowseQualityProfiles,
		handleEditTemplate,
		handleCloseQualityProfileBrowser,
	} = useTrashGuidesModals();

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div className="space-y-2">
					<Skeleton className="h-8 w-64" />
					<Skeleton className="h-4 w-96" />
				</div>
				<div className="grid gap-4 md:grid-cols-2">
					<Skeleton className="h-48" />
					<Skeleton className="h-48" />
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertTitle>Failed to load cache status</AlertTitle>
				<AlertDescription>
					{error instanceof Error ? error.message : "Please refresh the page and try again."}
				</AlertDescription>
			</Alert>
		);
	}

	if (!cacheStatus) {
		return (
			<EmptyState
				icon={AlertCircle}
				title="No cache data available"
				description="TRaSH Guides cache is not initialized. Refresh to fetch data."
			/>
		);
	}

	return (
		<div className="space-y-6">
			<header className="space-y-4">
				<div className="space-y-2">
					<h1 className="text-4xl font-semibold text-white">TRaSH Guides</h1>
					<p className="text-white/70">
						Manage and deploy TRaSH Guides expert configurations for your Radarr and Sonarr instances.
					</p>
					{cacheStatus?.stats && (
						<div className="mt-4 flex gap-4 text-sm text-white/60">
							<span className="flex items-center gap-1">
								<HardDrive className="h-4 w-4" />
								{cacheStatus.stats.totalEntries} total entries
							</span>
							{cacheStatus.stats.staleEntries > 0 && (
								<span className="text-yellow-500">
									{cacheStatus.stats.staleEntries} stale
								</span>
							)}
						</div>
					)}
				</div>

				{/* Tab Navigation */}
				<TrashGuidesTabs activeTab={activeTab} onTabChange={setActiveTab} />
			</header>

			{refreshMutation.isError && (
				<Alert variant="danger" dismissible onDismiss={() => refreshMutation.reset()}>
					<AlertTitle>Refresh failed</AlertTitle>
					<AlertDescription>
						{refreshMutation.error instanceof Error
							? refreshMutation.error.message
							: "Failed to refresh cache. Please try again."}
					</AlertDescription>
				</Alert>
			)}

			{/* Tab Content */}
			{activeTab === "cache" ? (
				<div className="space-y-10">
					<CacheStatusSection
						serviceType="RADARR"
						statuses={cacheStatus.radarr}
						configTypeLabels={CONFIG_TYPE_LABELS}
						refreshing={refreshing === "RADARR"}
						onRefresh={() => handleRefresh("RADARR")}
						isRefreshPending={refreshMutation.isPending}
					/>
					<CacheStatusSection
						serviceType="SONARR"
						statuses={cacheStatus.sonarr}
						configTypeLabels={CONFIG_TYPE_LABELS}
						refreshing={refreshing === "SONARR"}
						onRefresh={() => handleRefresh("SONARR")}
						isRefreshPending={refreshMutation.isPending}
					/>
				</div>
			) : activeTab === "scheduler" ? (
				<SchedulerStatusDashboard />
			) : activeTab === "history" ? (
				<div className="space-y-6">
					<div className="rounded-lg border border-white/10 bg-white/5 p-6">
						<h3 className="text-lg font-semibold text-white mb-4">Deployment History</h3>
						<p className="text-white/70 mb-4">
							View all template deployments across your instances. Track deployment status, review applied configurations, and undeploy when needed.
						</p>
					</div>

					{/* Global Deployment History Table */}
					<DeploymentHistoryTable />
				</div>
			) : activeTab === "bulk-scores" ? (
				<div className="rounded-lg border border-white/10 bg-white/5 p-6">
					{isAuthLoading ? (
						<div className="flex items-center justify-center py-8">
							<div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
						</div>
					) : currentUser?.id ? (
						<BulkScoreManager
							userId={currentUser.id}
							onOperationComplete={() => {
								// Refetch templates or cache data if needed
								refetchCache();
							}}
						/>
					) : (
						<div className="text-center py-8 text-white/60">
							Please log in to manage bulk scores
						</div>
					)}
				</div>
			) : activeTab === "custom-formats" ? (
				<CustomFormatsBrowser />
			) : (
				<TemplateList
					onCreateNew={handleCreateNew}
					onEdit={handleEditTemplate}
					onImport={handleImport}
					onBrowseQualityProfiles={handleBrowseQualityProfiles}
				/>
			)}

			{/* Modals */}
			<TemplateEditor
				open={editorOpen}
				onClose={handleCloseEditor}
				template={editingTemplate}
			/>
			<TemplateImportDialog
				open={importOpen}
				onClose={handleCloseImport}
			/>
			{selectedServiceType && (
				<QualityProfileWizard
					open={qualityProfileBrowserOpen}
					onClose={handleCloseQualityProfileBrowser}
					serviceType={selectedServiceType}
					editingTemplate={editingTemplate}
				/>
			)}
		</div>
	);
};
