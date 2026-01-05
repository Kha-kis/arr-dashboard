"use client";

import { AlertCircle, HardDrive, Clock, Zap, Sparkles, BookOpen } from "lucide-react";
import { TemplateList } from "./template-list";
import { TemplateEditor } from "./template-editor";
import { TemplateImportDialog } from "./template-import-dialog";
import { QualityProfileWizard } from "./quality-profile-wizard";
import { SchedulerStatusDashboard } from "./scheduler-status-dashboard";
import { DeploymentHistoryTable } from "./deployment-history-table";
import { BulkScoreManager } from "./bulk-score-manager";
import { CustomFormatsBrowser } from "./custom-formats-browser";
import { PremiumEmptyState } from "../../../components/layout";
import { CacheStatusSection } from "./cache-status-section";
import { TrashGuidesTabs } from "./trash-guides-tabs";
import { useTrashGuidesState } from "../hooks/use-trash-guides-state";
import { useTrashGuidesData } from "../hooks/use-trash-guides-data";
import { useTrashGuidesActions } from "../hooks/use-trash-guides-actions";
import { useTrashGuidesModals } from "../hooks/use-trash-guides-modals";
import { CONFIG_TYPE_LABELS } from "../lib/constants";
import { useCurrentUser } from "../../../hooks/api/useAuth";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Premium Loading Skeleton for TRaSH Guides
 */
