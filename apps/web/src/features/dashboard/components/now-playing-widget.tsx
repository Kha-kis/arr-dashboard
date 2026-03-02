"use client";

import type { PlexSession, TautulliSession } from "@arr/shared";
import {
	Activity,
	ChevronRight,
	Film,
	Globe,
	Headphones,
	Monitor,
	Pause,
	Play,
	Radio,
	Tv,
	Wifi,
} from "lucide-react";
import { GlassmorphicCard } from "../../../components/layout";
import { useNowPlaying } from "../../../hooks/api/usePlex";
import { useTautulliActivity } from "../../../hooks/api/useTautulli";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

// ============================================================================
// Normalized Session Type
// ============================================================================

interface NowPlayingSession {
	key: string;
	title: string;
	subtitle?: string;
	user: string;
	state: "playing" | "paused" | "buffering";
	progress: number; // 0-100
	duration: number; // ms
	viewOffset: number; // ms
	player: string;
	platform: string;
	videoDecision: string;
	audioDecision: string;
	videoResolution?: string;
	audioCodec?: string;
	bandwidth?: number;
	location?: "lan" | "wan";
	mediaType: "movie" | "episode" | "track" | "unknown";
	thumb?: string;
	instanceName: string;
	source: "plex" | "tautulli";
}

// ============================================================================
// Props
// ============================================================================

interface NowPlayingWidgetProps {
	hasPlexInstances: boolean;
	hasTautulliInstances: boolean;
	animationDelay?: number;
	variant?: "compact" | "full";
}

// ============================================================================
// Helpers
// ============================================================================

function normalizePlexSession(s: PlexSession): NowPlayingSession {
	const mediaType = s.type === "movie" ? "movie" : s.type === "episode" ? "episode" : s.type === "track" ? "track" : "unknown";
	return {
		key: `plex:${s.instanceId}:${s.sessionKey}`,
		title: s.grandparentTitle ? `${s.grandparentTitle} — ${s.title}` : s.title,
		subtitle: s.grandparentTitle ?? undefined,
		user: s.user.title,
		state: s.state,
		progress: s.duration > 0 ? Math.round((s.viewOffset / s.duration) * 100) : 0,
		duration: s.duration,
		viewOffset: s.viewOffset,
		player: s.player.title,
		platform: s.player.platform,
		videoDecision: s.videoDecision,
		audioDecision: s.audioDecision,
		bandwidth: s.bandwidth,
		mediaType,
		thumb: s.thumb,
		instanceName: s.instanceName,
		source: "plex",
	};
}

function normalizeTautulliSession(s: TautulliSession): NowPlayingSession {
	const mediaType = s.mediaType === "movie" ? "movie" : s.mediaType === "episode" ? "episode" : s.mediaType === "track" ? "track" : "unknown";
	return {
		key: `tautulli:${s.instanceId}:${s.sessionKey}`,
		title: s.grandparentTitle ? `${s.grandparentTitle} — ${s.title}` : s.title,
		subtitle: s.grandparentTitle ?? undefined,
		user: s.user,
		state: s.state,
		progress: s.progressPercent,
		duration: 0,
		viewOffset: 0,
		player: s.player,
		platform: s.platform,
		videoDecision: s.videoDecision,
		audioDecision: s.audioDecision,
		videoResolution: s.videoResolution,
		audioCodec: s.audioCodec,
		bandwidth: s.bandwidth,
		location: s.location,
		mediaType,
		thumb: s.thumb,
		instanceName: s.instanceName,
		source: "tautulli",
	};
}

function mergeSessions(
	plexSessions: PlexSession[],
	tautulliSessions: TautulliSession[],
): NowPlayingSession[] {
	// Prefer Tautulli when same session appears in both sources.
	// Dedup key includes instanceId to avoid collisions across Plex servers.
	const merged: NowPlayingSession[] = [];

	// Add all Tautulli sessions first (richer data)
	for (const s of tautulliSessions) {
		merged.push(normalizeTautulliSession(s));
	}

	// Add Plex sessions not covered by Tautulli
	for (const s of plexSessions) {
		// Match by ratingKey within the same logical server (Tautulli monitors one Plex)
		const hasMatch = tautulliSessions.some((t) => t.ratingKey === s.ratingKey && t.sessionKey === s.sessionKey);
		if (!hasMatch) {
			merged.push(normalizePlexSession(s));
		}
	}

	return merged;
}

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
}

