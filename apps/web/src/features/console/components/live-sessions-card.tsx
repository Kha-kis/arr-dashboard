"use client";

/**
 * Operator Console — Tracearr live-session card (charter §2.1, Tracearr-2).
 *
 * A cross-server aggregate of what's playing RIGHT NOW, from Tracearr (which
 * itself unifies Plex/Jellyfin/Emby). Complementary to the dashboard's
 * per-server NowPlayingWidget: this is the operator's single at-a-glance
 * "how loaded is my stack, and how much is transcoding" signal.
 *
 * Trust rules enforced at render:
 * - Service-gated: renders nothing unless the user has an enabled Tracearr
 *   instance (the query is also disabled, so no polling for non-users).
 * - Exact counts only — the numbers come straight from Tracearr's summary,
 *   never a proxy or estimate.
 * - Unreachable ≠ zero: when Tracearr can't be reached we say so, rather
 *   than showing a misleading "0 active".
 * - Aggregate-only: no titles/usernames are shown, so there is no incognito
 *   surface here. Per-session detail (with incognito) lands with the
 *   kill-session action in Tracearr-3.
 */

import { AudioLines, MonitorPlay, Zap } from "lucide-react";
import { AsyncStateView } from "../../../components/layout";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useTracearrLiveSessions } from "../../../hooks/api/useTracearr";

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="flex flex-col">
			<span className="text-lg font-semibold tabular-nums text-foreground">{value}</span>
			<span className="text-xs text-muted-foreground">{label}</span>
		</div>
	);
}

export function LiveSessionsCard() {
	const servicesQuery = useServicesQuery();
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
		</section>
	);
}
