"use client";

import { useTheme } from "next-themes";
import { useColorTheme, COLOR_THEMES, THEME_INFO, type ColorTheme } from "../../../providers/color-theme-provider";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";
import { useEffect, useState, useRef } from "react";
import { Sun, Moon, Monitor, Sparkles, Play, Bell, Calendar, TrendingUp } from "lucide-react";

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
	const [mounted, setMounted] = useState(false);
	const [hoveredTheme, setHoveredTheme] = useState<ColorTheme | null>(null);
	const [isTransitioning, setIsTransitioning] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setMounted(true);
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
					<div className="h-16 w-16 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 animate-pulse" />
				</div>
			</div>
		);
	}

	const activeGradient = THEME_GRADIENTS[colorTheme];
	const isDark = resolvedTheme === "dark";

	return (
		<div ref={containerRef} className="relative">
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
				<div className="grid gap-6 lg:grid-cols-[1fr,380px]">
					{/* Left Column - Controls */}
					<div className="space-y-6">
						{/* Color Scheme Toggle */}
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "100ms" }}
						>
							<div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm p-6">
								<h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
									<span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
									Color Scheme
								</h3>

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
							</div>
						</div>

						{/* Color Theme Orbs */}
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "200ms" }}
						>
							<div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm p-6">
								<h3 className="text-sm font-medium text-foreground mb-6 flex items-center gap-2">
									<span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
									Color Theme
								</h3>

								<div className="grid grid-cols-3 gap-4">
									{COLOR_THEMES.map((preset, index) => {
										const info = THEME_INFO[preset];
										const gradient = THEME_GRADIENTS[preset];
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
					</div>

					{/* Right Column - Live Preview */}
					<div
						className="animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "300ms" }}
					>
						<div className="sticky top-6">
							<div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm p-6">
								<h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
									<span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
									Live Preview
								</h3>

								{/* Mini Dashboard Preview */}
								<div
									className={cn(
										"relative overflow-hidden rounded-xl border border-border/50 transition-all duration-500",
										isDark ? "bg-zinc-900" : "bg-white"
									)}
									style={{
										boxShadow: `0 20px 40px -12px ${activeGradient.glow}`,
									}}
								>
									{/* Mini sidebar */}
									<div
										className={cn(
											"absolute left-0 top-0 bottom-0 w-12 border-r transition-colors duration-500",
											isDark ? "bg-zinc-900/80 border-zinc-800" : "bg-zinc-50 border-zinc-200"
										)}
									>
										<div className="flex flex-col items-center gap-3 p-2 pt-4">
											<div
												className="h-6 w-6 rounded-lg"
												style={{
													background: `linear-gradient(135deg, ${activeGradient.from}, ${activeGradient.to})`,
												}}
											/>
											<div className={cn("h-5 w-5 rounded", isDark ? "bg-zinc-700" : "bg-zinc-200")} />
											<div className={cn("h-5 w-5 rounded", isDark ? "bg-zinc-700" : "bg-zinc-200")} />
											<div className={cn("h-5 w-5 rounded", isDark ? "bg-zinc-700" : "bg-zinc-200")} />
										</div>
									</div>

									{/* Main content area */}
									<div className="pl-12">
										{/* Header */}
										<div
											className={cn(
												"flex items-center justify-between border-b px-4 py-3 transition-colors duration-500",
												isDark ? "border-zinc-800" : "border-zinc-200"
											)}
										>
											<div className={cn("h-3 w-20 rounded", isDark ? "bg-zinc-700" : "bg-zinc-200")} />
											<div className="flex gap-2">
												<Bell className={cn("h-4 w-4", isDark ? "text-zinc-500" : "text-zinc-400")} />
											</div>
										</div>

										{/* Content */}
										<div className="p-4 space-y-4">
											{/* Stats row */}
											<div className="grid grid-cols-3 gap-2">
												{[Play, Calendar, TrendingUp].map((Icon, i) => (
													<div
														key={i}
														className={cn(
															"rounded-lg p-3 transition-colors duration-500",
															isDark ? "bg-zinc-800/50" : "bg-zinc-100"
														)}
													>
														<Icon
															className="h-4 w-4 mb-2"
															style={{ color: activeGradient.from }}
														/>
														<div
															className={cn(
																"h-2 w-8 rounded mb-1",
																isDark ? "bg-zinc-700" : "bg-zinc-200"
															)}
														/>
														<div
															className={cn(
																"h-1.5 w-12 rounded",
																isDark ? "bg-zinc-700/50" : "bg-zinc-200/70"
															)}
														/>
													</div>
												))}
											</div>

											{/* List items */}
											<div className="space-y-2">
												{[0, 1, 2].map((i) => (
													<div
														key={i}
														className={cn(
															"flex items-center gap-3 rounded-lg p-2 transition-colors duration-500",
															isDark ? "bg-zinc-800/30" : "bg-zinc-50"
														)}
													>
														<div
															className="h-8 w-8 rounded-md shrink-0"
															style={{
																background: i === 0
																	? `linear-gradient(135deg, ${activeGradient.from}40, ${activeGradient.to}40)`
																	: isDark ? "#27272a" : "#e4e4e7",
															}}
														/>
														<div className="flex-1 space-y-1">
															<div
																className={cn(
																	"h-2 rounded",
																	isDark ? "bg-zinc-700" : "bg-zinc-200"
																)}
																style={{ width: `${70 - i * 15}%` }}
															/>
															<div
																className={cn(
																	"h-1.5 w-16 rounded",
																	isDark ? "bg-zinc-700/50" : "bg-zinc-200/70"
																)}
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
													className={cn(
														"rounded-lg px-3 py-2 text-[10px] font-medium transition-all duration-300",
														isDark
															? "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
															: "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
													)}
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
