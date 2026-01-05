"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "../../lib/utils";
import { useState } from "react";
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
	History,
	Sparkles,
	Settings,
	ChevronRight,
} from "lucide-react";
import { THEME_GRADIENTS } from "../../lib/theme-gradients";
import { useColorTheme } from "../../providers/color-theme-provider";

const NAV_ITEMS = [
	{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
	{ href: "/discover", label: "Discover", icon: Compass },
	{ href: "/library", label: "Library", icon: Library },
	{ href: "/search", label: "Search", icon: Search },
	{ href: "/indexers", label: "Indexers", icon: Globe },
	{ href: "/calendar", label: "Calendar", icon: Calendar },
	{ href: "/statistics", label: "Statistics", icon: BarChart3 },
	{ href: "/hunting", label: "Hunting", icon: Target },
	{ href: "/history", label: "History", icon: History },
	{ href: "/trash-guides", label: "TRaSH Guides", icon: Sparkles },
	{ href: "/settings", label: "Settings", icon: Settings },
];

export const Sidebar = () => {
	const pathname = usePathname();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	if (pathname === "/login" || pathname === "/setup") {
		return null;
	}

	const NavContent = () => (
		<>
			{/* Logo/Brand */}
			<div className="mb-8 relative z-10">
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 8px 24px -8px ${themeGradient.glow}`,
						}}
					>
						<LayoutDashboard className="h-5 w-5 text-white" />
					</div>
					<div>
						<h1
							className="text-lg font-bold tracking-tight"
							style={{
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
			<nav className="flex flex-col gap-1.5 relative z-10">
				{NAV_ITEMS.map((item) => {
					const Icon = item.icon;
					const isActive = pathname === item.href;

					return (
						<Link
							key={item.href}
							href={item.href}
							onClick={() => setMobileMenuOpen(false)}
							className={cn(
								"group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-300",
								isActive
									? "text-white"
									: "text-muted-foreground hover:text-foreground"
							)}
						>
							{/* Active background with gradient */}
							{isActive && (
								<div
									className="absolute inset-0 rounded-xl"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
										boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
									}}
								/>
							)}

							{/* Hover glow effect for inactive items */}
							{!isActive && (
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
									isActive && "drop-shadow-sm",
									!isActive && "group-hover:scale-110"
								)}
								style={!isActive ? { color: themeGradient.from } : undefined}
							/>

							{/* Label */}
							<span className="relative z-10 flex-1">{item.label}</span>

							{/* Active indicator arrow */}
							{isActive && (
								<ChevronRight className="relative z-10 h-4 w-4 text-white/70" />
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
			<button
				onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
				className={cn(
					"lg:hidden fixed top-4 left-4 z-50 p-2.5 rounded-xl border transition-all duration-300",
					mobileMenuOpen
						? "bg-card border-border"
						: "bg-card/80 backdrop-blur-xl border-border/50"
				)}
				style={mobileMenuOpen ? {
					boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
				} : undefined}
				aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
				aria-expanded={mobileMenuOpen}
			>
				{mobileMenuOpen ? (
					<X className="h-5 w-5" style={{ color: themeGradient.from }} />
				) : (
					<Menu className="h-5 w-5 text-foreground" />
				)}
			</button>

			{/* Mobile menu overlay */}
			{mobileMenuOpen && (
				<div
					className="lg:hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-40 animate-in fade-in duration-200"
					onClick={() => setMobileMenuOpen(false)}
					aria-hidden="true"
				/>
			)}

			{/* Mobile sidebar */}
			<aside
				className={cn(
					"lg:hidden fixed inset-y-0 left-0 z-40 w-72 flex flex-col border-r border-border/30 bg-background/95 backdrop-blur-xl p-6 transition-transform duration-300",
					mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
				)}
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
			</aside>

			{/* Desktop sidebar */}
			<aside className="hidden w-64 flex-shrink-0 flex-col border-r border-border/30 bg-background/50 backdrop-blur-xl p-6 lg:flex relative">
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
