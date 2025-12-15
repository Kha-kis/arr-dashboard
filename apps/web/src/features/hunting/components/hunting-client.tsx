"use client";

import { useState } from "react";
import {
	Button,
	Alert,
	AlertDescription,
	SkeletonCard,
	Typography,
} from "../../../components/ui";
import { HuntingTabs, type HuntingTab } from "./hunting-tabs";
import { HuntingOverview } from "./hunting-overview";
import { HuntingActivity } from "./hunting-activity";
import { HuntingConfig } from "./hunting-config";
import { useHuntingStatus } from "../hooks/useHuntingStatus";

export const HuntingClient = () => {
	const [activeTab, setActiveTab] = useState<HuntingTab>("overview");
	const { status, isLoading, error, refetch } = useHuntingStatus();

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div className="space-y-2">
					<div className="h-4 w-24 bg-bg-subtle animate-pulse rounded" />
					<div className="h-8 w-64 bg-bg-subtle animate-pulse rounded" />
				</div>
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
					<SkeletonCard />
					<SkeletonCard />
					<SkeletonCard />
					<SkeletonCard />
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertDescription>
					Failed to load hunting status. Please try again later.
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<section className="flex flex-col gap-6">
			<header className="space-y-2">
				<Typography variant="overline">Automated Search</Typography>
				<Typography variant="h1">Hunting</Typography>
				<Typography variant="body">
					Automatically search for missing content and quality upgrades across your Sonarr and Radarr instances.
				</Typography>
				<div className="flex gap-2">
					<Button variant="secondary" onClick={() => void refetch()}>
						Refresh status
					</Button>
				</div>
			</header>

			<HuntingTabs
				activeTab={activeTab}
				onTabChange={setActiveTab}
				activityCount={status?.recentActivityCount}
			/>

			{activeTab === "overview" && <HuntingOverview status={status} onRefresh={refetch} />}
			{activeTab === "activity" && <HuntingActivity />}
			{activeTab === "config" && <HuntingConfig />}
		</section>
	);
};
