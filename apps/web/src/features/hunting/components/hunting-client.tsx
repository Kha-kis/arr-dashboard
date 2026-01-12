"use client";

import { useState } from "react";
import { Target, Activity, Settings, RefreshCw } from "lucide-react";
import { Button, Alert, AlertDescription } from "../../../components/ui";
import {
	PremiumPageHeader,
	PremiumTabs,
	PremiumPageLoading,
	type PremiumTab,
} from "../../../components/layout";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { HuntingOverview } from "./hunting-overview";
import { HuntingActivity } from "./hunting-activity";
import { HuntingConfig } from "./hunting-config";
import { useHuntingStatus } from "../hooks/useHuntingStatus";

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
	const { gradient: themeGradient } = useThemeGradient();

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
				<AlertDescription>
					Failed to load hunting status. Please try again later.
				</AlertDescription>
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
						className="gap-2 border-border/50 bg-card/50 backdrop-blur-sm hover:bg-card/80"
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
				{activeTab === "overview" && (
					<HuntingOverview status={status} onRefresh={refetch} />
				)}
				{activeTab === "activity" && <HuntingActivity />}
				{activeTab === "config" && <HuntingConfig />}
			</div>
		</>
	);
};
