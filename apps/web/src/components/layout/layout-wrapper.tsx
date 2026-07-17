"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { TautulliMigrationDialog } from "../../features/migrations/components/tautulli-migration-dialog";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import { useColorTheme } from "../../providers/color-theme-provider";
import { CommandPalette, useCommandPalette } from "./command-palette";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";

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
		<div className="relative flex min-h-screen bg-background">
			{/* 3.0 one-shot migration gate — blocks until lingering Tautulli
			    instances are acknowledged and removed (ADR-0007) */}
			<TautulliMigrationDialog />

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
			<div className="relative z-10 flex min-w-0 flex-1 flex-col">
				<TopBar onOpenCommandPalette={() => setCommandPaletteOpen(true)} />
				<div className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
			</div>
		</div>
	);
};
