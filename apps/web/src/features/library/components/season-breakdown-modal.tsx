"use client";

import { useState } from "react";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import type { LibraryItem } from "@arr/shared";
import {
	ChevronDown,
	ChevronRight,
	Loader2,
	Search,
	Tv,
	Film,
	Layers,
	X,
	AlertTriangle,
	CheckCircle2,
} from "lucide-react";
import { Button } from "../../../components/ui";
import { cn } from "../../../lib/utils";
import { SeasonEpisodeList } from "./season-episode-list";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

/**
 * Props for the SeasonBreakdownModal component
 */
interface SeasonBreakdownModalProps {
	/** The library item (must be a series) to display season details for */
	item: LibraryItem;
	/** Callback to close the modal */
	onClose: () => void;
	/** Callback to toggle monitoring for a season */
	onToggleSeason: (seasonNumber: number, nextMonitored: boolean) => void;
	/** Callback to search for a season */
	onSearchSeason: (seasonNumber: number) => void;
	/** The key representing which action is currently pending */
	pendingActionKey: string | null;
}

// Use centralized Sonarr color
const SONARR_COLOR = SERVICE_GRADIENTS.sonarr.from;

/**
 * Premium Season Badge Component
 */
const SeasonBadge = ({
	tone,
	children,
}: {
	tone: "success" | "warning" | "error" | "muted";
	children: React.ReactNode;
}) => {
	const colors = {
		success: SEMANTIC_COLORS.success,
		warning: SEMANTIC_COLORS.warning,
		error: SEMANTIC_COLORS.error,
		muted: { bg: "rgba(100, 116, 139, 0.1)", border: "rgba(100, 116, 139, 0.3)", text: "#94a3b8" },
	};
	const color = colors[tone];

	return (
		<span
			className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
			style={{
				backgroundColor: color.bg,
				border: `1px solid ${color.border}`,
				color: color.text,
			}}
		>
			{children}
		</span>
	);
};

/**
 * Premium Season Breakdown Modal
 *
 * Displays detailed season/episode information with:
 * - Glassmorphic modal styling
 * - Theme-aware progress bars
 * - Sonarr-branded header
 * - Staggered season animations
 */
