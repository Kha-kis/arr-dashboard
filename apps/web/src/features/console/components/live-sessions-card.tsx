"use client";

/**
 * Operator Console — Tracearr live-session card (charter §2.1).
 *
 * A cross-server view of what's playing RIGHT NOW, from Tracearr (which
 * itself unifies Plex/Jellyfin/Emby): an aggregate header (count + transcode
 * load) plus per-session rows, each with a kill-session action (Tracearr-3).
 * Complementary to the dashboard's per-server NowPlayingWidget.
 *
 * Trust rules enforced at render:
 * - Service-gated: renders nothing unless the user has an enabled Tracearr
 *   instance (the query is also disabled, so no polling for non-users).
 * - Exact counts only — the numbers come straight from Tracearr's summary,
 *   never a proxy or estimate.
 * - Unreachable ≠ zero: when Tracearr can't be reached we say so, rather
 *   than showing a misleading "0 active".
 * - Incognito: session rows show media titles / usernames / devices, so they
 *   are masked via the shared Linux-ISO helpers when incognito is on (the
 *   ACTION still targets the real, unmasked ids).
 */

import type { TracearrLiveSession } from "@arr/shared";
import { AudioLines, Ban, MonitorPlay, Pause, Play, Zap } from "lucide-react";
import { useState } from "react";
import { AsyncStateView } from "../../../components/layout";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useTracearrLiveSessions } from "../../../hooks/api/useTracearr";
import {
	getLinuxDevice,
	getLinuxInstanceName,
	getLinuxIsoName,
	getLinuxUsername,
	useIncognitoMode,
} from "../../../lib/incognito";
import { TerminateSessionDialog } from "./terminate-session-dialog";

/** Max session rows shown inline; the rest are summarized as "+N more". */
const SESSION_ROW_CAP = 5;

/** Resolve a session's display strings, masked when incognito is on. The
 *  action never uses these — only session.id / session.instanceId. */
function maskSession(session: TracearrLiveSession, incognito: boolean) {
	const rawTitle = session.mediaTitle || session.showTitle || "Untitled";
	const rawUser = session.username || "Unknown user";
	const rawPlayer = session.player || "";
	const rawServer = session.serverName || "";
	return {
		title: incognito ? getLinuxIsoName(rawTitle) : rawTitle,
		user: incognito ? getLinuxUsername(rawUser) : rawUser,
		player: rawPlayer ? (incognito ? getLinuxDevice(rawPlayer) : rawPlayer) : "",
		// serverName is a user-named media server (e.g. "John's Home Plex") —
		// sensitive per CLAUDE.md rule 6, so mask it too (the dialog shows it).
		serverName: rawServer ? (incognito ? getLinuxInstanceName(rawServer) : rawServer) : "",
	};
}

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="flex flex-col">
			<span className="text-lg font-semibold tabular-nums text-foreground">{value}</span>
			<span className="text-xs text-muted-foreground">{label}</span>
		</div>
	);
}

function SessionRow({
	session,
	incognito,
	onKill,
}: {
	session: TracearrLiveSession;
	incognito: boolean;
	onKill: (session: TracearrLiveSession) => void;
}) {
	const { title, user, player } = maskSession(session, incognito);
	const isTranscode = session.isTranscode || session.videoDecision === "transcode";
	const paused = session.state === "paused";
	const StateIcon = paused ? Pause : Play;
	const pct =
		session.progressMs && session.durationMs && session.durationMs > 0
			? Math.min(100, Math.round((session.progressMs / session.durationMs) * 100))
			: null;

	return (
		<li className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/40 p-2.5">
			<StateIcon
				className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
				aria-label={paused ? "paused" : "playing"}
			/>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-foreground">{title}</p>
				<p className="truncate text-xs text-muted-foreground">
					{user}
					{player ? ` · ${player}` : ""}
				</p>
				{pct !== null && (
					<div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted/30">
						<div
							className="h-full rounded-full bg-muted-foreground/50"
							style={{ width: `${pct}%` }}
						/>
					</div>
				)}
			</div>
			{isTranscode && (
				<span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
					<Zap className="h-3 w-3" aria-hidden="true" />
					Transcode
				</span>
			)}
			<button
				type="button"
				onClick={() => onKill(session)}
				aria-label={`Terminate session: ${title}`}
				className="flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-red-500/50 hover:text-red-400"
			>
				<Ban className="h-3.5 w-3.5" aria-hidden="true" />
				Kill
			</button>
		</li>
	);
}

