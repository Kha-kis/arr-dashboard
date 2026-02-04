"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { cn } from "../../lib/utils";
import { useState, useEffect } from "react";
import {
	Menu,
	X,
	LayoutDashboard,
	Compass,
	Library,
	Search,
	Globe,
	Calendar,
	BarChart3,
	Target,
	Trash2,
	History,
	Sparkles,
	Settings,
	ChevronRight,
} from "lucide-react";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import { useColorTheme } from "../../providers/color-theme-provider";
import { springs } from "../motion";

const NAV_ITEMS = [
	{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
	{ href: "/discover", label: "Discover", icon: Compass },
	{ href: "/library", label: "Library", icon: Library },
	{ href: "/search", label: "Search", icon: Search },
	{ href: "/indexers", label: "Indexers", icon: Globe },
	{ href: "/calendar", label: "Calendar", icon: Calendar },
	{ href: "/statistics", label: "Statistics", icon: BarChart3 },
	{ href: "/hunting", label: "Hunting", icon: Target },
	{ href: "/queue-cleaner", label: "Queue Cleaner", icon: Trash2 },
	{ href: "/history", label: "History", icon: History },
	{ href: "/trash-guides", label: "TRaSH Guides", icon: Sparkles },
	{ href: "/settings", label: "Settings", icon: Settings },
];

export const Sidebar = () => {
	const pathname = usePathname();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const [mounted, setMounted] = useState(false);
	const { gradient: themeGradient } = useThemeGradient();
	const { colorTheme } = useColorTheme();

	// Handle hydration - only check theme after mount to avoid SSR mismatch
	useEffect(() => {
		setMounted(true);
	}, []);

	// *arr Suite and qBittorrent themes use flat styling, not gradients
	// Default to false (show gradient) until mounted to avoid hydration issues
	const isArrTheme = mounted && colorTheme === "arr";
	const isQbittorrentTheme = mounted && colorTheme === "qbittorrent";
	const useFlatStyling = isArrTheme || isQbittorrentTheme;

	if (pathname === "/login" || pathname === "/setup") {
		return null;
	}

	const NavContent = () => (
		<>
			{/* Logo/Brand */}
			<div className="mb-8 relative z-10">
				<div className="flex items-center gap-3">
					<div
						className={cn(
							"flex items-center justify-center",
							useFlatStyling ? "h-5 w-5" : "h-10 w-10 rounded-xl"
						)}
						style={useFlatStyling ? {
							background: themeGradient.from,
						} : {
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 8px 24px -8px ${themeGradient.glow}`,
						}}
					>
						<LayoutDashboard className={useFlatStyling ? "h-4 w-4 text-white" : "h-5 w-5 text-white"} />
					</div>
					<div>
						<h1
							className={cn(
								"font-bold tracking-tight",
								useFlatStyling ? "text-sm text-foreground" : "text-lg"
							)}
							style={useFlatStyling ? undefined : {
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								WebkitBackgroundClip: "text",
								WebkitTextFillColor: "transparent",
								backgroundClip: "text",
							}}
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
			<nav className="flex flex-col gap-1.5 relative z-10">
				{NAV_ITEMS.map((item) => {
					const Icon = item.icon;
					const isActive = pathname === item.href;

					return (
						<Link
							key={item.href}
							href={item.href}
							onClick={() => setMobileMenuOpen(false)}
							aria-current={isActive ? "page" : undefined}
							className={cn(
								"group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-200",
								isActive && !useFlatStyling && "text-white",
								// *arr/qBittorrent themes: CSS handles styling via [aria-current="page"]
								useFlatStyling && "rounded-none",
								!isActive && "text-muted-foreground hover:text-foreground"
							)}
						>
							{/* Active background with gradient - uses layoutId for sliding animation */}
							{/* Skip gradient for flat themes - CSS handles indicator */}
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

							{/* Hover glow effect for inactive items - skip for flat themes */}
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
									!isActive && "group-hover:scale-110"
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
										"opacity-0 -translate-x-2 group-hover:opacity-50 group-hover:translate-x-0"
									)}
									style={{ color: themeGradient.from }}
								/>
							)}
						</Link>
					);
				})}
			</nav>
			</LayoutGroup>

			{/* Bottom decorative element */}
			<div className="mt-auto pt-6 relative z-10">
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

	return (
		<>
			{/* Mobile menu button */}
			<motion.button
				onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
				className={cn(
					"lg:hidden fixed top-4 left-4 z-modal p-2.5 rounded-xl border transition-colors duration-300",
					mobileMenuOpen
						? "bg-card border-border"
						: "bg-card/80 backdrop-blur-xl border-border/50"
				)}
				style={mobileMenuOpen ? {
					boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
				} : undefined}
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

					<NavContent />
					</motion.aside>
				)}
			</AnimatePresence>

			{/* Desktop sidebar */}
			<aside data-sidebar className="hidden w-64 shrink-0 flex-col border-r border-border/30 bg-background/50 backdrop-blur-xl p-6 lg:flex relative">
				{/* Decorative gradient orb */}
				<div
					className="absolute top-0 left-0 w-64 h-64 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2 pointer-events-none"
					style={{
						background: `radial-gradient(circle, ${themeGradient.glow} 0%, transparent 70%)`,
						opacity: 0.2,
					}}
				/>

				<NavContent />
			</aside>
		</>
	);
};
