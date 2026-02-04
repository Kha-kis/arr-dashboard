"use client";

import { useState } from "react";
import { Trash2, Activity, Settings, RefreshCw, BarChart3 } from "lucide-react";
import { Button, Alert, AlertDescription } from "../../../components/ui";
import {
	PremiumPageHeader,
	PremiumTabs,
	PremiumPageLoading,
	type PremiumTab,
} from "../../../components/layout";
import { QueueCleanerOverview } from "./queue-cleaner-overview";
import { QueueCleanerActivity } from "./queue-cleaner-activity";
import { QueueCleanerConfig } from "./queue-cleaner-config";
import { QueueCleanerStatistics } from "./queue-cleaner-statistics";
import { useQueueCleanerStatus } from "../hooks/useQueueCleanerStatus";

export type CleanerTab = "overview" | "activity" | "statistics" | "config";

export const QueueCleanerClient = () => {
	const [activeTab, setActiveTab] = useState<CleanerTab>("overview");
	const { status, isLoading, error, refetch } = useQueueCleanerStatus();

	const tabs: PremiumTab[] = [
		{
			id: "overview",
			label: "Overview",
			icon: Trash2,
		},
		{
			id: "activity",
			label: "Activity",
			icon: Activity,
		},
		{
			id: "statistics",
			label: "Statistics",
			icon: BarChart3,
		},
		{
			id: "config",
			label: "Configuration",
			icon: Settings,
		},
	];

	if (isLoading) {
		return <PremiumPageLoading showHeader cardCount={4} />;
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertDescription>
					Failed to load queue cleaner status. Please try again later.
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<>
			<PremiumPageHeader
				label="Automated Cleanup"
				labelIcon={Trash2}
				title="Queue Cleaner"
				gradientTitle
				description="Automatically clean stuck, failed, and slow downloads from your Sonarr and Radarr queues"
				actions={
					<Button
						variant="secondary"
						onClick={() => void refetch()}
						className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80"
					>
						<RefreshCw className="h-4 w-4" />
						Refresh
					</Button>
				}
			/>

			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
			>
				<PremiumTabs
					tabs={tabs}
					activeTab={activeTab}
					onTabChange={(tabId) => setActiveTab(tabId as CleanerTab)}
				/>
			</div>

			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
			>
				{activeTab === "overview" && (
					<QueueCleanerOverview status={status} onRefresh={refetch} />
				)}
				{activeTab === "activity" && <QueueCleanerActivity />}
				{activeTab === "statistics" && <QueueCleanerStatistics />}
				{activeTab === "config" && <QueueCleanerConfig />}
			</div>
		</>
	);
};
