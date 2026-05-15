"use client";

import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
	Activity,
	BarChart3,
	Calendar,
	ChevronDown,
	ChevronRight,
	Compass,
	Eraser,
	Globe,
	History,
	Inbox,
	LayoutDashboard,
	Library,
	Menu,
	Network,
	Search,
	Settings,
	Sparkles,
	Tag,
	Target,
	Trash2,
	X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import { cn } from "../../lib/utils";
import { useColorTheme } from "../../providers/color-theme-provider";
import { springs } from "../motion";

interface NavItem {
	href: string;
	label: string;
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

interface NavGroup {
	id: string;
	label: string;
	items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
	{
		id: "overview",
		label: "Overview",
		items: [
			// Dashboard first — it is the product's primary landing surface
			// (/ redirects here post-auth) and hosts the Needs Attention panel.
			// Pulse remains the deep-inspection view below it.
			{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
			{ href: "/pulse", label: "Pulse", icon: Activity },
			// `/qui` is the at-a-glance entry for the torrent layer — Sonarr/Radarr
			// equivalent for qui. Belongs in Overview, not Maintenance, because
			// it answers "what's going on right now" rather than "what do I
			// need to maintain". The deeper qui-Activity tab and the
			// Cross-Seed page stay under Maintenance as drill-downs.
			{ href: "/qui", label: "qui", icon: Network },
			{ href: "/calendar", label: "Calendar", icon: Calendar },
			{ href: "/statistics", label: "Statistics", icon: BarChart3 },
		],
	},
	{
		id: "media",
		label: "Media",
		items: [
			{ href: "/discover", label: "Discover", icon: Compass },
			{ href: "/library", label: "Library", icon: Library },
			{ href: "/search", label: "Search", icon: Search },
			{ href: "/requests", label: "Requests", icon: Inbox },
		],
	},
	{
		id: "maintenance",
		label: "Maintenance",
		items: [
			{ href: "/hunting", label: "Hunting", icon: Target },
			{ href: "/queue-cleaner", label: "Queue Cleaner", icon: Trash2 },
			{ href: "/library-cleanup", label: "Cleanup", icon: Eraser },
			{ href: "/cross-seed", label: "Cross-Seed", icon: Network },
			{ href: "/qui-activity", label: "qui Activity", icon: History },
			{ href: "/auto-tag", label: "Auto-Tagger", icon: Tag },
			{ href: "/label-sync", label: "Label Sync", icon: Tag },
			{ href: "/history", label: "History", icon: History },
		],
	},
	{
		id: "configuration",
		label: "Configuration",
		items: [
			{ href: "/indexers", label: "Indexers", icon: Globe },
			{ href: "/trash-guides", label: "TRaSH Guides", icon: Sparkles },
			{ href: "/settings", label: "Settings", icon: Settings },
		],
	},
];

const STORAGE_KEY = "sidebar-collapsed-groups";

function loadCollapsedGroups(): Set<string> {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			const parsed: unknown = JSON.parse(stored);
			if (Array.isArray(parsed)) {
				return new Set(parsed.filter((v): v is string => typeof v === "string"));
			}
		}
	} catch {
		// Ignore malformed localStorage
	}
	return new Set();
}

function saveCollapsedGroups(collapsed: Set<string>) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
	} catch {
		// Ignore storage errors
	}
}

/** Find which group contains a given pathname */
function findGroupForPath(pathname: string): string | undefined {
	for (const group of NAV_GROUPS) {
		if (group.items.some((item) => item.href === pathname)) {
			return group.id;
		}
	}
	return undefined;
}

interface NavContentProps {
	useFlatStyling: boolean;
	themeGradient: { from: string; to: string; glow: string };
	pathname: string;
	collapsedGroups: Set<string>;
	onToggleGroup: (groupId: string) => void;
	setMobileMenuOpen: (open: boolean) => void;
}

