/**
 * Live Theme Preview
 *
 * Mini dashboard preview that responds to theme changes in real-time.
 * Extracted from appearance-tab.tsx for maintainability.
 */

import { Bell, Play, Calendar, TrendingUp } from "lucide-react";
import { THEME_INFO, type ColorTheme } from "../../../providers/color-theme-provider";
import type { ThemeGradient } from "../../../lib/theme-gradients";

interface PreviewColors {
	background: string;
	sidebar: string;
	sidebarBorder: string;
	card: string;
	cardHover: string;
	border: string;
	textMuted: string;
	text: string;
}

/**
 * Computes preview colors based on the active color theme and dark/light mode.
 *
 * Premium themes (arr, qbittorrent) have bespoke palettes that match
 * the real applications they emulate.
 */
export function getPreviewColors(colorTheme: ColorTheme, isDark: boolean): PreviewColors {
	if (colorTheme === "arr") {
		if (isDark) {
			return {
				background: "#202020",
				sidebar: "#2a2a2a",
				sidebarBorder: "#333333",
				card: "transparent",
				cardHover: "rgba(255,255,255,0.05)",
				border: "#454545",
				textMuted: "#858585",
				text: "#e1e2e3",
			};
		}
		return {
			background: "#f5f7fa",
			sidebar: "#3a3f51",
			sidebarBorder: "#252833",
			card: "transparent",
			cardHover: "rgba(0,0,0,0.03)",
			border: "#dde6e9",
			textMuted: "#909293",
			text: "#515253",
		};
	}
	if (colorTheme === "qbittorrent") {
		if (isDark) {
			return {
				background: "#1e1e1e",
				sidebar: "#252525",
				sidebarBorder: "#3a3a3a",
				card: "#2d2d2d",
				cardHover: "#353535",
				border: "#404040",
				textMuted: "#808080",
				text: "#e0e0e0",
			};
		}
		return {
			background: "#f8f8f8",
			sidebar: "#2d2d2d",
			sidebarBorder: "#404040",
			card: "#ffffff",
			cardHover: "#f0f0f0",
			border: "#d0d0d0",
			textMuted: "#707070",
			text: "#333333",
		};
	}
	return isDark ? {
		background: "#18181b",
		sidebar: "rgba(24, 24, 27, 0.8)",
		sidebarBorder: "#27272a",
		card: "rgba(39, 39, 42, 0.5)",
		cardHover: "rgba(39, 39, 42, 0.3)",
		border: "#27272a",
		textMuted: "#71717a",
		text: "#a1a1aa",
	} : {
		background: "#ffffff",
		sidebar: "#fafafa",
		sidebarBorder: "#e4e4e7",
		card: "#f4f4f5",
		cardHover: "#fafafa",
		border: "#e4e4e7",
		textMuted: "#a1a1aa",
		text: "#71717a",
	};
}

interface LivePreviewProps {
	activeGradient: ThemeGradient;
	previewColors: PreviewColors;
	isTransitioning: boolean;
	theme: string | undefined;
	colorTheme: ColorTheme;
}