const PremiumSkeleton = () => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	return (
		<div className="space-y-8 animate-in fade-in duration-500">
			{/* Header Skeleton */}
			<div className="space-y-4">
				<div className="flex items-center gap-4">
					<div
						className="h-14 w-14 rounded-2xl animate-pulse"
						style={{ background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)` }}
					/>
					<div className="space-y-2">
						<div className="h-8 w-56 rounded-lg bg-muted/30 animate-pulse" />
						<div className="h-4 w-96 rounded bg-muted/20 animate-pulse" />
					</div>
				</div>
			</div>

			{/* Tabs Skeleton */}
			<div className="flex gap-6 border-b border-border/30 pb-4">
				{Array.from({ length: 6 }).map((_, i) => (
					<div
						key={i}
						className="h-6 rounded bg-muted/20 animate-pulse"
						style={{
							width: `${60 + Math.random() * 40}px`,
							animationDelay: `${i * 100}ms`,
						}}
					/>
				))}
			</div>

			{/* Content Grid Skeleton */}
			<div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
				{Array.from({ length: 6 }).map((_, i) => (
					<div
						key={i}
						className="rounded-2xl border border-border/30 bg-card/20 p-6 space-y-4 animate-pulse"
						style={{ animationDelay: `${i * 100}ms` }}
					>
						<div className="h-6 w-24 rounded-lg bg-muted/20" />
						<div className="h-5 w-3/4 rounded bg-muted/15" />
						<div className="h-16 w-full rounded-xl bg-muted/10" />
						<div className="flex gap-2">
							<div className="h-8 flex-1 rounded-lg bg-muted/15" />
							<div className="h-8 w-20 rounded-lg bg-muted/15" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
};

/**
 * Premium TRaSH Guides Client Component
 *
 * Main orchestrator for the TRaSH Guides interface with:
 * - Theme-aware premium styling
 * - Glassmorphic effects
 * - Gradient accents
 * - Smooth animations
 */
export const TrashGuidesClient = () => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

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
		return <PremiumSkeleton />;
	}

	if (error) {
		return (
			<div
				className="rounded-2xl border p-6 backdrop-blur-sm animate-in fade-in duration-300"
				style={{
					backgroundColor: SEMANTIC_COLORS.error.bg,
					borderColor: SEMANTIC_COLORS.error.border,
				}}
			>
				<div className="flex items-start gap-4">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
						style={{ backgroundColor: `${SEMANTIC_COLORS.error.from}20` }}
					>
						<AlertCircle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.error.from }} />
					</div>
					<div>
						<h3 className="font-semibold text-foreground mb-1">Failed to load cache status</h3>
						<p className="text-sm text-muted-foreground">
							{error instanceof Error ? error.message : "Please refresh the page and try again."}
						</p>
					</div>
				</div>
			</div>
		);
	}

	if (!cacheStatus) {
		return (
			<PremiumEmptyState
				icon={AlertCircle}
				title="No cache data available"
				description="TRaSH Guides cache is not initialized. Refresh to fetch data."
			/>
		);
	}

	return (
		<div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
			{/* Premium Header */}
			<header className="space-y-6">
				<div className="flex items-start justify-between gap-4 flex-wrap">
					<div className="flex items-center gap-4">
						{/* Icon Container */}
						<div
							className="flex h-14 w-14 items-center justify-center rounded-2xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<BookOpen className="h-7 w-7" style={{ color: themeGradient.from }} />
						</div>

						<div>
							<h1
								className="text-3xl font-bold tracking-tight"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
								}}
							>
								TRaSH Guides
							</h1>
							<p className="text-muted-foreground mt-1">
								Expert configurations for your Radarr and Sonarr instances
							</p>
						</div>
					</div>

					{/* Cache Stats Badge */}
					{cacheStatus?.stats && (
						<div
							className="flex items-center gap-4 rounded-xl px-4 py-2.5"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}10, ${themeGradient.to}10)`,
								border: `1px solid ${themeGradient.from}20`,
							}}
						>
							<div className="flex items-center gap-2">
								<HardDrive className="h-4 w-4 text-muted-foreground" />
								<span className="text-sm">
									<span className="font-semibold" style={{ color: themeGradient.from }}>
										{cacheStatus.stats.totalEntries}
									</span>
									<span className="text-muted-foreground ml-1">entries</span>
								</span>
							</div>
							{cacheStatus.stats.staleEntries > 0 && (
								<>
									<span className="text-border">•</span>
									<div className="flex items-center gap-1.5">
										<Clock className="h-3.5 w-3.5" style={{ color: SEMANTIC_COLORS.warning.from }} />
										<span
											className="text-sm font-medium"
											style={{ color: SEMANTIC_COLORS.warning.from }}
										>
											{cacheStatus.stats.staleEntries} stale
										</span>
									</div>
								</>
							)}
						</div>
					)}
				</div>

				{/* Premium Tab Navigation */}
				<TrashGuidesTabs activeTab={activeTab} onTabChange={setActiveTab} />
			</header>

			{/* Refresh Error Alert */}
			{refreshMutation.isError && (
				<div
					className="rounded-2xl border p-4 backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-300"
					style={{
						backgroundColor: SEMANTIC_COLORS.error.bg,
						borderColor: SEMANTIC_COLORS.error.border,
					}}
				>
					<div className="flex items-center justify-between gap-4">
						<div className="flex items-center gap-3">
							<AlertCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
							<div>
								<p className="font-medium text-foreground">Refresh failed</p>
								<p className="text-sm text-muted-foreground">
									{refreshMutation.error instanceof Error
										? refreshMutation.error.message
										: "Failed to refresh cache. Please try again."}
								</p>
							</div>
						</div>
						<button
							type="button"
							onClick={() => refreshMutation.reset()}
							className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
						>
							Dismiss
						</button>
					</div>
				</div>
			)}

			{/* Tab Content */}
			<div className="animate-in fade-in duration-300">
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
						{/* History Header Card */}
						<div
							className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-6"
						>
							<div className="flex items-start gap-4">
								<div
									className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
										border: `1px solid ${themeGradient.from}30`,
									}}
								>
									<Zap className="h-6 w-6" style={{ color: themeGradient.from }} />
								</div>
								<div>
									<h3
										className="text-lg font-semibold"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											WebkitBackgroundClip: "text",
											WebkitTextFillColor: "transparent",
										}}
									>
										Deployment History
									</h3>
									<p className="text-muted-foreground mt-1">
										View all template deployments across your instances. Track deployment status, review applied configurations, and undeploy when needed.
									</p>
								</div>
							</div>
						</div>

						{/* Global Deployment History Table */}
						<DeploymentHistoryTable />
					</div>
				) : activeTab === "bulk-scores" ? (
					<div
						className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-6"
					>
						{isAuthLoading ? (
							<div className="flex items-center justify-center py-12">
								<div
									className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
									style={{ borderColor: `${themeGradient.from}40`, borderTopColor: 'transparent' }}
								/>
							</div>
						) : currentUser?.id ? (
							<BulkScoreManager
								userId={currentUser.id}
								onOperationComplete={() => {
									refetchCache();
								}}
							/>
						) : (
							<div className="text-center py-12">
								<Sparkles className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
								<p className="text-muted-foreground">
									Please log in to manage bulk scores
								</p>
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
			</div>

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
