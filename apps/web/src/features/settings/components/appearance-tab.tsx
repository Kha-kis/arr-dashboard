"use client";

import { useTheme } from "next-themes";
import { useColorTheme, STANDARD_THEMES, IMMERSIVE_THEMES, THEME_INFO, isImmersiveTheme, isPremiumUnlocked, isPremiumTheme, PREMIUM_THEME_IDS, type ColorTheme } from "../../../providers/color-theme-provider";
import { THEME_GRADIENT_VALUES } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useOLEDMode } from "../../../hooks/useOLEDMode";
import { cn } from "../../../lib/utils";
import { useEffect, useState, useRef } from "react";
import { Sun, Moon, Monitor, Sparkles, Smartphone, Zap, Lock, Crown } from "lucide-react";
import { ThemeOrbButton } from "./theme-orb";
import { LivePreview, getPreviewColors } from "./appearance-preview";

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
	const previewColors = getPreviewColors(colorTheme, isDark);

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
									{STANDARD_THEMES.map((preset, index) => (
										<ThemeOrbButton
											key={preset}
											preset={preset}
											label={THEME_INFO[preset].label}
											gradient={THEME_GRADIENT_VALUES[preset]}
											isSelected={colorTheme === preset}
											isHovered={hoveredTheme === preset}
											variant="standard"
											animationDelay={`${300 + index * 50}ms`}
											onSelect={handleThemeChange}
											onHover={setHoveredTheme}
										/>
									))}
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
										{IMMERSIVE_THEMES.map((preset, index) => (
											<ThemeOrbButton
												key={preset}
												preset={preset}
												label={THEME_INFO[preset].label}
												gradient={THEME_GRADIENT_VALUES[preset]}
												isSelected={colorTheme === preset}
												isHovered={hoveredTheme === preset}
												variant="immersive"
												animationDelay={`${350 + index * 50}ms`}
												onSelect={handleThemeChange}
												onHover={setHoveredTheme}
											/>
										))}
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

											if (premiumUnlocked) {
												return (
													<ThemeOrbButton
														key={themeId}
														preset={themeId as ColorTheme}
														label={info.label}
														gradient={gradient}
														isSelected={isSelected}
														isHovered={hoveredTheme === themeId}
														variant="immersive"
														animationDelay={`${400 + index * 50}ms`}
														onSelect={handleThemeChange}
														onHover={setHoveredTheme}
													/>
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
						<LivePreview
							activeGradient={activeGradient}
							previewColors={previewColors}
							isTransitioning={isTransitioning}
							theme={theme}
							colorTheme={colorTheme}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