export function LiveSessionsCard() {
	const servicesQuery = useServicesQuery();
	const [incognito] = useIncognitoMode();
	const [selected, setSelected] = useState<TracearrLiveSession | null>(null);
	const hasTracearr = (servicesQuery.data ?? []).some(
		(s) => s.service.toLowerCase() === "tracearr" && s.enabled,
	);

	// Query is gated on Tracearr being configured — no polling for users who
	// haven't wired it up.
	const query = useTracearrLiveSessions({ enabled: hasTracearr });

	// Service gating: omit the card entirely (no empty shell) when Tracearr
	// isn't configured — same omission rule as the domain tiles.
	if (!hasTracearr) {
		return null;
	}

	const data = query.data;
	const unreachableCount = data?.instances.filter((i) => !i.reachable).length ?? 0;
	const sessions = data?.sessions ?? [];
	const shown = sessions.slice(0, SESSION_ROW_CAP);
	const overflow = sessions.length - shown.length;

	// The dialog needs the display strings for the currently-selected session.
	const selectedMasked = selected ? maskSession(selected, incognito) : null;

	return (
		<section
			className="rounded-xl border border-border/50 bg-card/30 p-4 backdrop-blur-sm animate-in fade-in slide-in-from-bottom-2"
			aria-label="Tracearr live sessions"
			data-testid="live-sessions-card"
		>
			<header className="mb-3 flex items-center gap-2">
				<MonitorPlay className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
					Live Sessions
				</h2>
				<span className="text-xs text-muted-foreground">Tracearr</span>
			</header>

			<AsyncStateView
				isLoading={query.isLoading}
				isError={query.isError}
				error={query.error}
				onRetry={() => void query.refetch()}
				errorTitle="Couldn't reach Tracearr"
				loadingFallback={<div className="h-16 animate-pulse rounded-lg bg-muted/10" />}
				// isEmpty is never set: the zero-streams case renders inline as a
				// "0 active streams" headline (a reachable-but-idle signal, more
				// informative than a generic placeholder). emptyState is required by
				// the prop type but stays dormant.
				emptyState={{
					icon: MonitorPlay,
					title: "No active streams",
					description: "Nothing is playing across your media servers right now.",
				}}
			>
				{data?.summary === null ? (
					// Configured but nothing reachable — honest, not a fake zero.
					<p className="text-sm text-muted-foreground" data-testid="live-sessions-unreachable">
						Tracearr is unreachable right now — live session data will return once it is back.
					</p>
				) : data?.summary ? (
					<div className="space-y-3" data-testid="live-sessions-summary">
						<div className="flex items-baseline gap-2">
							<span className="text-3xl font-semibold tabular-nums text-foreground">
								{data.summary.total}
							</span>
							<span className="text-sm text-muted-foreground">
								{data.summary.total === 1 ? "active stream" : "active streams"}
							</span>
						</div>

						{data.summary.total > 0 && (
							<div className="flex flex-wrap gap-x-6 gap-y-2">
								<div className="flex items-center gap-1.5">
									<Zap className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
									<Stat label="Transcoding" value={data.summary.transcodes} />
								</div>
								<Stat
									label="Direct"
									value={data.summary.directStreams + data.summary.directPlays}
								/>
								{data.summary.totalBitrate && (
									<div className="flex items-center gap-1.5">
										<AudioLines className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
										<Stat label="Bandwidth" value={data.summary.totalBitrate} />
									</div>
								)}
							</div>
						)}

						{shown.length > 0 && (
							<ul className="space-y-2" data-testid="live-sessions-rows">
								{shown.map((session) => (
									<SessionRow
										key={`${session.instanceId}:${session.id}`}
										session={session}
										incognito={incognito}
										onKill={setSelected}
									/>
								))}
							</ul>
						)}

						{overflow > 0 && (
							<p className="text-xs text-muted-foreground" data-testid="live-sessions-overflow">
								+{overflow} more session{overflow === 1 ? "" : "s"} not shown
							</p>
						)}

						{unreachableCount > 0 && (
							// Partial aggregate — disclose that a count is incomplete rather
							// than silently under-reporting.
							<p className="text-xs text-muted-foreground" data-testid="live-sessions-partial">
								{unreachableCount} Tracearr{" "}
								{unreachableCount === 1 ? "instance is" : "instances are"} unreachable; the count
								above may be incomplete.
							</p>
						)}
					</div>
				) : null}
			</AsyncStateView>

			{selected && selectedMasked && (
				<TerminateSessionDialog
					session={selected}
					title={selectedMasked.title}
					user={selectedMasked.user}
					serverName={selectedMasked.serverName}
					onClose={() => setSelected(null)}
				/>
			)}
		</section>
	);
}