function formatBandwidth(kbps: number): string {
	if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
	return `${kbps} kbps`;
}

function getMediaIcon(mediaType: NowPlayingSession["mediaType"]) {
	return mediaType === "movie" ? Film : mediaType === "episode" ? Tv : mediaType === "track" ? Headphones : Film;
}

const plexGradient = SERVICE_GRADIENTS.plex;

// ============================================================================
// Shared Badge Row (used in both compact and full variants)
// ============================================================================

const SessionBadges = ({
	session,
	size = "sm",
}: {
	session: NowPlayingSession;
	size?: "sm" | "md";
}) => {
	const videoDecisionLower = session.videoDecision.toLowerCase();
	const isDirectPlay = videoDecisionLower.includes("direct");
	const isCopy = videoDecisionLower === "copy";
	const transcodeColor = (isDirectPlay || isCopy) ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning;
	const transcodeLabel = isDirectPlay ? "Direct Play" : isCopy ? "Direct Stream" : session.videoDecision || "Transcode";
	const MediaIcon = getMediaIcon(session.mediaType);

	const badgeClass = size === "sm"
		? "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] font-medium"
		: "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium";
	const iconClass = size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";

	return (
		<div className={`flex flex-wrap items-center gap-${size === "sm" ? "1" : "1.5"}`}>
			{/* Media type */}
			<span
				className={`${badgeClass} capitalize`}
				style={{
					backgroundColor: `${plexGradient.from}15`,
					border: `1px solid ${plexGradient.from}25`,
					color: plexGradient.from,
				}}
			>
				<MediaIcon className={iconClass} />
				{session.mediaType === "unknown" ? "media" : session.mediaType}
			</span>

			{/* Transcode / Direct Play */}
			<span
				className={badgeClass}
				style={{
					backgroundColor: transcodeColor.bg,
					border: `1px solid ${transcodeColor.border}`,
					color: transcodeColor.text,
				}}
			>
				<Monitor className={iconClass} />
				{transcodeLabel}
				{session.videoResolution ? ` · ${session.videoResolution}` : ""}
			</span>

			{/* Audio codec + decision */}
			{session.audioCodec && (() => {
				const audioLower = session.audioDecision.toLowerCase();
				const isAudioDirect = audioLower.includes("direct") || audioLower === "copy";
				const audioColor = isAudioDirect ? undefined : SEMANTIC_COLORS.warning;
				return (
					<span
						className={audioColor
							? badgeClass
							: `${badgeClass} bg-muted/30 border border-border/50 text-muted-foreground`
						}
						style={audioColor ? {
							backgroundColor: audioColor.bg,
							border: `1px solid ${audioColor.border}`,
							color: audioColor.text,
						} : undefined}
					>
						{size === "md" && <Headphones className={iconClass} />}
						{session.audioCodec.toUpperCase()}
						{!isAudioDirect && " (Transcode)"}
					</span>
				);
			})()}

			{/* Bandwidth */}
			{session.bandwidth != null && session.bandwidth > 0 && (
				<span
					className={badgeClass}
					style={{
						backgroundColor: SEMANTIC_COLORS.info.bg,
						border: `1px solid ${SEMANTIC_COLORS.info.border}`,
						color: SEMANTIC_COLORS.info.text,
					}}
				>
					{size === "md" && <Wifi className={iconClass} />}
					{formatBandwidth(session.bandwidth)}
				</span>
			)}

			{/* LAN/WAN */}
			{session.location && (
				<span
					className={badgeClass}
					style={{
						backgroundColor: session.location === "lan" ? SEMANTIC_COLORS.success.bg : SEMANTIC_COLORS.warning.bg,
						border: `1px solid ${session.location === "lan" ? SEMANTIC_COLORS.success.border : SEMANTIC_COLORS.warning.border}`,
						color: session.location === "lan" ? SEMANTIC_COLORS.success.text : SEMANTIC_COLORS.warning.text,
					}}
				>
					{size === "md" && <Globe className={iconClass} />}
					{session.location.toUpperCase()}
				</span>
			)}
		</div>
	);
};

