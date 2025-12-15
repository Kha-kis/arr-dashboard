"use client";

import { Target, Activity, Settings } from "lucide-react";

export type HuntingTab = "overview" | "activity" | "config";

interface HuntingTabsProps {
	activeTab: HuntingTab;
	onTabChange: (tab: HuntingTab) => void;
	activityCount?: number;
}

/**
 * Tab navigation component for Hunting interface.
 */
export const HuntingTabs = ({ activeTab, onTabChange, activityCount }: HuntingTabsProps) => {
	const tabs: Array<{ id: HuntingTab; label: string; icon: React.ElementType; badge?: number }> = [
		{ id: "overview", label: "Overview", icon: Target },
		{ id: "activity", label: "Activity", icon: Activity, badge: activityCount },
		{ id: "config", label: "Configuration", icon: Settings },
	];

	return (
		<div className="border-b border-border">
			<nav className="flex gap-6">
				{tabs.map((tab) => {
					const Icon = tab.icon;
					return (
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
							<Icon className="h-4 w-4" />
							{tab.label}
							{tab.badge !== undefined && tab.badge > 0 && (
								<span className="inline-flex items-center justify-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
									{tab.badge}
								</span>
							)}
						</button>
					);
				})}
			</nav>
		</div>
	);
};
