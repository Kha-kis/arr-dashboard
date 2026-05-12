"use client";

import type {
	QuiActivityEvent,
	QuiBackfillCompleteDetails,
	QuiSyncCompleteDetails,
} from "@arr/shared";
import {
	type Activity,
	AlertCircle,
	ArrowRight,
	CheckCircle2,
	Database,
	History,
	Loader2,
	RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	GlassmorphicCard,
	PremiumEmptyState,
	PremiumPageHeader,
	PremiumPageLoading,
} from "../../../components/layout";
import { Alert, AlertDescription, Button } from "../../../components/ui";
import { useQuiActivityFeed } from "../../../hooks/api/useQui";
import { getErrorMessage } from "../../../lib/error-utils";
import { cn } from "../../../lib/utils";

type FilterId = "all" | "qui_sync_complete" | "qui_backfill_complete";

const FILTER_LABELS: Record<FilterId, string> = {
	all: "All events",
	qui_sync_complete: "Torrent-state sync",
	qui_backfill_complete: "InfoHash backfill",
};

const STATUS_TONE: Record<QuiActivityEvent["status"], string> = {
	ok: "text-emerald-300 border-emerald-500/30 bg-emerald-500/5",
	warn: "text-amber-300 border-amber-500/30 bg-amber-500/5",
	error: "text-red-300 border-red-500/30 bg-red-500/5",
};

const STATUS_ICON: Record<QuiActivityEvent["status"], typeof Activity> = {
	ok: CheckCircle2,
	warn: AlertCircle,
	error: AlertCircle,
};

/**
 * qui Activity feed (Phase 3.2).
 *
 * Renders a chronological timeline of qui-related events arr-dashboard
 * has emitted: scheduler runs, gate firings, and (in future phases)
 * mutation audits and webhook-pushed events from qui.
 */
export const QuiActivityClient = () => {
	const [filter, setFilter] = useState<FilterId>("all");
	const feed = useQuiActivityFeed(filter === "all" ? undefined : filter, 50);

	const events = useMemo(() => feed.data?.pages.flatMap((p) => p.events) ?? [], [feed.data]);

	if (feed.isLoading) {
		return <PremiumPageLoading showHeader cardCount={4} />;
	}

	return (
		<>
			<PremiumPageHeader
				label="qui Integration"
				labelIcon={History}
				title="qui Activity"
				gradientTitle
				description="Chronological feed of every qui-related operation arr-dashboard has performed for you — scheduler ticks, gate firings, and (later) audited actions + qui-pushed events."
				actions={
					<Button variant="secondary" onClick={() => feed.refetch()} disabled={feed.isFetching}>
						<RefreshCw
							className={cn("mr-2 h-4 w-4", feed.isFetching ? "animate-spin" : "")}
							aria-hidden
						/>
						Refresh
					</Button>
				}
			/>

			<div className="mb-6 flex items-center gap-2 flex-wrap">
				{(Object.keys(FILTER_LABELS) as FilterId[]).map((id) => (
					<button
						type="button"
						key={id}
						onClick={() => setFilter(id)}
						className={cn(
							"text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors",
							filter === id
								? "border-foreground/30 bg-foreground/10 text-foreground"
								: "border-border/40 bg-card/20 text-muted-foreground hover:text-foreground",
						)}
					>
						{FILTER_LABELS[id]}
					</button>
				))}
			</div>

			{feed.isError ? (
				<Alert variant="danger">
					<AlertDescription>
						Failed to load activity: {getErrorMessage(feed.error)}
					</AlertDescription>
				</Alert>
			) : events.length === 0 ? (
				<PremiumEmptyState
					icon={History}
					title="No qui activity yet"
					description="qui-related events will appear here once the scheduled sync jobs run. The torrent-state sync runs every 10 minutes; the infoHash backfill runs every 6 hours and on startup."
				/>
			) : (
				<>
					<ul className="space-y-2">
						{events.map((event, idx) => (
							<EventRow key={event.id} event={event} animationDelay={Math.min(idx, 12) * 30} />
						))}
					</ul>

					{feed.hasNextPage ? (
						<div className="mt-6 flex justify-center">
							<Button
								variant="secondary"
								onClick={() => void feed.fetchNextPage()}
								disabled={feed.isFetchingNextPage}
							>
								{feed.isFetchingNextPage ? (
									<>
										<Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Loading…
									</>
								) : (
									<>
										Load older events <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
									</>
								)}
							</Button>
						</div>
					) : null}
				</>
			)}
		</>
	);
};

interface EventRowProps {
	event: QuiActivityEvent;
	animationDelay: number;
}

const EventRow = ({ event, animationDelay }: EventRowProps) => {
	const StatusIcon = STATUS_ICON[event.status];
	const title = describeEvent(event);
	const summary = summarizeEvent(event);

	return (
		<li>
			<GlassmorphicCard padding="sm" animationDelay={animationDelay}>
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"flex-shrink-0 mt-0.5 rounded-full p-1.5 border",
							STATUS_TONE[event.status],
						)}
						aria-hidden
					>
						<StatusIcon className="h-3.5 w-3.5" />
					</div>
					<div className="flex-1 min-w-0">
						<div className="flex items-baseline justify-between gap-3 flex-wrap">
							<span className="text-sm font-medium text-foreground">{title}</span>
							<time
								className="text-xs text-muted-foreground"
								dateTime={event.createdAt}
								title={new Date(event.createdAt).toLocaleString()}
							>
								{formatRelative(event.createdAt)}
							</time>
						</div>
						{summary ? <div className="mt-1 text-xs text-muted-foreground">{summary}</div> : null}
					</div>
				</div>
			</GlassmorphicCard>
		</li>
	);
};

function describeEvent(event: QuiActivityEvent): string {
	switch (event.eventType) {
		case "qui_sync_complete":
			return "Torrent-state sync completed";
		case "qui_backfill_complete":
			return "InfoHash backfill tick";
		default:
			return event.eventType.replace(/_/g, " ");
	}
}

function summarizeEvent(event: QuiActivityEvent): string | null {
	if (event.eventType === "qui_sync_complete") {
		const d = event.details as QuiSyncCompleteDetails | null;
		if (!d) return null;
		const parts = [
			`${d.torrentsSeen.toLocaleString()} torrents seen`,
			`${d.rowsUpdated.toLocaleString()} rows updated`,
		];
		if (d.rowsCleared > 0) parts.push(`${d.rowsCleared.toLocaleString()} stale cleared`);
		if (d.errors > 0) parts.push(`${d.errors} errors`);
		parts.push(`${Math.round(d.durationMs)}ms`);
		return parts.join(" · ");
	}
	if (event.eventType === "qui_backfill_complete") {
		const d = event.details as QuiBackfillCompleteDetails | null;
		if (!d) return null;
		const parts = [
			`${d.itemsScanned.toLocaleString()} items scanned`,
			`${d.itemsUpdated.toLocaleString()} hashed`,
		];
		if (d.itemsWithoutHash > 0) parts.push(`${d.itemsWithoutHash.toLocaleString()} without`);
		parts.push(`${Math.round(d.durationMs)}ms`);
		return parts.join(" · ");
	}
	return null;
}

function formatRelative(iso: string): string {
	const now = Date.now();
	const then = new Date(iso).getTime();
	const diffSec = Math.max(0, Math.round((now - then) / 1000));
	if (diffSec < 60) return `${diffSec}s ago`;
	if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
	if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
	return `${Math.round(diffSec / 86400)}d ago`;
}

// Suppress unused-import warning — kept because the icon set imports it
// alongside other lucide-react icons used by future event types.
void Database;
