"use client";

import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { CommandPalette, useCommandPalette } from "./command-palette";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import { useColorTheme } from "../../providers/color-theme-provider";

const ROUTES_WITHOUT_LAYOUT = new Set(["/login", "/setup"]);

interface LayoutWrapperProps {
	readonly children: React.ReactNode;
}

export const LayoutWrapper = ({ children }: LayoutWrapperProps) => {
	const pathname = usePathname();
	const { gradient: themeGradient } = useThemeGradient();
	const { open: commandPaletteOpen, setOpen: setCommandPaletteOpen } = useCommandPalette();
	const { colorTheme } = useColorTheme();
	const [mounted, setMounted] = useState(false);
	const showLayout = !ROUTES_WITHOUT_LAYOUT.has(pathname);

	// Handle hydration - only check theme after mount to avoid SSR mismatch
	useEffect(() => {
		setMounted(true);
	}, []);

	// *arr Suite theme uses flat Sonarr-style design, no gradient backgrounds
	// Default to false (show gradient) until mounted to avoid hydration issues
	const isArrTheme = mounted && colorTheme === "arr";

	if (!showLayout) {
		return <>{children}</>;
	}

	return (
		<div className="flex min-h-screen bg-background relative">
			{/* Command Palette - Cmd+K */}
			<CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />

			{/* Premium gradient mesh background - skip for *arr theme (flat design) */}
			{!isArrTheme && (
				<div
					className="fixed inset-0 pointer-events-none opacity-40"
					style={{ background: "var(--gradient-mesh)" }}
				/>
			)}

			{/* Ambient background glow - theme-aware, skip for *arr theme (flat design) */}
			{!isArrTheme && (
				<div
					className="pointer-events-none fixed inset-0 opacity-20 blur-3xl transition-all duration-1000"
					style={{
						background: `radial-gradient(ellipse at 30% 20%, ${themeGradient.glow} 0%, transparent 50%)`,
					}}
				/>
			)}

			<Sidebar />
			<div className="flex flex-1 flex-col relative z-10 min-w-0">
				<TopBar />
				<div className="flex-1 p-6 min-w-0">{children}</div>
			</div>
		</div>
	);
};
