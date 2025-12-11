"use client";

export type DashboardTab = "overview" | "queue";

interface DashboardTabsProps {
	activeTab: DashboardTab;
	onTabChange: (tab: DashboardTab) => void;
	queueCount: number;
}

/**
 * Tab navigation component for Dashboard interface.
 */
export const DashboardTabs = ({ activeTab, onTabChange, queueCount }: DashboardTabsProps) => {
	const tabs: Array<{ id: DashboardTab; label: string; badge?: number }> = [
		{ id: "overview", label: "Overview" },
		{ id: "queue", label: "Active Queue", badge: queueCount },
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
								? "border-primary text-fg"
								: "border-transparent text-fg-muted hover:text-fg"
						}`}
					>
						{tab.label}
						{tab.badge !== undefined && tab.badge > 0 && (
							<span className="inline-flex items-center justify-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
								{tab.badge}
							</span>
						)}
					</button>
				))}
			</nav>
		</div>
	);
};
