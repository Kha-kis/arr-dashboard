import type { TrashGuidesTab } from "../../features/trash-guides/hooks/use-trash-guides-state";

interface TrashGuidesTabsProps {
	activeTab: TrashGuidesTab;
	onTabChange: (tab: TrashGuidesTab) => void;
}

/**
 * Tab navigation component for TRaSH Guides interface.
 * Pure presentational component for rendering tab buttons.
 *
 * @param activeTab - Currently active tab
 * @param onTabChange - Handler called when tab is clicked
 *
 * @example
 * <TrashGuidesTabs activeTab="templates" onTabChange={setActiveTab} />
 */
export const TrashGuidesTabs = ({ activeTab, onTabChange }: TrashGuidesTabsProps) => {
	const tabs: Array<{ id: TrashGuidesTab; label: string }> = [
		{ id: "templates", label: "Templates" },
		{ id: "custom-formats", label: "Custom Formats" },
		{ id: "bulk-scores", label: "Bulk Score Management" },
		{ id: "history", label: "Deployment History" },
		{ id: "scheduler", label: "Update Scheduler" },
		{ id: "cache", label: "Cache Status" },
	];

	return (
		<div className="border-b border-white/10">
			<nav className="flex gap-6">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						onClick={() => onTabChange(tab.id)}
						className={`border-b-2 px-1 pb-3 text-sm font-medium transition ${
							activeTab === tab.id
								? "border-primary text-white"
								: "border-transparent text-white/60 hover:text-white"
						}`}
					>
						{tab.label}
					</button>
				))}
			</nav>
		</div>
	);
};