// ============================================================================
// Component
// ============================================================================

export const NowPlayingWidget = ({
	hasPlexInstances,
	hasTautulliInstances,
	animationDelay = 0,
	variant = "compact",
}: NowPlayingWidgetProps) => {
	const plexQuery = useNowPlaying(hasPlexInstances);
	const tautulliQuery = useTautulliActivity(hasTautulliInstances);

	const plexSessions = plexQuery.data?.sessions ?? [];
	const tautulliSessions = tautulliQuery.data?.sessions ?? [];

	const sessions = mergeSessions(plexSessions, tautulliSessions);
	const totalBandwidth =
		(tautulliQuery.data?.totalBandwidth ?? 0) || (plexQuery.data?.totalBandwidth ?? 0);
	const lanBandwidth = tautulliQuery.data?.lanBandwidth ?? 0;
	const wanBandwidth = tautulliQuery.data?.wanBandwidth ?? 0;

	const isLoading = plexQuery.isLoading || tautulliQuery.isLoading;
	const hasError = plexQuery.isError && tautulliQuery.isError;

	if (isLoading && sessions.length === 0) return null;

	if (hasError) {
		return (
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
			>
				<GlassmorphicCard padding="none" className="group transition-all hover:border-border/80">
					<div
						className="h-0.5 w-full rounded-t-xl"
						style={{
							background: `linear-gradient(90deg, ${plexGradient.from}, ${plexGradient.to})`,
						}}
					/>
					<div className="flex items-center gap-3 p-4">
						<div
							className="flex h-8 w-8 items-center justify-center rounded-lg"
							style={{
								background: `linear-gradient(135deg, ${plexGradient.from}20, ${plexGradient.to}20)`,
								border: `1px solid ${plexGradient.from}30`,
							}}
						>
							<Activity className="h-4 w-4" style={{ color: plexGradient.from }} />
						</div>
						<div>
							<h3 className="text-sm font-semibold text-foreground">Now Playing</h3>
							<p className="text-xs text-muted-foreground">Could not load session data</p>
						</div>
					</div>
				</GlassmorphicCard>
			</div>
		);
	}

	if (variant === "compact") {
		return (
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
			>
				<GlassmorphicCard padding="none" className="group transition-all hover:border-border/80">
					<div
						className="h-0.5 w-full rounded-t-xl"
						style={{
							background: `linear-gradient(90deg, ${plexGradient.from}, ${plexGradient.to})`,
						}}
					/>
					<div className="p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${plexGradient.from}20, ${plexGradient.to}20)`,
										border: `1px solid ${plexGradient.from}30`,
									}}
								>
									<Activity className="h-4 w-4" style={{ color: plexGradient.from }} />
								</div>
								<div>
									<h3 className="text-sm font-semibold text-foreground">Now Playing</h3>
									<p className="text-xs text-muted-foreground">
										{sessions.length} active stream{sessions.length !== 1 ? "s" : ""}
										{totalBandwidth > 0 ? ` · ${formatBandwidth(totalBandwidth)}` : ""}
									</p>
								</div>
							</div>
							<ChevronRight className="h-4 w-4 text-muted-foreground" />
						</div>

						{sessions.length > 0 && (
							<div className="mt-3 space-y-3">
								{sessions.slice(0, 3).map((session) => (
									<div key={session.key} className="space-y-1.5">
										{/* Title row */}
										<div className="flex items-center gap-2 text-xs">
											{session.state === "playing" ? (
												<Play className="h-3 w-3 text-emerald-400 shrink-0" />
											) : (
												<Pause className="h-3 w-3 text-amber-400 shrink-0" />
											)}
											<span className="text-foreground font-medium truncate">{session.user}</span>
											<span className="text-muted-foreground truncate">
												{session.subtitle ? `${session.subtitle} — ${session.title}` : session.title}
											</span>
											<span className="text-muted-foreground/60 ml-auto shrink-0">
												{session.progress}%
											</span>
										</div>
										{/* Quality badges */}
										<div className="pl-5">
											<SessionBadges session={session} size="sm" />
										</div>
									</div>
								))}
								{sessions.length > 3 && (
									<p className="text-[10px] text-muted-foreground">
										+{sessions.length - 3} more stream{sessions.length - 3 !== 1 ? "s" : ""}
									</p>
								)}
							</div>
						)}
					</div>
				</GlassmorphicCard>
			</div>
		);
	}

	// Full variant — detailed session cards for Activity tab
	return (
		<div className="space-y-4">
			{/* Header stats */}
			<div className="flex items-center gap-4">
				<div className="flex items-center gap-2">
					<Radio className="h-4 w-4" style={{ color: plexGradient.from }} />
					<span className="text-sm font-semibold text-foreground">
						{sessions.length} Active Stream{sessions.length !== 1 ? "s" : ""}
					</span>
				</div>
				{totalBandwidth > 0 && (
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<Wifi className="h-3 w-3" />
						<span>{formatBandwidth(totalBandwidth)}</span>
						{lanBandwidth > 0 && (
							<span className="text-muted-foreground/60">
								(LAN: {formatBandwidth(lanBandwidth)})
							</span>
						)}
						{wanBandwidth > 0 && (
							<span className="text-muted-foreground/60">
								(WAN: {formatBandwidth(wanBandwidth)})
							</span>
						)}
					</div>
				)}
			</div>

			{sessions.length === 0 && (
				<GlassmorphicCard padding="md">
					<p className="text-sm text-muted-foreground text-center py-4">
						No active streams right now
					</p>
				</GlassmorphicCard>
			)}

			{sessions.map((session, index) => {
				return (
					<div
						key={session.key}
						className="animate-in fade-in slide-in-from-bottom-2 duration-300"
						style={{
							animationDelay: `${index * 50}ms`,
							animationFillMode: "backwards",
						}}
					>
						<GlassmorphicCard padding="md">
							<div className="flex items-start gap-3">
								{/* State icon */}
								<div
									className="flex h-10 w-10 items-center justify-center rounded-lg shrink-0 mt-0.5"
									style={{
										background: `linear-gradient(135deg, ${plexGradient.from}15, ${plexGradient.to}15)`,
										border: `1px solid ${plexGradient.from}25`,
									}}
								>
									{session.state === "playing" ? (
										<Play className="h-5 w-5 text-emerald-400" />
									) : (
										<Pause className="h-5 w-5 text-amber-400" />
									)}
								</div>

								<div className="flex-1 min-w-0 space-y-2.5">
									{/* Title + user + media type */}
									<div>
										<div className="flex items-center gap-2">
											<h4 className="text-sm font-semibold text-foreground truncate">
												{session.subtitle
													? `${session.subtitle} — ${session.title}`
													: session.title}
											</h4>
											{(() => {
												const MediaIcon = getMediaIcon(session.mediaType);
												return (
													<span
														className="inline-flex items-center gap-1 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize"
														style={{
															backgroundColor: `${plexGradient.from}15`,
															border: `1px solid ${plexGradient.from}25`,
															color: plexGradient.from,
														}}
													>
														<MediaIcon className="h-2.5 w-2.5" />
														{session.mediaType === "unknown" ? "media" : session.mediaType}
													</span>
												);
											})()}
										</div>
										<p className="text-xs text-muted-foreground mt-0.5">
											{session.user} · {session.player}
											{session.platform ? ` (${session.platform})` : ""}
										</p>
									</div>

									{/* Progress bar */}
									<div className="space-y-1">
										<div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
											<div
												className="h-full rounded-full transition-all duration-500"
												style={{
													width: `${session.progress}%`,
													background: `linear-gradient(90deg, ${plexGradient.from}, ${plexGradient.to})`,
												}}
											/>
										</div>
										<div className="flex items-center justify-between text-[10px] text-muted-foreground">
											<span>
												{session.duration > 0
													? `${formatDuration(session.viewOffset)} / ${formatDuration(session.duration)}`
													: `${session.progress}%`}
											</span>
											<span>{session.progress}%</span>
										</div>
									</div>

									{/* Quality badges row */}
									<div className="flex flex-wrap items-center gap-1.5">
										<SessionBadges session={session} size="md" />

										{/* Instance name — subtle */}
										<span className="text-[10px] text-muted-foreground/50 ml-auto">
											{session.instanceName}
										</span>
									</div>
								</div>
							</div>
						</GlassmorphicCard>
					</div>
				);
			})}
		</div>
	);
};