const NavContent = ({
	useFlatStyling,
	themeGradient,
	pathname,
	collapsedGroups,
	onToggleGroup,
	setMobileMenuOpen,
}: NavContentProps) => (
	<>
		{/* Logo/Brand */}
		<div className="mb-6 relative z-10">
			<div className="flex items-center gap-3">
				<div
					className={cn(
						"flex items-center justify-center",
						useFlatStyling ? "h-5 w-5" : "h-10 w-10 rounded-xl",
					)}
					style={
						useFlatStyling
							? {
									background: themeGradient.from,
								}
							: {
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									boxShadow: `0 8px 24px -8px ${themeGradient.glow}`,
								}
					}
				>
					<LayoutDashboard
						className={useFlatStyling ? "h-4 w-4 text-white" : "h-5 w-5 text-white"}
					/>
				</div>
				<div>
					<h1
						className={cn(
							"font-bold tracking-tight",
							useFlatStyling ? "text-sm text-foreground" : "text-lg",
						)}
						style={
							useFlatStyling
								? undefined
								: {
										background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
										WebkitBackgroundClip: "text",
										WebkitTextFillColor: "transparent",
										backgroundClip: "text",
									}
						}
					>
						Arr Control
					</h1>
					<p className="text-[10px] uppercase tracking-widest text-muted-foreground">
						Media Server
					</p>
				</div>
			</div>
		</div>

		{/* Navigation */}
		<LayoutGroup>
			<nav
				aria-label="Main navigation"
				className="flex flex-col gap-3 relative z-10 overflow-y-auto flex-1 -mx-2 px-2"
			>
				{NAV_GROUPS.map((group) => {
					const isCollapsed = collapsedGroups.has(group.id);
					const hasActiveItem = group.items.some((item) => item.href === pathname);

					return (
						<div key={group.id}>
							{/* Group header */}
							<button
								type="button"
								onClick={() => onToggleGroup(group.id)}
								aria-expanded={!isCollapsed}
								aria-controls={`nav-group-${group.id}`}
								className={cn(
									"flex w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors duration-200",
									"text-muted-foreground/70 hover:text-muted-foreground",
									useFlatStyling && "rounded-none",
								)}
							>
								<motion.div animate={{ rotate: isCollapsed ? -90 : 0 }} transition={springs.quick}>
									<ChevronDown className="h-3 w-3" />
								</motion.div>
								<span className="flex-1 text-left">{group.label}</span>
								{/* Active dot indicator when group is collapsed */}
								{isCollapsed && hasActiveItem && (
									<motion.div
										initial={{ scale: 0 }}
										animate={{ scale: 1 }}
										className="h-1.5 w-1.5 rounded-full"
										style={{
											background: useFlatStyling
												? themeGradient.from
												: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
										}}
									/>
								)}
							</button>

							{/* Group items */}
							<AnimatePresence initial={false}>
								{!isCollapsed && (
									<motion.div
										id={`nav-group-${group.id}`}
										role="region"
										initial={{ height: 0, opacity: 0 }}
										animate={{ height: "auto", opacity: 1 }}
										exit={{ height: 0, opacity: 0 }}
										transition={{ type: "tween", duration: 0.2, ease: "easeInOut" }}
										className="overflow-hidden"
									>
										<div className="flex flex-col gap-1 pt-1">
											{group.items.map((item) => {
												const Icon = item.icon;
												const isActive = pathname === item.href;

												return (
													<Link
														key={item.href}
														href={item.href}
														onClick={() => setMobileMenuOpen(false)}
														aria-current={isActive ? "page" : undefined}
														className={cn(
															"group relative flex items-center gap-3 rounded-xl px-3 py-2 min-h-[40px] text-sm font-medium transition-colors duration-200",
															isActive && !useFlatStyling && "text-white",
															useFlatStyling && "rounded-none",
															!isActive && "text-muted-foreground hover:text-foreground",
														)}
													>
														{/* Active background with gradient */}
														{isActive && !useFlatStyling && (
															<motion.div
																layoutId="sidebar-active-indicator"
																className="absolute inset-0 rounded-xl"
																style={{
																	background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
																	boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
																}}
																transition={springs.snappy}
															/>
														)}

														{/* Hover glow effect for inactive items */}
														{!isActive && !useFlatStyling && (
															<div
																className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"
																style={{
																	background: `linear-gradient(135deg, ${themeGradient.from}10, ${themeGradient.to}05)`,
																}}
															/>
														)}

														{/* Icon */}
														<Icon
															className={cn(
																"relative z-10 h-4 w-4 transition-all duration-300",
																isActive && "drop-shadow-xs",
																!isActive && "group-hover:scale-110",
															)}
															style={!isActive ? { color: themeGradient.from } : undefined}
														/>

														{/* Label */}
														<span className="relative z-10 flex-1">{item.label}</span>

														{/* Active indicator arrow */}
														{isActive && (
															<motion.div
																initial={{ opacity: 0, x: -4 }}
																animate={{ opacity: 1, x: 0 }}
																transition={springs.quick}
															>
																<ChevronRight className="relative z-10 h-4 w-4 text-white/70" />
															</motion.div>
														)}

														{/* Hover indicator for inactive */}
														{!isActive && (
															<ChevronRight
																className={cn(
																	"relative z-10 h-4 w-4 transition-all duration-300",
																	"opacity-0 -translate-x-2 group-hover:opacity-50 group-hover:translate-x-0",
																)}
																style={{ color: themeGradient.from }}
															/>
														)}
													</Link>
												);
											})}
										</div>
									</motion.div>
								)}
							</AnimatePresence>
						</div>
					);
				})}
			</nav>
		</LayoutGroup>

		{/* Bottom decorative element */}
		<div className="mt-auto pt-4 relative z-10">
			<div
				className="h-0.5 rounded-full"
				style={{
					background: `linear-gradient(90deg, ${themeGradient.from}, transparent)`,
					opacity: 0.3,
				}}
			/>
		</div>
	</>
);

