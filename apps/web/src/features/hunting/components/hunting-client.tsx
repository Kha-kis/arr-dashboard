"use client";

import { Activity, RefreshCw, Settings, Target } from "lucide-react";
import { useState } from "react";
import {
	PremiumPageHeader,
	PremiumPageLoading,
	type PremiumTab,
	PremiumTabs,
} from "../../../components/layout";
import { Alert, AlertDescription, Button } from "../../../components/ui";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useHuntingStatus } from "../hooks/useHuntingStatus";
import { HuntingActivity } from "./hunting-activity";
import { HuntingConfig } from "./hunting-config";
import { HuntingOverview } from "./hunting-overview";

export type HuntingTab = "overview" | "activity" | "config";

/**
 * Premium Hunting Client
 *
 * Main orchestrator for the hunting feature with:
 * - Premium gradient header
 * - Theme-aware tab navigation
 * - Staggered entrance animations
 */
export const HuntingClient = () => {
	const { gradient: _themeGradient } = useThemeGradient();

	const [activeTab, setActiveTab] = useState<HuntingTab>("overview");
	const { status, isLoading, error, refetch } = useHuntingStatus();

	// Tab configuration with gradient styling
	const tabs: PremiumTab[] = [
		{
			id: "overview",
			label: "Overview",
			icon: Target,
		},
		{
			id: "activity",
			label: "Activity",
			icon: Activity,
			badge: status?.recentActivityCount,
		},
		{
			id: "config",
			label: "Configuration",
			icon: Settings,
		},
	];

	// Loading state
	if (isLoading) {
		return <PremiumPageLoading showHeader cardCount={4} />;
	}

	// Error state
	if (error) {
		return (
			<Alert variant="danger">
				<AlertDescription>Failed to load hunting status. Please try again later.</AlertDescription>
			</Alert>
		);
	}

	return (
		<>
			{/* Premium Header */}
			<PremiumPageHeader
				label="Automated Search"
				labelIcon={Target}
				title="Hunting"
				gradientTitle
				description="Automatically search for missing content and quality upgrades across your Sonarr and Radarr instances"
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

			{/* Premium Tab Navigation */}
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
			>
				<PremiumTabs
					tabs={tabs}
					activeTab={activeTab}
					onTabChange={(tabId) => setActiveTab(tabId as HuntingTab)}
				/>
			</div>

			{/* Tab Content */}
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
			>
				{activeTab === "overview" && <HuntingOverview status={status} onRefresh={refetch} />}
				{activeTab === "activity" && <HuntingActivity />}
				{activeTab === "config" && <HuntingConfig />}
			</div>
		</>
	);
};
