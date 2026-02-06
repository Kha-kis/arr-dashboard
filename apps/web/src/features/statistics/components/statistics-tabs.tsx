"use client";

export type StatisticsTab = "overview" | "sonarr" | "radarr" | "prowlarr" | "lidarr" | "readarr";

interface StatisticsTabsProps {
	activeTab: StatisticsTab;
	onTabChange: (tab: StatisticsTab) => void;
	sonarrCount: number;
	radarrCount: number;
	prowlarrCount: number;
	lidarrCount: number;
	readarrCount: number;
	healthIssueCount: number;
}

/**
 * Tab navigation component for Statistics interface.
 */
export const StatisticsTabs = ({
	activeTab,
	onTabChange,
	sonarrCount,
	radarrCount,
	prowlarrCount,
	lidarrCount,
	readarrCount,
	healthIssueCount,
}: StatisticsTabsProps) => {
	const tabs: Array<{ id: StatisticsTab; label: string; badge?: number; badgeVariant?: "default" | "warning" }> = [
		{ id: "overview", label: "Overview", badge: healthIssueCount > 0 ? healthIssueCount : undefined, badgeVariant: "warning" },
		{ id: "sonarr", label: "Sonarr", badge: sonarrCount },
		{ id: "radarr", label: "Radarr", badge: radarrCount },
		{ id: "lidarr", label: "Lidarr", badge: lidarrCount },
		{ id: "readarr", label: "Readarr", badge: readarrCount },
		{ id: "prowlarr", label: "Prowlarr", badge: prowlarrCount },
	];

	return (
		<div className="border-b border-border">
			<nav className="flex gap-6">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						onClick={() => onTabChange(tab.id)}
						className={`border-b-2 px-1 pb-3 text-sm font-medium transition flex items-center gap-2 ${
							activeTab === tab.id
								? "border-primary text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground"
						}`}
					>
						{tab.label}
						{tab.badge !== undefined && tab.badge > 0 && (
							<span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium ${
								tab.badgeVariant === "warning"
									? "bg-amber-500/10 text-amber-400"
									: "bg-primary/10 text-primary"
							}`}>
								{tab.badge}
							</span>
						)}
					</button>
				))}
			</nav>
		</div>
	);
};
