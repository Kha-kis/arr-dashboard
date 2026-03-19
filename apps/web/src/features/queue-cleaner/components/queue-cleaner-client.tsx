"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Activity, BarChart3, RefreshCw, Settings, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	PremiumPageHeader,
	PremiumPageLoading,
	type PremiumTab,
	PremiumTabs,
} from "../../../components/layout";
import { Alert, AlertDescription, Button, toast } from "../../../components/ui";
import { useQueueCleanerStatus } from "../hooks/useQueueCleanerStatus";
import { QueueCleanerActivity } from "./queue-cleaner-activity";
import { QueueCleanerConfig } from "./queue-cleaner-config";
import { QueueCleanerOverview } from "./queue-cleaner-overview";
import { QueueCleanerStatistics } from "./queue-cleaner-statistics";

export type CleanerTab = "overview" | "activity" | "statistics" | "config";

export const QueueCleanerClient = () => {
	const [activeTab, setActiveTab] = useState<CleanerTab>("overview");
	const { status, isLoading, error } = useQueueCleanerStatus();
	const queryClient = useQueryClient();
	const [isRefreshing, setIsRefreshing] = useState(false);
	const refreshTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => {
		return () => clearTimeout(refreshTimeout.current);
	}, []);

	const handleRefresh = useCallback(() => {
		if (isRefreshing) return;
		setIsRefreshing(true);
		clearTimeout(refreshTimeout.current);

		void queryClient
			.invalidateQueries({ queryKey: ["queue-cleaner"] })
			.catch(() => {
				toast.error("Failed to refresh queue cleaner data");
			})
			.finally(() => {
				refreshTimeout.current = setTimeout(() => setIsRefreshing(false), 600);
			});
	}, [queryClient, isRefreshing]);

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
						onClick={handleRefresh}
						disabled={isRefreshing}
						className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80"
					>
						<RefreshCw
							className={`h-4 w-4 transition-transform ${isRefreshing ? "animate-spin" : ""}`}
						/>
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
					<QueueCleanerOverview status={status} onRefresh={handleRefresh} />
				)}
				{activeTab === "activity" && <QueueCleanerActivity />}
				{activeTab === "statistics" && <QueueCleanerStatistics />}
				{activeTab === "config" && <QueueCleanerConfig />}
			</div>
		</>
	);
};
