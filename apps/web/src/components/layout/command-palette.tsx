"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
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
	Sun,
	Moon,
	Monitor,
	Smartphone,
	Palette,
	LogOut,
	User,
	RefreshCw,
	FileText,
	Zap,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import { useOLEDMode } from "../../hooks/useOLEDMode";
import { useColorTheme, type ColorTheme } from "../../providers/color-theme-provider";
import { cn } from "../../lib/utils";
import { logout } from "../../lib/api-client/auth";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Navigation items matching sidebar
 */
const NAV_ITEMS = [
	{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, keywords: ["home", "overview", "queue"] },
	{ href: "/discover", label: "Discover", icon: Compass, keywords: ["tmdb", "trending", "popular", "movies", "shows"] },
	{ href: "/library", label: "Library", icon: Library, keywords: ["movies", "series", "collection"] },
	{ href: "/search", label: "Search", icon: Search, keywords: ["find", "prowlarr", "indexers"] },
	{ href: "/indexers", label: "Indexers", icon: Globe, keywords: ["prowlarr", "torrent", "usenet"] },
	{ href: "/calendar", label: "Calendar", icon: Calendar, keywords: ["upcoming", "releases", "schedule"] },
	{ href: "/statistics", label: "Statistics", icon: BarChart3, keywords: ["stats", "analytics", "graphs"] },
	{ href: "/hunting", label: "Hunting", icon: Target, keywords: ["missing", "upgrade", "auto"] },
	{ href: "/history", label: "History", icon: History, keywords: ["downloads", "log", "activity"] },
	{ href: "/trash-guides", label: "TRaSH Guides", icon: Sparkles, keywords: ["quality", "profiles", "custom formats"] },
	{ href: "/settings", label: "Settings", icon: Settings, keywords: ["config", "preferences", "account"] },
];

/**
 * Theme color options with actual hex values for previews
 * (CSS variables can't be used for gradient preview swatches)
 */
const THEME_COLOR_OPTIONS: Array<{ name: ColorTheme; label: string; from: string; to: string }> = [
	{ name: "blue", label: "Blue Ocean", from: "#3b82f6", to: "#8b5cf6" },
	{ name: "purple", label: "Purple Haze", from: "#8b5cf6", to: "#ec4899" },
	{ name: "green", label: "Emerald", from: "#22c55e", to: "#14b8a6" },
	{ name: "orange", label: "Sunset", from: "#f97316", to: "#eab308" },
	{ name: "rose", label: "Rose", from: "#f43f5e", to: "#ec4899" },
	{ name: "slate", label: "Slate", from: "#64748b", to: "#475569" },
	{ name: "winamp", label: "Winamp", from: "#00ff00", to: "#39ff14" },
	{ name: "terminal", label: "Terminal", from: "#20c20e", to: "#00ff41" },
	{ name: "vaporwave", label: "Vaporwave", from: "#ff6ec7", to: "#00ffff" },
	{ name: "cyber", label: "Cyberpunk", from: "#00d4ff", to: "#ff00ff" },
];