export const LivePreview = ({
	activeGradient,
	previewColors,
	isTransitioning,
	theme,
	colorTheme,
}: LivePreviewProps) => (
	<div className="sticky top-6">
		<div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-xs p-6">
			<h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
				<span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
				Live Preview
			</h3>

			{/* Mini Dashboard Preview */}
			<div
				className="relative overflow-hidden rounded-xl border transition-all duration-500"
				style={{
					backgroundColor: previewColors.background,
					borderColor: previewColors.border,
					boxShadow: `0 20px 40px -12px ${activeGradient.glow}`,
				}}
			>
				{/* Mini sidebar */}
				<div
					className="absolute left-0 top-0 bottom-0 w-12 border-r transition-colors duration-500"
					style={{
						backgroundColor: previewColors.sidebar,
						borderColor: previewColors.sidebarBorder,
					}}
				>
					<div className="flex flex-col items-center gap-3 p-2 pt-4">
						<div
							className="h-6 w-6 rounded-lg"
							style={{
								background: `linear-gradient(135deg, ${activeGradient.from}, ${activeGradient.to})`,
							}}
						/>
						<div className="h-5 w-5 rounded" style={{ backgroundColor: previewColors.card }} />
						<div className="h-5 w-5 rounded" style={{ backgroundColor: previewColors.card }} />
						<div className="h-5 w-5 rounded" style={{ backgroundColor: previewColors.card }} />
					</div>
				</div>

				{/* Main content area */}
				<div className="pl-12">
					{/* Header */}
					<div
						className="flex items-center justify-between border-b px-4 py-3 transition-colors duration-500"
						style={{ borderColor: previewColors.border }}
					>
						<div className="h-3 w-20 rounded" style={{ backgroundColor: previewColors.card }} />
						<div className="flex gap-2">
							<Bell className="h-4 w-4" style={{ color: previewColors.textMuted }} />
						</div>
					</div>

					{/* Content */}
					<div className="p-4 space-y-4">
						{/* Stats row */}
						<div className="grid grid-cols-3 gap-2">
							{[Play, Calendar, TrendingUp].map((Icon, i) => (
								<div
									key={i}
									className="rounded-lg p-3 transition-colors duration-500"
									style={{ backgroundColor: previewColors.card }}
								>
									<Icon
										className="h-4 w-4 mb-2"
										style={{ color: activeGradient.from }}
									/>
									<div
										className="h-2 w-8 rounded mb-1"
										style={{ backgroundColor: previewColors.cardHover }}
									/>
									<div
										className="h-1.5 w-12 rounded"
										style={{ backgroundColor: `${previewColors.cardHover}80` }}
									/>
								</div>
							))}
						</div>

						{/* List items */}
						<div className="space-y-2">
							{[0, 1, 2].map((i) => (
								<div
									key={i}
									className="flex items-center gap-3 rounded-lg p-2 transition-colors duration-500"
									style={{ backgroundColor: previewColors.cardHover }}
								>
									<div
										className="h-8 w-8 rounded-md shrink-0"
										style={{
											background: i === 0
												? `linear-gradient(135deg, ${activeGradient.from}40, ${activeGradient.to}40)`
												: previewColors.card,
										}}
									/>
									<div className="flex-1 space-y-1">
										<div
											className="h-2 rounded"
											style={{ backgroundColor: previewColors.card, width: `${70 - i * 15}%` }}
										/>
										<div
											className="h-1.5 w-16 rounded"
											style={{ backgroundColor: `${previewColors.card}80` }}
										/>
									</div>
									{i === 0 && (
										<div
											className="h-5 w-12 rounded-full text-[8px] font-medium flex items-center justify-center text-white"
											style={{
												background: `linear-gradient(135deg, ${activeGradient.from}, ${activeGradient.to})`,
											}}
										>
											Active
										</div>
									)}
								</div>
							))}
						</div>

						{/* Button preview */}
						<div className="flex gap-2 pt-2">
							<button
								type="button"
								className="flex-1 rounded-lg px-3 py-2 text-[10px] font-medium text-white transition-all duration-300 hover:opacity-90"
								style={{
									background: `linear-gradient(135deg, ${activeGradient.from}, ${activeGradient.to})`,
									boxShadow: `0 4px 12px -2px ${activeGradient.glow}`,
								}}
							>
								Primary Action
							</button>
							<button
								type="button"
								className="rounded-lg px-3 py-2 text-[10px] font-medium transition-all duration-300 hover:opacity-80"
								style={{
									backgroundColor: previewColors.card,
									color: previewColors.text,
								}}
							>
								Secondary
							</button>
						</div>
					</div>
				</div>

				{/* Transition overlay */}
				{isTransitioning && (
					<div
						className="absolute inset-0 animate-in fade-in duration-200"
						style={{
							background: `radial-gradient(circle at center, ${activeGradient.glow} 0%, transparent 70%)`,
						}}
					/>
				)}
			</div>

			{/* Current theme indicator */}
			<div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
				<span>
					{theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"} mode
				</span>
				<span className="flex items-center gap-1.5">
					<span
						className="h-2 w-2 rounded-full"
						style={{ backgroundColor: activeGradient.from }}
					/>
					{THEME_INFO[colorTheme].label} theme
				</span>
			</div>
		</div>
	</div>
);
