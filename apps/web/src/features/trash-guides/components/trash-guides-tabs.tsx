"use client";

import {
	FileText,
	Palette,
	SlidersHorizontal,
	History,
	Clock,
	Database,
	Settings,
} from "lucide-react";
import type { TrashGuidesTab } from "../hooks/use-trash-guides-state";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

interface TrashGuidesTabsProps {
	activeTab: TrashGuidesTab;
	onTabChange: (tab: TrashGuidesTab) => void;
}

/**
 * Premium Tab Navigation for TRaSH Guides
 *
 * Features:
 * - Theme-aware active state with gradient underline
 * - Icon-enhanced tabs
 * - Smooth hover transitions
 * - Responsive design
 */
export const TrashGuidesTabs = ({ activeTab, onTabChange }: TrashGuidesTabsProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	const tabs: Array<{ id: TrashGuidesTab; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }> = [
		{ id: "templates", label: "Templates", icon: FileText },
		{ id: "custom-formats", label: "Custom Formats", icon: Palette },
		{ id: "bulk-scores", label: "Bulk Scores", icon: SlidersHorizontal },
		{ id: "history", label: "History", icon: History },
		{ id: "scheduler", label: "Scheduler", icon: Clock },
		{ id: "cache", label: "Cache", icon: Database },
		{ id: "settings", label: "Settings", icon: Settings },
	];

	return (
		<div className="border-b border-border/50">
			<nav className="flex gap-1 overflow-x-auto pb-px scrollbar-thin scrollbar-thumb-border/50">
				{tabs.map((tab) => {
					const isActive = activeTab === tab.id;
					const Icon = tab.icon;

					return (
						<button
							key={tab.id}
							type="button"
							onClick={() => onTabChange(tab.id)}
							className="group relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors whitespace-nowrap"
							style={{
								color: isActive ? themeGradient.from : undefined,
							}}
						>
							<Icon
								className={`h-4 w-4 transition-colors ${
									isActive
										? ""
										: "text-muted-foreground group-hover:text-foreground"
								}`}
								style={isActive ? { color: themeGradient.from } : undefined}
							/>
							<span
								className={`transition-colors ${
									isActive
										? ""
										: "text-muted-foreground group-hover:text-foreground"
								}`}
							>
								{tab.label}
							</span>

							{/* Active Indicator */}
							{isActive && (
								<span
									className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
									style={{
										background: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
									}}
								/>
							)}

							{/* Hover Indicator (only when not active) */}
							{!isActive && (
								<span
									className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-border/50 opacity-0 transition-opacity group-hover:opacity-100"
								/>
							)}
						</button>
					);
				})}
			</nav>
		</div>
	);
};