export const Sidebar = () => {
	const pathname = usePathname();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const [mounted, setMounted] = useState(false);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const { gradient: themeGradient } = useThemeGradient();
	const { colorTheme } = useColorTheme();

	// Handle hydration + load persisted collapsed state
	useEffect(() => {
		setMounted(true);
		setCollapsedGroups(loadCollapsedGroups());
	}, []);

	// Auto-expand the group containing the active route
	const activeGroupId = useMemo(() => findGroupForPath(pathname), [pathname]);

	useEffect(() => {
		if (activeGroupId) {
			setCollapsedGroups((prev) => {
				if (!prev.has(activeGroupId)) return prev;
				const next = new Set(prev);
				next.delete(activeGroupId);
				saveCollapsedGroups(next);
				return next;
			});
		}
	}, [activeGroupId]);

	const handleToggleGroup = useCallback((groupId: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) {
				next.delete(groupId);
			} else {
				next.add(groupId);
			}
			saveCollapsedGroups(next);
			return next;
		});
	}, []);

	// *arr Suite and qBittorrent themes use flat styling, not gradients
	// Default to false (show gradient) until mounted to avoid hydration issues
	const isArrTheme = mounted && colorTheme === "arr";
	const isQbittorrentTheme = mounted && colorTheme === "qbittorrent";
	const useFlatStyling = isArrTheme || isQbittorrentTheme;

	if (pathname === "/login" || pathname === "/setup") {
		return null;
	}

	return (
		<>
			{/* Mobile menu button */}
			<motion.button
				onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
				className={cn(
					"lg:hidden fixed top-4 left-4 z-modal p-2.5 rounded-xl border transition-colors duration-300",
					mobileMenuOpen ? "bg-card border-border" : "bg-card/80 backdrop-blur-xl border-border/50",
				)}
				style={
					mobileMenuOpen
						? {
								boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
							}
						: undefined
				}
				aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
				aria-expanded={mobileMenuOpen}
				whileHover={{ scale: 1.05 }}
				whileTap={{ scale: 0.95 }}
				transition={springs.quick}
			>
				<AnimatePresence mode="wait">
					{mobileMenuOpen ? (
						<motion.div
							key="close"
							initial={{ rotate: -90, opacity: 0 }}
							animate={{ rotate: 0, opacity: 1 }}
							exit={{ rotate: 90, opacity: 0 }}
							transition={springs.quick}
						>
							<X className="h-5 w-5" style={{ color: themeGradient.from }} />
						</motion.div>
					) : (
						<motion.div
							key="menu"
							initial={{ rotate: 90, opacity: 0 }}
							animate={{ rotate: 0, opacity: 1 }}
							exit={{ rotate: -90, opacity: 0 }}
							transition={springs.quick}
						>
							<Menu className="h-5 w-5 text-foreground" />
						</motion.div>
					)}
				</AnimatePresence>
			</motion.button>

			{/* Mobile menu overlay */}
			<AnimatePresence>
				{mobileMenuOpen && (
					<motion.div
						className="lg:hidden fixed inset-0 bg-black/60 backdrop-blur-xs z-modal-backdrop"
						onClick={() => setMobileMenuOpen(false)}
						aria-hidden="true"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.2 }}
					/>
				)}
			</AnimatePresence>

			{/* Mobile sidebar */}
			<AnimatePresence>
				{mobileMenuOpen && (
					<motion.aside
						data-sidebar
						className="lg:hidden fixed inset-y-0 left-0 z-modal-backdrop w-72 flex flex-col border-r border-border/30 bg-background/95 backdrop-blur-xl p-6"
						initial={{ x: "-100%" }}
						animate={{ x: 0 }}
						exit={{ x: "-100%" }}
						transition={springs.snappy}
					>
						{/* Decorative gradient orb */}
						<div
							className="absolute top-0 left-0 w-64 h-64 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2 pointer-events-none"
							style={{
								background: `radial-gradient(circle, ${themeGradient.glow} 0%, transparent 70%)`,
								opacity: 0.3,
							}}
						/>

						<NavContent
							useFlatStyling={useFlatStyling}
							themeGradient={themeGradient}
							pathname={pathname}
							collapsedGroups={collapsedGroups}
							onToggleGroup={handleToggleGroup}
							setMobileMenuOpen={setMobileMenuOpen}
						/>
					</motion.aside>
				)}
			</AnimatePresence>

			{/* Desktop sidebar */}
			<aside
				data-sidebar
				className="hidden w-64 shrink-0 flex-col border-r border-border/30 bg-background/50 backdrop-blur-xl p-6 lg:flex relative overflow-hidden"
			>
				{/* Decorative gradient orb */}
				<div
					className="absolute top-0 left-0 w-64 h-64 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2 pointer-events-none"
					style={{
						background: `radial-gradient(circle, ${themeGradient.glow} 0%, transparent 70%)`,
						opacity: 0.2,
					}}
				/>

				<NavContent
					useFlatStyling={useFlatStyling}
					themeGradient={themeGradient}
					pathname={pathname}
					collapsedGroups={collapsedGroups}
					onToggleGroup={handleToggleGroup}
					setMobileMenuOpen={setMobileMenuOpen}
				/>
			</aside>
		</>
	);
};
