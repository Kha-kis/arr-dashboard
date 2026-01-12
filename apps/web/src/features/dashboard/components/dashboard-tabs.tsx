"use client";

import { motion, LayoutGroup } from "framer-motion";
import { LayoutGrid, ListOrdered } from "lucide-react";
import { cn } from "../../../lib/utils";
import { springs } from "../../../components/motion";

export type DashboardTab = "overview" | "queue";

interface DashboardTabsProps {
	activeTab: DashboardTab;
	onTabChange: (tab: DashboardTab) => void;
	queueCount: number;
	themeGradient?: { from: string; to: string; glow: string };
}

/**
 * Premium tab navigation component for Dashboard interface.
 * Features smooth underline animations and badge styling that respects theme.
 */
export const DashboardTabs = ({
	activeTab,
	onTabChange,
	queueCount,
	themeGradient,
}: DashboardTabsProps) => {
	const tabs: Array<{
		id: DashboardTab;
		label: string;
		icon: typeof LayoutGrid;
		badge?: number;
	}> = [
		{ id: "overview", label: "Overview", icon: LayoutGrid },
		{ id: "queue", label: "Active Queue", icon: ListOrdered, badge: queueCount },
	];

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: "50ms", animationFillMode: "backwards" }}
		>
			<div className="relative border-b border-border/50">
				<LayoutGroup>
					<nav className="flex gap-1" role="tablist">
					{tabs.map((tab) => {
						const Icon = tab.icon;
						const isActive = activeTab === tab.id;
						const hasBadge = tab.badge !== undefined && tab.badge > 0;

						return (
							<motion.button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={isActive}
								onClick={() => onTabChange(tab.id)}
								className={cn(
									"group relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors duration-300",
									isActive
										? "text-foreground"
										: "text-muted-foreground hover:text-foreground"
								)}
								whileHover={{ scale: 1.02 }}
								whileTap={{ scale: 0.98 }}
								transition={springs.quick}
							>
								{/* Icon */}
								<Icon
									className={cn(
										"h-4 w-4 transition-all duration-300",
										isActive && "scale-110"
									)}
									style={isActive && themeGradient ? { color: themeGradient.from } : undefined}
								/>

								{/* Label */}
								<span className="relative">
									{tab.label}
								</span>

								{/* Badge */}
								{hasBadge && (
									<span
										className={cn(
											"relative inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium transition-all duration-300",
											!themeGradient && (isActive
												? "bg-primary text-primary-foreground"
												: "bg-muted text-muted-foreground group-hover:bg-primary/20 group-hover:text-primary")
										)}
										style={themeGradient ? {
											background: isActive
												? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
												: `${themeGradient.from}15`,
											color: isActive ? "white" : themeGradient.from,
										} : undefined}
									>
										{tab.badge}
										{/* Pulse indicator for active queue items */}
										{tab.id === "queue" && !isActive && (
											<span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
												<span
													className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
													style={{ backgroundColor: themeGradient?.from ?? "hsl(var(--primary))" }}
												/>
												<span
													className="relative inline-flex h-2 w-2 rounded-full"
													style={{ backgroundColor: themeGradient?.from ?? "hsl(var(--primary))" }}
												/>
											</span>
										)}
									</span>
								)}

								{/* Active indicator - animated underline with layoutId for sliding effect */}
								{isActive && (
									<motion.span
										layoutId="dashboard-tab-indicator"
										className="absolute bottom-0 left-0 right-0 h-0.5"
										style={{
											background: themeGradient
												? `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`
												: "hsl(var(--primary))",
										}}
										transition={springs.snappy}
									/>
								)}
								{/* Hover indicator for non-active tabs */}
								{!isActive && (
									<span
										className="absolute bottom-0 left-0 right-0 h-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
										style={{
											background: "hsl(var(--muted-foreground) / 0.3)",
										}}
									/>
								)}

								{/* Hover glow effect */}
								<span
									className={cn(
										"pointer-events-none absolute inset-0 rounded-lg transition-all duration-300",
										isActive
											? "opacity-100"
											: "opacity-0 group-hover:opacity-100"
									)}
									style={{
										background: isActive && themeGradient
											? `${themeGradient.from}08`
											: isActive
												? "hsl(var(--primary) / 0.05)"
												: "hsl(var(--muted) / 0.3)",
									}}
								/>
							</motion.button>
						);
					})}
					</nav>
				</LayoutGroup>
			</div>
		</div>
	);
};