export const SeasonBreakdownModal = ({
	item,
	onClose,
	onToggleSeason,
	onSearchSeason,
	pendingActionKey,
}: SeasonBreakdownModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set());
	const focusTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);

	if (item.type !== "series" || !item.seasons?.length) {
		return null;
	}

	const toggleSeasonExpanded = (seasonNumber: number) => {
		setExpandedSeasons((prev) => {
			const next = new Set(prev);
			if (next.has(seasonNumber)) {
				next.delete(seasonNumber);
			} else {
				next.add(seasonNumber);
			}
			return next;
		});
	};

	const totalMissing = item.seasons.reduce(
		(total, season) =>
			total +
			(season.missingEpisodeCount ??
				Math.max((season.episodeCount ?? 0) - (season.episodeFileCount ?? 0), 0)),
		0,
	);

	const totalEpisodes = item.seasons.reduce((total, season) => total + (season.episodeCount ?? 0), 0);
	const downloadedEpisodes = item.seasons.reduce((total, season) => total + (season.episodeFileCount ?? 0), 0);
	const overallProgress = totalEpisodes > 0 ? Math.round((downloadedEpisodes / totalEpisodes) * 100) : 0;

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="season-breakdown-title"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

			{/* Modal */}
			<div
				ref={focusTrapRef}
				className="relative w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${SONARR_COLOR}15`,
				}}
				onClick={(event) => event.stopPropagation()}
			>
				{/* Close Button */}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close modal"
					className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white"
				>
					<X className="h-4 w-4" />
				</button>

				{/* Header */}
				<div
					className="p-6 border-b border-border/30"
					style={{
						background: `linear-gradient(135deg, ${SONARR_COLOR}08, transparent)`,
					}}
				>
					<div className="flex items-start gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `${SONARR_COLOR}20`,
								border: `1px solid ${SONARR_COLOR}30`,
							}}
						>
							<Tv className="h-6 w-6" style={{ color: SONARR_COLOR }} />
						</div>
						<div className="flex-1 min-w-0">
							<h2 id="season-breakdown-title" className="text-xl font-bold text-foreground">{item.title}</h2>
							<div className="flex flex-wrap items-center gap-3 mt-1 text-sm text-muted-foreground">
								<span>{item.instanceName}</span>
								<span>•</span>
								<span className="flex items-center gap-1">
									<Layers className="h-3.5 w-3.5" />
									{item.seasons.length} season{item.seasons.length !== 1 ? "s" : ""}
								</span>
								{totalMissing > 0 ? (
									<SeasonBadge tone="warning">
										<AlertTriangle className="h-3 w-3" />
										{totalMissing} missing
									</SeasonBadge>
								) : (
									<SeasonBadge tone="success">
										<CheckCircle2 className="h-3 w-3" />
										Complete
									</SeasonBadge>
								)}
							</div>

							{/* Overall Progress */}
							<div className="mt-4 space-y-1.5">
								<div className="flex items-center justify-between text-xs">
									<span className="text-muted-foreground">Overall Progress</span>
									<span className="font-medium text-foreground">
										{downloadedEpisodes}/{totalEpisodes} episodes ({overallProgress}%)
									</span>
								</div>
								<div className="h-2 rounded-full bg-muted/30 overflow-hidden">
									<div
										className="h-full transition-all duration-500 rounded-full"
										style={{
											width: `${overallProgress}%`,
											background:
												totalMissing > 0
													? `linear-gradient(90deg, ${SEMANTIC_COLORS.warning.from}, ${SEMANTIC_COLORS.warning.to})`
													: `linear-gradient(90deg, ${SEMANTIC_COLORS.success.from}, ${SEMANTIC_COLORS.success.to})`,
										}}
									/>
								</div>
							</div>
						</div>
					</div>
				</div>

				{/* Season List */}
				<div className="max-h-[calc(90vh-200px)] overflow-y-auto p-6 space-y-3">
					{item.seasons.map((season, index) => {
						const total = season.episodeCount ?? 0;
						const downloaded = season.episodeFileCount ?? 0;
						const missing =
							season.monitored === false
								? 0
								: (season.missingEpisodeCount ?? Math.max(total - downloaded, 0));
						const isSpecial = season.seasonNumber === 0;
						const label = isSpecial ? "Specials" : `Season ${season.seasonNumber}`;
						const seasonKey = `${item.instanceId}:${item.id}:${season.seasonNumber}`;
						const monitorKey = `monitor:${seasonKey}`;
						const searchKey = `search:${seasonKey}`;
						const seasonMonitorPending = pendingActionKey === monitorKey;
						const seasonSearchPending = pendingActionKey === searchKey;

						const isExpanded = expandedSeasons.has(season.seasonNumber);
						const percentComplete = total > 0 ? Math.round((downloaded / total) * 100) : 0;

						return (
							<div
								key={season.seasonNumber}
								className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm overflow-hidden transition-all duration-300 hover:border-border/80 animate-in fade-in slide-in-from-bottom-2"
								style={{
									animationDelay: `${index * 50}ms`,
									animationFillMode: "backwards",
									...(isExpanded && {
										borderColor: `${themeGradient.from}40`,
									}),
								}}
							>
								<div className="px-4 py-3">
									<div className="flex flex-wrap items-center justify-between gap-3">
										<button
											onClick={() => toggleSeasonExpanded(season.seasonNumber)}
											aria-expanded={isExpanded}
											className="flex items-center gap-2 text-left hover:text-foreground transition-colors group"
										>
											<div
												className="flex h-6 w-6 items-center justify-center rounded-md transition-colors"
												style={{
													background: isExpanded ? `${themeGradient.from}20` : "transparent",
												}}
											>
												{isExpanded ? (
													<ChevronDown
														className="h-4 w-4"
														style={{ color: themeGradient.from }}
													/>
												) : (
													<ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
												)}
											</div>
											<div>
												<p className="text-sm font-medium text-foreground">{label}</p>
												{season.title && season.title !== label ? (
													<p className="text-xs text-muted-foreground">{season.title}</p>
												) : null}
											</div>
										</button>

										<div className="flex flex-wrap items-center gap-2">
											<SeasonBadge tone={missing > 0 ? "warning" : "success"}>
												{downloaded}/{total || "?"} episodes
											</SeasonBadge>
											{missing > 0 && <SeasonBadge tone="error">{missing} missing</SeasonBadge>}
											{season.monitored === false && <SeasonBadge tone="muted">Unmonitored</SeasonBadge>}
										</div>

										<div className="flex flex-wrap items-center gap-2">
											<Button
												type="button"
												variant="outline"
												size="sm"
												className="gap-1.5"
												disabled={seasonMonitorPending}
												onClick={() =>
													onToggleSeason(season.seasonNumber, !(season.monitored ?? false))
												}
											>
												{seasonMonitorPending ? (
													<Loader2 className="h-3.5 w-3.5 animate-spin" />
												) : season.monitored === false ? (
													"Monitor"
												) : (
													"Unmonitor"
												)}
											</Button>
											<Button
												type="button"
												size="sm"
												className="gap-1.5"
												disabled={seasonSearchPending}
												onClick={() => onSearchSeason(season.seasonNumber)}
												style={{
													background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
													boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
												}}
											>
												{seasonSearchPending ? (
													<Loader2 className="h-3.5 w-3.5 animate-spin" />
												) : (
													<Search className="h-3.5 w-3.5" />
												)}
												Search
											</Button>
										</div>
									</div>

									{/* Progress bar */}
									{total > 0 && (
										<div className="mt-3 space-y-1.5">
											<div className="flex items-center justify-between text-xs">
												<span className="text-muted-foreground">Progress</span>
												<span className="font-medium text-foreground">{percentComplete}%</span>
											</div>
											<div className="h-1.5 rounded-full bg-muted/30 overflow-hidden">
												<div
													className="h-full transition-all duration-300 rounded-full"
													style={{
														width: `${percentComplete}%`,
														background:
															missing > 0
																? `linear-gradient(90deg, ${SEMANTIC_COLORS.warning.from}, ${SEMANTIC_COLORS.warning.to})`
																: `linear-gradient(90deg, ${SEMANTIC_COLORS.success.from}, ${SEMANTIC_COLORS.success.to})`,
													}}
												/>
											</div>
										</div>
									)}
								</div>

								{/* Expanded details */}
								{isExpanded && (
									<div
										className="border-t border-border/30 px-4 py-4 space-y-4"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}05, transparent)`,
										}}
									>
										<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
											<div className="rounded-lg border border-border/50 bg-card/30 p-3">
												<p className="text-xs text-muted-foreground">Total Episodes</p>
												<p className="mt-1 text-lg font-semibold text-foreground">{total}</p>
											</div>
											<div
												className="rounded-lg p-3"
												style={{
													backgroundColor: SEMANTIC_COLORS.success.bg,
													border: `1px solid ${SEMANTIC_COLORS.success.border}`,
												}}
											>
												<p className="text-xs" style={{ color: SEMANTIC_COLORS.success.text }}>
													Downloaded
												</p>
												<p
													className="mt-1 text-lg font-semibold"
													style={{ color: SEMANTIC_COLORS.success.from }}
												>
													{downloaded}
												</p>
											</div>
											{missing > 0 && (
												<div
													className="rounded-lg p-3"
													style={{
														backgroundColor: SEMANTIC_COLORS.error.bg,
														border: `1px solid ${SEMANTIC_COLORS.error.border}`,
													}}
												>
													<p className="text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>
														Missing
													</p>
													<p
														className="mt-1 text-lg font-semibold"
														style={{ color: SEMANTIC_COLORS.error.from }}
													>
														{missing}
													</p>
												</div>
											)}
											<div className="rounded-lg border border-border/50 bg-card/30 p-3">
												<p className="text-xs text-muted-foreground">Status</p>
												<p className="mt-1 text-sm font-medium text-foreground">
													{season.monitored === false ? "Unmonitored" : "Monitored"}
												</p>
											</div>
										</div>

										<div className="border-t border-border/30 pt-4">
											<h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
												Episodes
											</h4>
											<SeasonEpisodeList
												instanceId={item.instanceId}
												seriesId={item.id}
												seasonNumber={season.seasonNumber}
											/>
										</div>

										{missing > 0 && season.monitored !== false && (
											<div
												className="p-3 rounded-xl flex items-start gap-3"
												style={{
													backgroundColor: SEMANTIC_COLORS.warning.bg,
													border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
												}}
											>
												<AlertTriangle
													className="h-4 w-4 shrink-0 mt-0.5"
													style={{ color: SEMANTIC_COLORS.warning.from }}
												/>
												<p className="text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>
													{missing} episode{missing === 1 ? "" : "s"} missing. Click{" "}
													&ldquo;Search&rdquo; to look for {missing === 1 ? "it" : "them"}.
												</p>
											</div>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
};
