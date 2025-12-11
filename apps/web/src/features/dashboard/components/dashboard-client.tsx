"use client";

import { useMemo, useState } from "react";
import {
	Button,
	Alert,
	AlertTitle,
	AlertDescription,
	EmptyState,
	SkeletonText,
	SkeletonCard,
	Pagination,
	Typography,
	StatCard,
} from "../../../components/ui";
import { Section } from "../../../components/layout";
import { AlertCircle } from "lucide-react";
import { QueueTable } from "./queue-table";
import { DashboardTabs, type DashboardTab } from "./dashboard-tabs";
import ManualImportModal from "../../manual-import/components/manual-import-modal";
import { ServiceInstancesTable, QueueFilters } from "../../../components/presentational";
import { useDashboardData } from "../hooks/useDashboardData";
import { useDashboardFilters } from "../hooks/useDashboardFilters";
import { useDashboardQueue } from "../hooks/useDashboardQueue";
import { useQueueGrouping } from "../hooks";
import { useIncognitoMode } from "../../../lib/incognito";

export const DashboardClient = () => {
	const [incognitoMode] = useIncognitoMode();
	const [activeTab, setActiveTab] = useState<DashboardTab>("overview");

	// Data hooks
	const {
		currentUser,
		userLoading,
		userError,
		services,
		servicesRefetch,
		groupedByService,
		queueAggregated,
		queueInstances,
		totalQueueItems,
		queueLoading,
		queueRefetch,
		instanceOptions,
		statusOptions,
		isLoading,
	} = useDashboardData();

	// Filter hooks - handles filtering and pagination state
	// Note: We'll pass summary rows after grouping for correct pagination
	const filterState = useDashboardFilters(queueAggregated);

	// Group FILTERED items into summary rows
	// This is the correct order: filter → group → paginate
	const allSummaryRows = useQueueGrouping(filterState.filteredItems);

	// Re-calculate pagination based on grouped rows
	const paginatedRows = useMemo(() => {
		const start = (filterState.page - 1) * filterState.pageSize;
		return allSummaryRows.slice(start, start + filterState.pageSize);
	}, [allSummaryRows, filterState.page, filterState.pageSize]);

	// Get all items from paginated rows (for selection/actions)
	const paginatedItems = useMemo(() => {
		return paginatedRows.flatMap((row) => row.items);
	}, [paginatedRows]);

	// Destructure filter state for easier access
	const {
		serviceFilter,
		setServiceFilter,
		instanceFilter,
		setInstanceFilter,
		statusFilter,
		setStatusFilter,
		page,
		setPage,
		pageSize,
		setPageSize,
		filteredItems,
		filtersActive,
		emptyMessage,
		resetFilters,
		SERVICE_FILTERS,
	} = filterState;

	// Queue action hooks
	const {
		handleQueueRetry,
		handleQueueRemove,
		handleQueueChangeCategory,
		queueActionsPending,
		queueActionsError,
		openManualImport,
		manualImportContext,
		handleManualImportOpenChange,
		handleManualImportCompleted,
		queueMessage,
		clearQueueMessage,
	} = useDashboardQueue(queueRefetch);

	if (isLoading) {
		return (
			<div className="space-y-6">
				<SkeletonText lines={2} />
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
					<SkeletonCard />
					<SkeletonCard />
					<SkeletonCard />
					<SkeletonCard />
				</div>
				<SkeletonCard />
			</div>
		);
	}

	if (userError) {
		return (
			<Alert variant="danger">
				<AlertTitle>Failed to load user session</AlertTitle>
				<AlertDescription>Please refresh the page and try again.</AlertDescription>
			</Alert>
		);
	}

	if (!currentUser) {
		return (
			<EmptyState
				icon={AlertCircle}
				title="Sign in required"
				description="You are not authenticated. Log in through the dashboard API to manage Sonarr, Radarr, and Prowlarr instances."
			/>
		);
	}

	return (
		<section className="flex flex-col gap-6">
			<header className="space-y-2">
				<Typography variant="overline">Welcome back</Typography>
				<Typography variant="h1">Hi {currentUser.username}</Typography>
				<Typography variant="body">
					Here is a quick snapshot of the configured *arr instances. Use the refresh button to pull
					the latest configuration snapshot.
				</Typography>
				<div className="flex gap-2">
					<Button
						variant="secondary"
						onClick={() => void servicesRefetch()}
					>
						Refresh data
					</Button>
				</div>
			</header>

			<DashboardTabs
				activeTab={activeTab}
				onTabChange={setActiveTab}
				queueCount={totalQueueItems}
			/>

			{activeTab === "overview" && (
				<div className="flex flex-col gap-10">
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
						{["sonarr", "radarr", "prowlarr"].map((service) => {
							const count = groupedByService[service] ?? 0;
							return (
								<StatCard
									key={service}
									label={service}
									value={count}
									description={count === 0 ? "No instances configured yet." : "Active instances configured."}
								/>
							);
						})}
						<StatCard
							label="Queue"
							value={totalQueueItems}
							description="Items across Sonarr and Radarr queues."
							onClick={() => setActiveTab("queue")}
							className="cursor-pointer hover:border-primary/50 transition-colors"
						/>
					</div>

					<Section title="Configured Instances">
						{services.length === 0 ? (
							<EmptyState
								title="No instances configured"
								description="Add an instance via the API to see it appear in real time."
							/>
						) : (
							<ServiceInstancesTable instances={services} incognitoMode={incognitoMode} />
						)}
					</Section>
				</div>
			)}

			{activeTab === "queue" && (
				<Section
					title="Active Queue"
					description={`Monitoring ${queueInstances.length} instance${queueInstances.length === 1 ? "" : "s"}`}
				>
					<div className="mb-3 flex justify-end">
						<Typography variant="caption">
							Showing {paginatedRows.length} of {allSummaryRows.length} cards ({filteredItems.length} items)
						</Typography>
					</div>

					<QueueFilters
						serviceFilter={serviceFilter}
						onServiceFilterChange={(value) => setServiceFilter(value as typeof serviceFilter)}
						serviceOptions={SERVICE_FILTERS}
						instanceFilter={instanceFilter}
						onInstanceFilterChange={setInstanceFilter}
						instanceOptions={instanceOptions}
						statusFilter={statusFilter}
						onStatusFilterChange={setStatusFilter}
						statusOptions={statusOptions}
						filtersActive={filtersActive}
						onReset={resetFilters}
					/>

					{queueMessage && (
						<Alert variant="success" dismissible onDismiss={clearQueueMessage}>
							<AlertDescription>{queueMessage.message}</AlertDescription>
						</Alert>
					)}
					{queueActionsError && (
						<Alert variant="danger">
							<AlertDescription>
								{queueActionsError.message ||
									"Failed to process the last queue action. Please try again."}
							</AlertDescription>
						</Alert>
					)}
					{allSummaryRows.length > 0 && (
						<Pagination
							currentPage={page}
							totalItems={allSummaryRows.length}
							pageSize={pageSize}
							onPageChange={setPage}
							onPageSizeChange={setPageSize}
							pageSizeOptions={[5, 10, 25, 50, 100]}
						/>
					)}
					<QueueTable
						items={paginatedItems}
						summaryRows={paginatedRows}
						loading={queueLoading}
						pending={queueActionsPending}
						onRetry={handleQueueRetry}
						onManualImport={(items) => {
							const [first] = items;
							if (first) {
								openManualImport(first);
							}
						}}
						onRemove={handleQueueRemove}
						onChangeCategory={handleQueueChangeCategory}
						emptyMessage={emptyMessage}
					/>
					{allSummaryRows.length > 0 && (
						<Pagination
							currentPage={page}
							totalItems={allSummaryRows.length}
							pageSize={pageSize}
							onPageChange={setPage}
							onPageSizeChange={setPageSize}
							pageSizeOptions={[5, 10, 25, 50, 100]}
						/>
					)}
				</Section>
			)}

			<ManualImportModal
				instanceId={manualImportContext.instanceId}
				instanceName={manualImportContext.instanceName}
				service={manualImportContext.service}
				downloadId={manualImportContext.downloadId}
				open={manualImportContext.open}
				onOpenChange={handleManualImportOpenChange}
				onCompleted={handleManualImportCompleted}
			/>
		</section>
	);
};
