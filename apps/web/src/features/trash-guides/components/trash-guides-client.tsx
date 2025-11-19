"use client";

import { useState } from "react";
import type { TrashTemplate } from "@arr/shared";
import { useTrashCacheStatus, useRefreshTrashCache } from "../../../hooks/api/useTrashCache";
import { Alert, AlertTitle, AlertDescription, EmptyState, Skeleton } from "../../../components/ui";
import { AlertCircle, RefreshCw, Database, Clock, HardDrive } from "lucide-react";
import { TemplateList } from "./template-list";
import { TemplateEditor } from "./template-editor";
import { TemplateImportDialog } from "./template-import-dialog";
import { QualityProfileWizard } from "./quality-profile-wizard";
import { SchedulerStatusDashboard } from "./scheduler-status-dashboard";
import { DeploymentHistoryTable } from "./deployment-history-table";
import { BulkScoreManager } from "./bulk-score-manager";
import { useTemplates } from "../../../hooks/api/useTemplates";

type ServiceType = "RADARR" | "SONARR";
type Tab = "cache" | "templates" | "scheduler" | "history" | "bulk-scores";

const CONFIG_TYPE_LABELS: Record<string, string> = {
	CUSTOM_FORMATS: "Custom Formats",
	CF_GROUPS: "CF Groups",
	QUALITY_SIZE: "Quality Size",
	NAMING: "Naming Schemes",
	QUALITY_PROFILES: "Quality Profiles",
	CF_DESCRIPTIONS: "CF Descriptions",
};

