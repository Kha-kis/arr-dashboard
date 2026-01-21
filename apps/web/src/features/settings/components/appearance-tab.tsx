"use client";

import { useTheme } from "next-themes";
import { useColorTheme, STANDARD_THEMES, IMMERSIVE_THEMES, THEME_INFO, isImmersiveTheme, isPremiumUnlocked, isPremiumTheme, PREMIUM_THEME_IDS, type ColorTheme, type PremiumThemeId } from "../../../providers/color-theme-provider";
import { THEME_GRADIENT_VALUES } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useOLEDMode } from "../../../hooks/useOLEDMode";
import { cn } from "../../../lib/utils";
import { useEffect, useState, useRef } from "react";
import { Sun, Moon, Monitor, Sparkles, Play, Bell, Calendar, TrendingUp, Smartphone, Zap, Lock, Crown } from "lucide-react";

/**
 * Premium Appearance Tab
 *
 * A refined, luxury-tech aesthetic with:
 * - Interactive color orbs with glow effects
 * - Dramatic day/night toggle
 * - Live mini-dashboard preview
 * - Orchestrated animations
 */

export function AppearanceTab() {
	const { theme, setTheme, resolvedTheme } = useTheme();
	const { colorTheme, setColorTheme } = useColorTheme();
	const { gradient: activeGradient } = useThemeGradient();
	const { isOLED, toggleOLED } = useOLEDMode();
	const [mounted, setMounted] = useState(false);
	const [hoveredTheme, setHoveredTheme] = useState<ColorTheme | null>(null);
	const [isTransitioning, setIsTransitioning] = useState(false);
	const [premiumUnlocked, setPremiumUnlocked] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setMounted(true);
		// Check premium unlock status on mount
		setPremiumUnlocked(isPremiumUnlocked());
	}, []);

	const handleThemeChange = (newTheme: ColorTheme) => {
		if (newTheme === colorTheme) return;
		setIsTransitioning(true);
		setColorTheme(newTheme);
		setTimeout(() => setIsTransitioning(false), 500);
	};

	if (!mounted) {
		return (
			<div className="relative min-h-[600px]">
				<div className="absolute inset-0 flex items-center justify-center">
					<div className="h-16 w-16 rounded-full bg-linear-to-br from-primary/20 to-primary/5 animate-pulse" />
				</div>
			</div>
		);
	}

	const isDark = resolvedTheme === "dark";
	const isImmersive = isImmersiveTheme(colorTheme);
	const isPremium = isPremiumTheme(colorTheme);

	// Theme-specific preview colors for premium themes
	const getPreviewColors = () => {
		if (colorTheme === "arr") {
			// Authentic Sonarr/Radarr colors - flat design without card containers
			// Sidebar stays dark in both modes (Sonarr's hybrid design)
			if (isDark) {
				return {
					background: "#202020",        // pageBackground
					sidebar: "#2a2a2a",           // sidebarBackgroundColor
					sidebarBorder: "#333333",     // sidebarActiveBackgroundColor
					card: "transparent",          // Flat design - no card bg
					cardHover: "rgba(255,255,255,0.05)", // Subtle hover only
					border: "#454545",
					textMuted: "#858585",
					text: "#e1e2e3",
				};
			}
			// Light mode - Sonarr light theme with dark sidebar
			return {
				background: "#f5f7fa",        // pageBackground (light)
				sidebar: "#3a3f51",           // Sidebar stays dark in light mode
				sidebarBorder: "#252833",     // sidebarActiveBackgroundColor
				card: "transparent",          // Flat design - no card bg
				cardHover: "rgba(0,0,0,0.03)", // Subtle hover only
				border: "#dde6e9",
				textMuted: "#909293",         // helpTextColor
				text: "#515253",
			};
		}
		if (colorTheme === "qbittorrent") {
			// qBittorrent colors
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
			// Light mode
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
		// Default dark/light colors
		return isDark ? {
			background: "#18181b", // zinc-900
			sidebar: "rgba(24, 24, 27, 0.8)",
			sidebarBorder: "#27272a", // zinc-800
			card: "rgba(39, 39, 42, 0.5)", // zinc-800/50
			cardHover: "rgba(39, 39, 42, 0.3)",
			border: "#27272a",
			textMuted: "#71717a", // zinc-500
			text: "#a1a1aa", // zinc-400
		} : {
			background: "#ffffff",
			sidebar: "#fafafa", // zinc-50
			sidebarBorder: "#e4e4e7", // zinc-200
			card: "#f4f4f5", // zinc-100
			cardHover: "#fafafa",
			border: "#e4e4e7",
			textMuted: "#a1a1aa",
			text: "#71717a",
		};
	};

	const previewColors = getPreviewColors();

	return (
		<div ref={containerRef} className="relative" data-appearance-settings>
			{/* Ambient background glow */}
			<div
				className="pointer-events-none absolute -inset-10 opacity-30 blur-3xl transition-all duration-1000"
				style={{
					background: `radial-gradient(ellipse at 30% 20%, ${activeGradient.glow} 0%, transparent 50%)`,
				}}
			/>

			<div className="relative space-y-8">
				{/* Header */}
				<div
					className="animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "0ms" }}
				>
					<div className="flex items-center gap-3 mb-2">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-500"
							style={{
								background: `linear-gradient(135deg, ${activeGradient.from}, ${activeGradient.to})`,
								boxShadow: `0 8px 32px -8px ${activeGradient.glow}`,
							}}
						>
							<Sparkles className="h-5 w-5 text-white" />
						</div>
						<div>
							<h2 className="text-xl font-semibold tracking-tight text-foreground">
								Appearance
							</h2>
							<p className="text-sm text-muted-foreground">
								Make it yours
							</p>
						</div>
					</div>
				</div>

				{/* Main Grid Layout */}
				<div className="grid gap-6 lg:grid-cols-[1fr_380px]">
					{/* Left Column - Controls */}
					<div className="space-y-6">
						{/* Color Scheme Toggle */}
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "100ms" }}
						>
							<div className={cn(
								"rounded-2xl border border-border/50 bg-card/50 backdrop-blur-xs p-6 transition-opacity duration-300",
								isImmersive && "opacity-60"
							)}>
								<h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
									<span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
									Color Scheme
									{isImmersive && (
										<span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground font-normal">
											<Lock className="h-3 w-3" />
											Immersive theme active
										</span>
									)}
								</h3>

								{isImmersive ? (
									<div className="flex items-center gap-3 p-4 rounded-xl bg-muted/30 border border-border/30">
										<div
											className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
											style={{
												background: `linear-gradient(135deg, ${activeGradient.from}30, ${activeGradient.to}30)`,
											}}
										>
											<Zap className="h-5 w-5" style={{ color: activeGradient.from }} />
										</div>
										<div>
											<p className="text-sm font-medium text-foreground">
												{THEME_INFO[colorTheme].label} uses its own dark aesthetic
											</p>
											<p className="text-xs text-muted-foreground">
												Light/dark mode does not apply to immersive themes
											</p>
										</div>
									</div>
								) : (
									<div className="flex items-center justify-center gap-2 p-1.5 rounded-xl bg-muted/50">
										{[
											{ value: "light", icon: Sun, label: "Light" },
											{ value: "dark", icon: Moon, label: "Dark" },
											{ value: "system", icon: Monitor, label: "Auto" },
										].map(({ value, icon: Icon, label }) => (
											<button
												key={value}
												type="button"
												onClick={() => setTheme(value)}
												className={cn(
													"relative flex-1 flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-medium transition-all duration-300",
													theme === value
														? "text-foreground"
														: "text-muted-foreground hover:text-foreground"
												)}
											>
												{theme === value && (
													<span
														className="absolute inset-0 rounded-lg bg-background shadow-sm transition-all duration-300"
														style={{
															boxShadow: theme === value
																? `0 2px 8px -2px ${activeGradient.glow}`
																: undefined,
														}}
													/>
												)}
												<span className="relative flex items-center gap-2">
													<Icon
														className={cn(
															"h-4 w-4 transition-transform duration-300",
															theme === value && value === "light" && "text-amber-500",
															theme === value && value === "dark" && "text-indigo-400",
															theme === value && "scale-110"
														)}
													/>
													{label}
												</span>
											</button>
										))}
									</div>
								)}
							</div>
						</div>

						{/* OLED Mode Toggle - Only visible for standard themes in dark mode */}
						{!isImmersive && !isPremium && (
							<div
								className="animate-in fade-in slide-in-from-bottom-4 duration-500"
								style={{ animationDelay: "150ms" }}
							>
								<div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-xs p-6">
									<h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
										<span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
										OLED Mode
									</h3>

									<div className="flex items-center justify-between">
										<div className="flex items-center gap-3">
											<div
												className="flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-300"
												style={{
													background: isOLED
														? `linear-gradient(135deg, ${activeGradient.from}, ${activeGradient.to})`
														: `${activeGradient.from}15`,
												}}
											>
												<Smartphone
													className="h-5 w-5 transition-colors duration-300"
													style={{ color: isOLED ? "#fff" : activeGradient.from }}
												/>
											</div>
											<div>
												<p className="text-sm font-medium text-foreground">Pure Black Background</p>
												<p className="text-xs text-muted-foreground">
													{isDark
														? "Ideal for OLED displays - saves battery and reduces burn-in"
														: "Enable dark mode first to use OLED mode"}
												</p>
											</div>
										</div>

										<button
											type="button"
											onClick={toggleOLED}
											disabled={!isDark}
											className={cn(
												"relative h-6 w-11 rounded-full transition-all duration-300",
												isDark
													? isOLED
														? "bg-primary"
														: "bg-muted"
													: "bg-muted/50 cursor-not-allowed"
											)}
											style={isOLED && isDark ? {
												background: `linear-gradient(135deg, ${activeGradient.from}, ${activeGradient.to})`,
											} : undefined}
										>
											<span
												className={cn(
													"absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-300",
													isOLED && isDark && "translate-x-5"
												)}
											/>
										</button>
									</div>
								</div>
							</div>
						)}

						{/* Standard Color Themes */}
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "200ms" }}
						>
							<div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-xs p-6">
								<h3 className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
									<span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
									Standard Themes
								</h3>
								<p className="text-xs text-muted-foreground mb-5">
									Adapt to your light/dark mode preference
								</p>

								<div className="grid grid-cols-3 gap-4">
									{STANDARD_THEMES.map((preset, index) => {
										const info = THEME_INFO[preset];
										const gradient = THEME_GRADIENT_VALUES[preset];
										const isSelected = colorTheme === preset;
										const isHovered = hoveredTheme === preset;

										return (
											<button
												key={preset}
												type="button"
												onClick={() => handleThemeChange(preset)}
												onMouseEnter={() => setHoveredTheme(preset)}
												onMouseLeave={() => setHoveredTheme(null)}
												className={cn(
													"group relative flex flex-col items-center gap-3 rounded-xl p-4 transition-all duration-300",
													"hover:bg-muted/30",
													isSelected && "bg-muted/50"
												)}
												style={{
													animationDelay: `${300 + index * 50}ms`,
												}}
											>
												{/* Orb */}
												<div className="relative">
													{/* Glow ring */}
													<div
														className={cn(
															"absolute -inset-2 rounded-full blur-md transition-all duration-500",
															isSelected ? "opacity-60" : "opacity-0 group-hover:opacity-30"
														)}
														style={{ backgroundColor: gradient.glow }}
													/>

													{/* Main orb */}
													<div
														className={cn(
															"relative h-14 w-14 rounded-full transition-all duration-300",
															"ring-2 ring-offset-2 ring-offset-background",
															isSelected
																? "ring-foreground/20 scale-110"
																: "ring-transparent group-hover:ring-border group-hover:scale-105"
														)}
														style={{
															background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
															boxShadow: isSelected
																? `0 8px 24px -4px ${gradient.glow}`
																: `0 4px 12px -4px ${gradient.glow}`,
														}}
													>
														{/* Inner highlight */}
														<div
															className="absolute inset-0 rounded-full opacity-50"
															style={{
																background: "linear-gradient(135deg, rgba(255,255,255,0.3) 0%, transparent 50%)",
															}}
														/>

														{/* Selection indicator */}
														{isSelected && (
															<div className="absolute inset-0 flex items-center justify-center">
																<div className="h-2 w-2 rounded-full bg-white shadow-sm animate-in zoom-in duration-300" />
															</div>
														)}
													</div>

													{/* Pulse effect on hover */}
													{(isHovered || isSelected) && (
														<div
															className={cn(
																"absolute -inset-1 rounded-full animate-ping",
																isSelected ? "opacity-20" : "opacity-10"
															)}
															style={{
																backgroundColor: gradient.from,
																animationDuration: "2s",
															}}
														/>
													)}
												</div>

												{/* Label */}
												<span
													className={cn(
														"text-xs font-medium transition-colors duration-300",
														isSelected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
													)}
												>
													{info.label}
												</span>
											</button>
										);
									})}
								</div>
							</div>
						</div>

						{/* Immersive Themes */}
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "250ms" }}
						>
							<div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-xs p-6 relative overflow-hidden">
								{/* Subtle background effect for immersive section */}
								<div className="absolute inset-0 opacity-[0.03] pointer-events-none">
									<div className="absolute inset-0" style={{
										backgroundImage: `repeating-linear-gradient(
											0deg,
											transparent,
											transparent 2px,
											currentColor 2px,
											currentColor 3px
										)`,
									}} />
								</div>

								<div className="relative">
									<h3 className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
										<span className="inline-block h-1.5 w-1.5 rounded-full" style={{
											background: "linear-gradient(135deg, #ff00ff, #00ffff)",
										}} />
										Immersive Themes
										<span className="ml-auto text-[10px] font-medium px-2 py-0.5 rounded-full bg-linear-to-r from-purple-500/20 to-cyan-500/20 text-muted-foreground border border-purple-500/20">
											<Zap className="inline h-3 w-3 mr-1 -mt-0.5" />
											Special Effects
										</span>
									</h3>
									<p className="text-xs text-muted-foreground mb-5">
										Unique visual experiences with their own dark aesthetic
									</p>

									<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
										{IMMERSIVE_THEMES.map((preset, index) => {
											const info = THEME_INFO[preset];
											const gradient = THEME_GRADIENT_VALUES[preset];
											const isSelected = colorTheme === preset;
											const isHovered = hoveredTheme === preset;

											return (
												<button
													key={preset}
													type="button"
													onClick={() => handleThemeChange(preset)}
													onMouseEnter={() => setHoveredTheme(preset)}
													onMouseLeave={() => setHoveredTheme(null)}
													className={cn(
														"group relative flex flex-col items-center gap-3 rounded-xl p-4 transition-all duration-300",
														"hover:bg-muted/30",
														isSelected && "bg-muted/50"
													)}
													style={{
														animationDelay: `${350 + index * 50}ms`,
													}}
												>
													{/* Orb */}
													<div className="relative">
														{/* Glow ring - more intense for immersive */}
														<div
															className={cn(
																"absolute -inset-3 rounded-full blur-lg transition-all duration-500",
																isSelected ? "opacity-70" : "opacity-0 group-hover:opacity-40"
															)}
															style={{ backgroundColor: gradient.glow }}
														/>

														{/* Main orb with special styling */}
														<div
															className={cn(
																"relative h-14 w-14 rounded-full transition-all duration-300",
																"ring-2 ring-offset-2 ring-offset-background",
																isSelected
																	? "ring-foreground/20 scale-110"
																	: "ring-transparent group-hover:ring-border group-hover:scale-105"
															)}
															style={{
																background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
																boxShadow: isSelected
																	? `0 0 30px -4px ${gradient.glow}, 0 8px 24px -4px ${gradient.glow}`
																	: `0 4px 12px -4px ${gradient.glow}`,
															}}
														>
															{/* Inner highlight */}
															<div
																className="absolute inset-0 rounded-full opacity-50"
																style={{
																	background: "linear-gradient(135deg, rgba(255,255,255,0.4) 0%, transparent 50%)",
																}}
															/>

															{/* Selection indicator */}
															{isSelected && (
																<div className="absolute inset-0 flex items-center justify-center">
																	<div className="h-2 w-2 rounded-full bg-white shadow-sm animate-in zoom-in duration-300" />
																</div>
															)}
														</div>

														{/* Enhanced pulse effect for immersive */}
														{(isHovered || isSelected) && (
															<>
																<div
																	className={cn(
																		"absolute -inset-1 rounded-full animate-ping",
																		isSelected ? "opacity-30" : "opacity-15"
																	)}
																	style={{
																		backgroundColor: gradient.from,
																		animationDuration: "1.5s",
																	}}
																/>
																<div
																	className={cn(
																		"absolute -inset-2 rounded-full animate-ping",
																		isSelected ? "opacity-20" : "opacity-10"
																	)}
																	style={{
																		backgroundColor: gradient.to,
																		animationDuration: "2s",
																		animationDelay: "0.3s",
																	}}
																/>
															</>
														)}
													</div>

													{/* Label */}
													<span
														className={cn(
															"text-xs font-medium transition-colors duration-300",
															isSelected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
														)}
													>
														{info.label}
													</span>
												</button>
											);
										})}
									</div>

									{/* Info note about immersive themes */}
									{isImmersive && (
										<div className="mt-5 flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/30 animate-in fade-in slide-in-from-bottom-2 duration-300">
											<Zap className="h-4 w-4 mt-0.5 shrink-0" style={{ color: activeGradient.from }} />
											<div className="text-xs text-muted-foreground">
												<span className="font-medium text-foreground">{THEME_INFO[colorTheme].label}</span> includes special visual effects like scanlines and neon glow. Light/dark mode and OLED options are not available with immersive themes.
											</div>
										</div>
									)}
								</div>
							</div>
						</div>

						{/* Premium Themes */}
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "300ms" }}
						>
							<div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-xs p-6 relative overflow-hidden">
								{/* Premium shimmer background */}
								<div className="absolute inset-0 opacity-[0.02] pointer-events-none overflow-hidden">
									<div
										className="absolute inset-0"
										style={{
											backgroundImage: `linear-gradient(
												135deg,
												transparent 0%,
												rgba(255, 215, 0, 0.3) 25%,
												transparent 50%,
												rgba(255, 215, 0, 0.3) 75%,
												transparent 100%
											)`,
											backgroundSize: "400% 400%",
											animation: "premium-shimmer 8s ease-in-out infinite",
										}}
									/>
								</div>

								<div className="relative">
									<h3 className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
										<span
											className="inline-block h-1.5 w-1.5 rounded-full"
											style={{
												background: "linear-gradient(135deg, #ffd700, #ff8c00)",
											}}
										/>
										Premium Themes
										{premiumUnlocked ? (
											<span className="ml-auto text-[10px] font-medium px-2 py-0.5 rounded-full bg-linear-to-r from-green-500/20 to-emerald-500/20 text-green-600 dark:text-green-400 border border-green-500/20">
												<Zap className="inline h-3 w-3 mr-1 -mt-0.5" />
												Unlocked (Dev)
											</span>
										) : (
											<span className="ml-auto text-[10px] font-medium px-2 py-0.5 rounded-full bg-linear-to-r from-amber-500/20 to-orange-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/20">
												<Crown className="inline h-3 w-3 mr-1 -mt-0.5" />
												Coming Soon
											</span>
										)}
									</h3>
									<p className="text-xs text-muted-foreground mb-5">
										{premiumUnlocked
											? "Developer mode active — all premium themes unlocked for testing"
											: "Our most stunning themes with advanced effects — requires activation"}
									</p>

									<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
										{PREMIUM_THEME_IDS.map((themeId, index) => {
											const info = THEME_INFO[themeId as ColorTheme];
											const gradient = THEME_GRADIENT_VALUES[themeId as ColorTheme];
											const isSelected = colorTheme === themeId;
											const isHovered = hoveredTheme === themeId;

											if (premiumUnlocked) {
												// Unlocked state - interactive like Immersive themes
												return (
													<button
														key={themeId}
														type="button"
														onClick={() => handleThemeChange(themeId as ColorTheme)}
														onMouseEnter={() => setHoveredTheme(themeId as ColorTheme)}
														onMouseLeave={() => setHoveredTheme(null)}
														className={cn(
															"group relative flex flex-col items-center gap-3 rounded-xl p-4 transition-all duration-300",
															"hover:bg-muted/30",
															isSelected && "bg-muted/50"
														)}
														style={{
															animationDelay: `${400 + index * 50}ms`,
														}}
													>
														{/* Orb */}
														<div className="relative">
															{/* Glow ring - more intense for premium */}
															<div
																className={cn(
																	"absolute -inset-3 rounded-full blur-lg transition-all duration-500",
																	isSelected ? "opacity-70" : "opacity-0 group-hover:opacity-40"
																)}
																style={{ backgroundColor: gradient.glow }}
															/>

															{/* Main orb with special styling */}
															<div
																className={cn(
																	"relative h-14 w-14 rounded-full transition-all duration-300",
																	"ring-2 ring-offset-2 ring-offset-background",
																	isSelected
																		? "ring-foreground/20 scale-110"
																		: "ring-transparent group-hover:ring-border group-hover:scale-105"
																)}
																style={{
																	background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
																	boxShadow: isSelected
																		? `0 0 30px -4px ${gradient.glow}, 0 8px 24px -4px ${gradient.glow}`
																		: `0 4px 12px -4px ${gradient.glow}`,
																}}
															>
																{/* Inner highlight */}
																<div
																	className="absolute inset-0 rounded-full opacity-50"
																	style={{
																		background: "linear-gradient(135deg, rgba(255,255,255,0.4) 0%, transparent 50%)",
																	}}
																/>

																{/* Selection indicator */}
																{isSelected && (
																	<div className="absolute inset-0 flex items-center justify-center">
																		<div className="h-2 w-2 rounded-full bg-white shadow-sm animate-in zoom-in duration-300" />
																	</div>
																)}
															</div>

															{/* Enhanced pulse effect for premium */}
															{(isHovered || isSelected) && (
																<>
																	<div
																		className={cn(
																			"absolute -inset-1 rounded-full animate-ping",
																			isSelected ? "opacity-30" : "opacity-15"
																		)}
																		style={{
																			backgroundColor: gradient.from,
																			animationDuration: "1.5s",
																		}}
																	/>
																	<div
																		className={cn(
																			"absolute -inset-2 rounded-full animate-ping",
																			isSelected ? "opacity-20" : "opacity-10"
																		)}
																		style={{
																			backgroundColor: gradient.to,
																			animationDuration: "2s",
																			animationDelay: "0.3s",
																		}}
																	/>
																</>
															)}
														</div>

														{/* Label */}
														<span
															className={cn(
																"text-xs font-medium transition-colors duration-300",
																isSelected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
															)}
														>
															{info.label}
														</span>
													</button>
												);
											}

											// Locked state - non-interactive
											return (
												<div
													key={themeId}
													className="group relative flex flex-col items-center gap-3 rounded-xl p-4 cursor-not-allowed opacity-60"
													style={{
														animationDelay: `${400 + index * 50}ms`,
													}}
												>
													{/* Orb */}
													<div className="relative">
														{/* Subtle glow */}
														<div
															className="absolute -inset-2 rounded-full blur-md opacity-20"
															style={{ backgroundColor: gradient.glow }}
														/>

														{/* Main orb with lock overlay */}
														<div
															className="relative h-14 w-14 rounded-full ring-2 ring-offset-2 ring-offset-background ring-border/30"
															style={{
																background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
																boxShadow: `0 4px 12px -4px ${gradient.glow}`,
																filter: "saturate(0.7)",
															}}
														>
															{/* Inner highlight */}
															<div
																className="absolute inset-0 rounded-full opacity-40"
																style={{
																	background: "linear-gradient(135deg, rgba(255,255,255,0.3) 0%, transparent 50%)",
																}}
															/>

															{/* Lock icon overlay */}
															<div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full">
																<Lock className="h-5 w-5 text-white/80" />
															</div>
														</div>
													</div>

													{/* Label */}
													<span className="text-xs font-medium text-muted-foreground">
														{info.label}
													</span>
												</div>
											);
										})}
									</div>

									{/* Info note */}
									{premiumUnlocked ? (
										<div className="mt-5 flex items-start gap-3 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
											<Zap className="h-4 w-4 mt-0.5 shrink-0 text-green-500" />
											<div className="text-xs text-muted-foreground">
												<span className="font-medium text-foreground">Developer mode</span> — Premium themes are unlocked for testing. CSS effects may still be in development.
											</div>
										</div>
									) : (
										<div className="mt-5 flex items-start gap-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
											<Crown className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
											<div className="text-xs text-muted-foreground">
												<span className="font-medium text-foreground">Premium themes</span> will feature our most advanced visual effects and exclusive designs. Stay tuned for the release!
											</div>
										</div>
									)}
								</div>
							</div>
						</div>
					</div>

					{/* Right Column - Live Preview */}
					<div
						className="animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "300ms" }}
					>
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
					</div>
				</div>
			</div>
		</div>
	);
}