interface CommandPaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Premium Command Palette
 *
 * A keyboard-first command palette for power users featuring:
 * - Navigation to all pages
 * - Theme switching (light/dark + color themes)
 * - Quick actions (refresh, logout)
 * - Glassmorphic design matching app aesthetic
 *
 * Trigger: Cmd+K (Mac) / Ctrl+K (Windows/Linux)
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { theme, setTheme, resolvedTheme } = useTheme();
	const { gradient: themeGradient } = useThemeGradient();
	const isDarkMode = resolvedTheme === "dark";
	const { colorTheme, setColorTheme } = useColorTheme();
	const { isOLED, toggleOLED } = useOLEDMode();
	const [search, setSearch] = useState("");

	// Reset search when closing
	useEffect(() => {
		if (!open) {
			setSearch("");
		}
	}, [open]);

	const runCommand = useCallback(
		(command: () => void) => {
			onOpenChange(false);
			command();
		},
		[onOpenChange]
	);

	const handleLogout = useCallback(async () => {
		try {
			await logout();
			queryClient.clear();
			router.push("/login");
		} catch {
			// Still redirect on error
			router.push("/login");
		}
	}, [queryClient, router]);

	const handleRefreshData = useCallback(() => {
		queryClient.invalidateQueries();
	}, [queryClient]);

	// Don't render on server or when closed
	if (!open || typeof document === "undefined") return null;

	// Use portal to render at document.body level, escaping all stacking contexts
	return createPortal(
		<div
			className="fixed inset-0 flex items-start justify-center pt-[20vh] animate-in fade-in duration-150"
			style={{ zIndex: 9999 }}
			onClick={() => onOpenChange(false)}
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

			{/* Command Dialog */}
			<Command
				className={cn(
					"relative w-full max-w-2xl overflow-hidden rounded-2xl border border-border/50",
					"bg-card/95 backdrop-blur-xl shadow-2xl",
					"animate-in zoom-in-95 slide-in-from-top-4 duration-200"
				)}
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${themeGradient.from}15`,
				}}
				onClick={(e) => e.stopPropagation()}
				loop
			>
				{/* Search Input */}
				<div
					className="flex items-center gap-3 border-b border-border/50 px-4"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}05, transparent)`,
					}}
				>
					<Search className="h-5 w-5 text-muted-foreground" />
					<Command.Input
						value={search}
						onValueChange={setSearch}
						placeholder="Type a command or search..."
						className={cn(
							"flex h-14 w-full bg-transparent py-4 text-base outline-none",
							"placeholder:text-muted-foreground"
						)}
						autoFocus
					/>
					<kbd
						className="hidden sm:inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
					>
						ESC
					</kbd>
				</div>

				{/* Command List */}
				<Command.List className="max-h-[60vh] overflow-y-auto p-2">
					<Command.Empty className="py-8 text-center text-sm text-muted-foreground">
						No results found.
					</Command.Empty>

					{/* Navigation */}
					<Command.Group
						heading={
							<span className="px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Navigation
							</span>
						}
						className="mb-2"
					>
						{NAV_ITEMS.map((item) => {
							const Icon = item.icon;
							return (
								<Command.Item
									key={item.href}
									value={`${item.label} ${item.keywords.join(" ")}`}
									onSelect={() => runCommand(() => router.push(item.href))}
									className={cn(
										"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
										"aria-selected:bg-muted/50"
									)}
								>
									<div
										className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
										style={{
											background: `${themeGradient.from}15`,
										}}
									>
										<Icon className="h-4 w-4" style={{ color: themeGradient.from }} />
									</div>
									<span className="flex-1 text-foreground">{item.label}</span>
									<span className="text-xs text-muted-foreground opacity-0 transition-opacity group-aria-selected:opacity-100">
										Go to {item.label.toLowerCase()}
									</span>
								</Command.Item>
							);
						})}
					</Command.Group>

					{/* Theme Mode */}
					<Command.Group
						heading={
							<span className="px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Appearance
							</span>
						}
						className="mb-2"
					>
						<Command.Item
							value="light mode theme"
							onSelect={() => runCommand(() => setTheme("light"))}
							className={cn(
								"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
								"aria-selected:bg-muted/50"
							)}
						>
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{ background: `${themeGradient.from}15` }}
							>
								<Sun className="h-4 w-4" style={{ color: themeGradient.from }} />
							</div>
							<span className="flex-1 text-foreground">Light Mode</span>
							{theme === "light" && (
								<span className="text-xs" style={{ color: themeGradient.from }}>
									Active
								</span>
							)}
						</Command.Item>

						<Command.Item
							value="dark mode theme"
							onSelect={() => runCommand(() => setTheme("dark"))}
							className={cn(
								"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
								"aria-selected:bg-muted/50"
							)}
						>
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{ background: `${themeGradient.from}15` }}
							>
								<Moon className="h-4 w-4" style={{ color: themeGradient.from }} />
							</div>
							<span className="flex-1 text-foreground">Dark Mode</span>
							{theme === "dark" && (
								<span className="text-xs" style={{ color: themeGradient.from }}>
									Active
								</span>
							)}
						</Command.Item>

						<Command.Item
							value="system mode theme auto"
							onSelect={() => runCommand(() => setTheme("system"))}
							className={cn(
								"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
								"aria-selected:bg-muted/50"
							)}
						>
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{ background: `${themeGradient.from}15` }}
							>
								<Monitor className="h-4 w-4" style={{ color: themeGradient.from }} />
							</div>
							<span className="flex-1 text-foreground">System Theme</span>
							{theme === "system" && (
								<span className="text-xs" style={{ color: themeGradient.from }}>
									Active
								</span>
							)}
						</Command.Item>

						<Command.Item
							value="oled dark black amoled pure"
							onSelect={() => isDarkMode && runCommand(toggleOLED)}
							className={cn(
								"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
								"aria-selected:bg-muted/50",
								!isDarkMode && "opacity-50"
							)}
						>
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{ background: isOLED && isDarkMode ? themeGradient.from : `${themeGradient.from}15` }}
							>
								<Smartphone className="h-4 w-4" style={{ color: isOLED && isDarkMode ? "#fff" : themeGradient.from }} />
							</div>
							<span className="flex-1 text-foreground">OLED Mode (Pure Black)</span>
							<span className="text-xs text-muted-foreground">
								{!isDarkMode
									? "Requires dark mode"
									: isOLED
										? "On"
										: "Off"}
							</span>
						</Command.Item>
					</Command.Group>

					{/* Color Themes */}
					<Command.Group
						heading={
							<span className="px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Color Theme
							</span>
						}
						className="mb-2"
					>
						{THEME_COLOR_OPTIONS.map((option) => (
							<Command.Item
								key={option.name}
								value={`theme color ${option.label} ${option.name}`}
								onSelect={() => runCommand(() => setColorTheme(option.name))}
								className={cn(
									"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
									"aria-selected:bg-muted/50"
								)}
							>
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${option.from}, ${option.to})`,
									}}
								>
									<Palette className="h-4 w-4 text-white" />
								</div>
								<span className="flex-1 text-foreground">{option.label}</span>
								{colorTheme === option.name && (
									<span className="text-xs" style={{ color: themeGradient.from }}>
										Active
									</span>
								)}
							</Command.Item>
						))}
					</Command.Group>

					{/* Actions */}
					<Command.Group
						heading={
							<span className="px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Actions
							</span>
						}
					>
						<Command.Item
							value="refresh data reload"
							onSelect={() => runCommand(handleRefreshData)}
							className={cn(
								"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
								"aria-selected:bg-muted/50"
							)}
						>
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{ background: `${themeGradient.from}15` }}
							>
								<RefreshCw className="h-4 w-4" style={{ color: themeGradient.from }} />
							</div>
							<span className="flex-1 text-foreground">Refresh All Data</span>
						</Command.Item>

						<Command.Item
							value="account profile user"
							onSelect={() => runCommand(() => router.push("/settings"))}
							className={cn(
								"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
								"aria-selected:bg-muted/50"
							)}
						>
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{ background: `${themeGradient.from}15` }}
							>
								<User className="h-4 w-4" style={{ color: themeGradient.from }} />
							</div>
							<span className="flex-1 text-foreground">Account Settings</span>
						</Command.Item>

						<Command.Item
							value="documentation help docs"
							onSelect={() =>
								runCommand(() => window.open("https://github.com/khak1s/arr-dashboard", "_blank"))
							}
							className={cn(
								"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
								"aria-selected:bg-muted/50"
							)}
						>
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{ background: `${themeGradient.from}15` }}
							>
								<FileText className="h-4 w-4" style={{ color: themeGradient.from }} />
							</div>
							<span className="flex-1 text-foreground">Documentation</span>
						</Command.Item>

						<Command.Item
							value="logout sign out"
							onSelect={() => runCommand(handleLogout)}
							className={cn(
								"group relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors",
								"aria-selected:bg-muted/50"
							)}
						>
							<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/15">
								<LogOut className="h-4 w-4 text-red-500" />
							</div>
							<span className="flex-1 text-foreground">Log Out</span>
						</Command.Item>
					</Command.Group>
				</Command.List>

				{/* Footer */}
				<div
					className="flex items-center justify-between border-t border-border/50 px-4 py-2"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}03, transparent)`,
					}}
				>
					<div className="flex items-center gap-4 text-xs text-muted-foreground">
						<span className="flex items-center gap-1">
							<kbd className="rounded border border-border/50 bg-muted/30 px-1.5 py-0.5">↑↓</kbd>
							Navigate
						</span>
						<span className="flex items-center gap-1">
							<kbd className="rounded border border-border/50 bg-muted/30 px-1.5 py-0.5">↵</kbd>
							Select
						</span>
						<span className="flex items-center gap-1">
							<kbd className="rounded border border-border/50 bg-muted/30 px-1.5 py-0.5">ESC</kbd>
							Close
						</span>
					</div>
					<div className="flex items-center gap-1 text-xs text-muted-foreground">
						<Zap className="h-3 w-3" style={{ color: themeGradient.from }} />
						<span>Command Palette</span>
					</div>
				</div>
			</Command>
		</div>,
		document.body
	);
}

/**
 * Global keyboard shortcut handler for Command Palette
 * Use this hook in the layout to listen for Cmd+K / Ctrl+K
 */
export function useCommandPalette() {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Cmd+K (Mac) or Ctrl+K (Windows/Linux)
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				setOpen((prev) => !prev);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, []);

	return { open, setOpen };
}