export const TrashGuidesClient = () => {
	const { data, isLoading, error, refetch } = useTrashCacheStatus();
	const { data: templatesData } = useTemplates();
	const refreshMutation = useRefreshTrashCache();
	const [refreshing, setRefreshing] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<Tab>("templates");
	const [editorOpen, setEditorOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [qualityProfileBrowserOpen, setQualityProfileBrowserOpen] = useState(false);
	const [selectedServiceType, setSelectedServiceType] = useState<ServiceType | null>(null);
	const [editingTemplate, setEditingTemplate] = useState<TrashTemplate | undefined>(undefined);

	const handleRefresh = async (serviceType: ServiceType) => {
		setRefreshing(serviceType);
		try {
			await refreshMutation.mutateAsync({ serviceType, force: true });
		} finally {
			setRefreshing(null);
		}
	};

	const handleCreateNew = () => {
		setEditingTemplate(undefined);
		setEditorOpen(true);
	};

	const handleEdit = (template: TrashTemplate) => {
		setEditingTemplate(template);
		setEditorOpen(true);
	};

	const handleCloseEditor = () => {
		setEditorOpen(false);
		setEditingTemplate(undefined);
	};

	const handleImport = () => {
		setImportOpen(true);
	};

	const handleBrowseQualityProfiles = (serviceType: ServiceType) => {
		setSelectedServiceType(serviceType);
		setEditingTemplate(undefined); // Clear any editing template when browsing
		setQualityProfileBrowserOpen(true);
	};

	const handleEditTemplate = (template: TrashTemplate) => {
		setEditingTemplate(template);
		setSelectedServiceType(template.serviceType);
		setQualityProfileBrowserOpen(true);
	};

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

	if (!data) {
		return (
			<EmptyState
				icon={AlertCircle}
				title="No cache data available"
				description="TRaSH Guides cache is not initialized. Refresh to fetch data."
			/>
		);
	}

	const renderServiceSection = (serviceType: ServiceType) => {
		const statuses = data[serviceType.toLowerCase() as "radarr" | "sonarr"];

		return (
			<section className="space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="text-2xl font-semibold text-white">{serviceType}</h2>
					<button
						type="button"
						onClick={() => handleRefresh(serviceType)}
						disabled={refreshing === serviceType || refreshMutation.isPending}
						className="inline-flex items-center gap-2 rounded-lg bg-primary/20 px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/30 disabled:opacity-50"
					>
						<RefreshCw
							className={`h-4 w-4 ${refreshing === serviceType ? "animate-spin" : ""}`}
						/>
						{refreshing === serviceType ? "Refreshing..." : "Refresh All"}
					</button>
				</div>

				{statuses.length === 0 ? (
					<div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center">
						<p className="text-white/60">No cache entries for {serviceType}</p>
						<button
							type="button"
							onClick={() => handleRefresh(serviceType)}
							className="mt-4 text-sm text-primary hover:underline"
						>
							Click to initialize cache
						</button>
					</div>
				) : (
					<div className="grid gap-4 md:grid-cols-2">
						{statuses.map((status) => (
							<article
								key={`${status.serviceType}-${status.configType}`}
								className={`rounded-xl border p-6 transition ${
									status.isStale
										? "border-yellow-500/30 bg-yellow-500/5"
										: "border-white/10 bg-white/5 hover:border-white/20"
								}`}
							>
								<div className="flex items-start justify-between">
									<div>
										<h3 className="font-medium text-white">
											{CONFIG_TYPE_LABELS[status.configType]}
										</h3>
										<p className="mt-1 text-xs text-white/60">v{status.version}</p>
									</div>
									{status.isStale && (
										<span className="rounded-full bg-yellow-500/20 px-2 py-1 text-xs font-medium text-yellow-200">
											Stale
										</span>
									)}
								</div>

								<div className="mt-4 space-y-2 text-sm">
									<div className="flex items-center gap-2 text-white/70">
										<Database className="h-4 w-4" />
										<span>{status.itemCount} items</span>
									</div>
									<div className="flex items-center gap-2 text-white/70">
										<Clock className="h-4 w-4" />
										<span>
											Last fetched: {new Date(status.lastFetched).toLocaleString()}
										</span>
									</div>
								</div>
							</article>
						))}
					</div>
				)}
			</section>
		);
	};

	return (
		<div className="space-y-6">
			<header className="space-y-4">
				<div className="space-y-2">
					<h1 className="text-4xl font-semibold text-white">TRaSH Guides</h1>
					<p className="text-white/70">
						Manage and deploy TRaSH Guides expert configurations for your Radarr and Sonarr instances.
					</p>
					{data?.stats && (
						<div className="mt-4 flex gap-4 text-sm text-white/60">
							<span className="flex items-center gap-1">
								<HardDrive className="h-4 w-4" />
								{data.stats.totalEntries} total entries
							</span>
							{data.stats.staleEntries > 0 && (
								<span className="text-yellow-500">
									{data.stats.staleEntries} stale
								</span>
							)}
						</div>
					)}
				</div>

				{/* Tab Navigation */}
				<div className="border-b border-white/10">
					<nav className="flex gap-6">
						<button
							type="button"
							onClick={() => setActiveTab("templates")}
							className={`border-b-2 px-1 pb-3 text-sm font-medium transition ${
								activeTab === "templates"
									? "border-primary text-white"
									: "border-transparent text-white/60 hover:text-white"
							}`}
						>
							Templates
						</button>
						<button
							type="button"
							onClick={() => setActiveTab("bulk-scores")}
							className={`border-b-2 px-1 pb-3 text-sm font-medium transition ${
								activeTab === "bulk-scores"
									? "border-primary text-white"
									: "border-transparent text-white/60 hover:text-white"
							}`}
						>
							Bulk Score Management
						</button>
						<button
							type="button"
							onClick={() => setActiveTab("history")}
							className={`border-b-2 px-1 pb-3 text-sm font-medium transition ${
								activeTab === "history"
									? "border-primary text-white"
									: "border-transparent text-white/60 hover:text-white"
							}`}
						>
							Deployment History
						</button>
						<button
							type="button"
							onClick={() => setActiveTab("scheduler")}
							className={`border-b-2 px-1 pb-3 text-sm font-medium transition ${
								activeTab === "scheduler"
									? "border-primary text-white"
									: "border-transparent text-white/60 hover:text-white"
							}`}
						>
							Update Scheduler
						</button>
						<button
							type="button"
							onClick={() => setActiveTab("cache")}
							className={`border-b-2 px-1 pb-3 text-sm font-medium transition ${
								activeTab === "cache"
									? "border-primary text-white"
									: "border-transparent text-white/60 hover:text-white"
							}`}
						>
							Cache Status
						</button>
					</nav>
				</div>
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
					{renderServiceSection("RADARR")}
					{renderServiceSection("SONARR")}
				</div>
			) : activeTab === "scheduler" ? (
				<SchedulerStatusDashboard />
			) : activeTab === "history" ? (
				<div className="space-y-6">
					<div className="rounded-lg border border-white/10 bg-white/5 p-6">
						<h3 className="text-lg font-semibold text-white mb-4">Deployment History</h3>
						<p className="text-white/70 mb-4">
							View all template deployments across your instances. Track deployment status, review applied configurations, and rollback when needed.
						</p>
					</div>

					{/* Global Deployment History Table */}
					<DeploymentHistoryTable />
				</div>
			) : activeTab === "bulk-scores" ? (
				<div className="rounded-lg border border-white/10 bg-white/5 p-6">
					<BulkScoreManager
						userId="user-placeholder"
						onOperationComplete={() => {
							// Refetch templates or cache data if needed
							refetch();
						}}
					/>
				</div>
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
				onClose={() => setImportOpen(false)}
			/>
			{selectedServiceType && (
				<QualityProfileWizard
					open={qualityProfileBrowserOpen}
					onClose={() => {
						setQualityProfileBrowserOpen(false);
						setSelectedServiceType(null);
						setEditingTemplate(undefined);
					}}
					serviceType={selectedServiceType}
					editingTemplate={editingTemplate}
				/>
			)}
		</div>
	);
};
