"use client";

import type {
	QuiAction,
	QuiActionLogEntry,
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
	Webhook,
	Wrench,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	GlassmorphicCard,
	PremiumEmptyState,
	PremiumPageHeader,
	PremiumPageLoading,
} from "../../../components/layout";
import { Alert, AlertDescription, Button } from "../../../components/ui";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import { useQuiStreamStatus } from "../../../contexts/QuiStreamContext";
import {
	type QuiEventStreamStatus,
	useQuiActionLog,
	useQuiActivityFeed,
	useQuiEventLog,
} from "../../../hooks/api/useQui";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName } from "../../../lib/incognito";
import { cn } from "../../../lib/utils";
import { QuiWebhookConfigPanel } from "./webhook-config-panel";

type FilterId = "all" | "qui_sync_complete" | "qui_backfill_complete";

const FILTER_LABELS: Record<FilterId, string> = {
	all: "All events",
	qui_sync_complete: "Torrent-state sync",
	qui_backfill_complete: "InfoHash backfill",
};

// Read from `severity` (canonical). `status` is still emitted by the
// backend as a deprecated alias for one release window — see schema notes.
type ActivitySeverity = "ok" | "warn" | "error";

const SEVERITY_TONE: Record<ActivitySeverity, string> = {
	ok: "text-emerald-300 border-emerald-500/30 bg-emerald-500/5",
	warn: "text-amber-300 border-amber-500/30 bg-amber-500/5",
	error: "text-red-300 border-red-500/30 bg-red-500/5",
};

const SEVERITY_ICON: Record<ActivitySeverity, typeof Activity> = {
	ok: CheckCircle2,
	warn: AlertCircle,
	error: AlertCircle,
};

function resolveSeverity(event: QuiActivityEvent): ActivitySeverity {
	// `severity` is the canonical field; `status` is the deprecated alias.
	// Read both during the transition window so an older API still works.
	return event.severity ?? event.status ?? "ok";
}

type TopTab = "activity" | "actions" | "events" | "webhook";

const TAB_LABELS: Record<TopTab, string> = {
	activity: "Activity feed",
	actions: "My Actions",
	events: "My Events",
	webhook: "Webhook",
};

/**
 * One-line description per tab — surfaces above the tab content so the
 * three "log" tabs (Activity feed / My Actions / My Events) read as
 * distinct surfaces instead of looking interchangeable. Without these
 * captions, operators bounce between tabs trying to figure out which
 * one contains the data they're looking for.
 *
 * The three logs differ by WHO created the row:
 *   - Activity feed  → arr-dashboard's schedulers (sync ticks, gate firings)
 *   - My Actions     → operator-initiated mutations through this dashboard
 *   - My Events      → qui's webhook receiver (qui pushed it to us)
 */
const TAB_DESCRIPTIONS: Record<TopTab, string> = {
	activity:
		"Observed events emitted by arr-dashboard's own schedulers — every 10-minute torrent-state sync and every 6-hour infoHash backfill writes a row here.",
	actions:
		"Tamper-evident audit log of mutations arr-dashboard initiated against qui on your behalf — pause, resume, recheck, reannounce, setTags. One row per (action, info-hash).",
	events:
		"Inbound webhook events qui POSTed to arr-dashboard. Distinct from Activity feed (which is our own scheduler output) and My Actions (which is what WE asked qui to do). Requires the Webhook tab to be configured.",
	webhook:
		"Rotate the secret + auto-register arr-dashboard as a NotificationTarget inside qui so torrent state changes push here in real time, instead of the 10-minute polled fallback.",
};

/**
 * qui Activity surface — two tabs:
 *   1. **Activity feed** (Phase 3.2) — observed qui-related events emitted
 *      by background schedulers and gate firings.
 *   2. **My Actions** (Phase 4.1) — every mutation arr-dashboard initiated
 *      against qui on the operator's behalf. Separate tab because the
 *      audit-log surface has different filtering needs (action vs status)
 *      and refresh semantics (operator-driven, not scheduler-driven).
 */
export const QuiActivityClient = () => {
	const [tab, setTab] = useState<TopTab>("activity");

	// Phase 5.2 — the EventSource itself lives at the app root via
	// `QuiStreamProvider`. We just read its status here so the operator
	// sees the "Live channel offline" pill on this surface when the push
	// channel is broken (the page is the natural home for it because
	// that's where they'd come to debug "why isn't my data updating").
	const { streamStatus, isActive } = useQuiStreamStatus();

	return (
		<>
			<PremiumPageHeader
				label="qui Integration"
				labelIcon={History}
				title="qui Activity"
				gradientTitle
				description="Chronological feed of every qui-related operation arr-dashboard has performed for you — scheduler ticks, gate firings, and (now) audited mutations from your actions."
			/>

			{/* Only render the badge when the stream is supposed to be active
			 * for this user. If they have no qui instance configured at all,
			 * `isActive` is false → no badge → no misleading "offline" pill. */}
			{isActive ? <StreamStatusBadge status={streamStatus} /> : null}

			<div
				className="mb-3 flex items-center gap-2 flex-wrap"
				role="tablist"
				aria-label="qui activity tabs"
			>
				{(Object.keys(TAB_LABELS) as TopTab[]).map((id) => (
					<button
						type="button"
						key={id}
						role="tab"
						aria-selected={tab === id}
						onClick={() => setTab(id)}
						className={cn(
							"text-sm font-medium px-4 py-2 rounded-lg border transition-colors",
							tab === id
								? "border-foreground/40 bg-foreground/10 text-foreground"
								: "border-border/40 bg-card/20 text-muted-foreground hover:text-foreground",
						)}
					>
						{TAB_LABELS[id]}
					</button>
				))}
			</div>

			{/* Per-tab caption — orients the operator on WHICH log they're
			 * looking at. The three logs are easy to confuse without it. */}
			<p className="mb-6 text-xs text-muted-foreground max-w-3xl">{TAB_DESCRIPTIONS[tab]}</p>

			{tab === "activity" ? (
				<ActivityFeedView />
			) : tab === "actions" ? (
				<MyActionsView />
			) : tab === "events" ? (
				<MyEventsView />
			) : (
				<QuiWebhookConfigPanel />
			)}
		</>
	);
};

// ── Stream status pill (Phase 5.2) ─────────────────────────────────────

/**
 * Small "Live channel" pill that tells the operator whether SSE push is
 * working. Without this signal, a downed API or expired session would
 * leave the page silently stale (the browser auto-retries EventSource
 * forever, but the UI gives no indication).
 *
 * The pill is invisible while the connection is healthy ("open"); it
 * only surfaces during connecting/offline so it doesn't add noise to
 * the page chrome in the steady state.
 */
const StreamStatusBadge = ({ status }: { status: QuiEventStreamStatus }) => {
	if (status === "open") return null;
	const tone =
		status === "offline"
			? "border-amber-500/40 bg-amber-500/10 text-amber-300"
			: "border-border/40 bg-card/30 text-muted-foreground";
	const copy =
		status === "offline"
			? "Live channel offline — using polling fallback"
			: "Connecting to live channel…";
	return (
		<div
			className={cn(
				"mb-4 inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs",
				tone,
			)}
		>
			<span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
			{copy}
		</div>
	);
};

// ── My Events (Phase 5.1) ──────────────────────────────────────────────

const MyEventsView = () => {
	const feed = useQuiEventLog({ limit: 50 });
	const entries = useMemo(() => feed.data?.pages.flatMap((p) => p.entries) ?? [], [feed.data]);

	if (feed.isLoading) {
		return <PremiumPageLoading cardCount={4} />;
	}

	if (feed.isError) {
		return (
			<Alert variant="danger">
				<AlertDescription>
					Failed to load webhook events: {getErrorMessage(feed.error)}
				</AlertDescription>
			</Alert>
		);
	}

	if (entries.length === 0) {
		return (
			<PremiumEmptyState
				icon={Webhook}
				title="No webhook events yet"
				description="Once qui is registered as a NotificationTarget (see Webhook tab), inbound events will appear here within seconds — proving the push pipeline works end-to-end."
			/>
		);
	}

	return (
		<>
			<div className="mb-4 flex items-center justify-end">
				<Button variant="secondary" onClick={() => feed.refetch()} disabled={feed.isFetching}>
					<RefreshCw
						className={cn("mr-2 h-4 w-4", feed.isFetching ? "animate-spin" : "")}
						aria-hidden
					/>
					Refresh
				</Button>
			</div>

			<ul className="space-y-2">
				{entries.map((entry, idx) => (
					<EventLogRow key={entry.id} entry={entry} animationDelay={Math.min(idx, 12) * 30} />
				))}
			</ul>

			{feed.hasNextPage ? (
				<LoadMoreButton
					isLoading={feed.isFetchingNextPage}
					onClick={() => void feed.fetchNextPage()}
					label="Load older events"
				/>
			) : null}
		</>
	);
};

interface EventLogRowProps {
	entry: {
		id: string;
		eventType: string;
		torrentHash: string | null;
		serviceInstanceId: string | null;
		receivedAt: string;
	};
	animationDelay: number;
}

const EventLogRow = ({ entry, animationDelay }: EventLogRowProps) => {
	const [isIncognito] = useIncognitoMode();
	const instance = isIncognito
		? getLinuxInstanceName(entry.serviceInstanceId ?? "")
		: (entry.serviceInstanceId ?? "—");

	return (
		<li>
			<GlassmorphicCard padding="sm" animationDelay={animationDelay}>
				<div className="flex items-start gap-3">
					<div
						className="flex-shrink-0 mt-0.5 rounded-full p-1.5 border text-blue-300 border-blue-500/30 bg-blue-500/5"
						aria-hidden
					>
						<Webhook className="h-3.5 w-3.5" />
					</div>
					<div className="flex-1 min-w-0">
						<div className="flex items-baseline justify-between gap-3 flex-wrap">
							<span className="text-sm font-medium text-foreground">
								{entry.eventType} · <span className="text-muted-foreground">{instance}</span>
							</span>
							<time
								className="text-xs text-muted-foreground"
								dateTime={entry.receivedAt}
								title={new Date(entry.receivedAt).toLocaleString()}
							>
								{formatRelative(entry.receivedAt)}
							</time>
						</div>
						{entry.torrentHash ? (
							<div className="mt-1 text-xs text-muted-foreground font-mono break-all">
								{shortenHash(entry.torrentHash)}
							</div>
						) : null}
					</div>
				</div>
			</GlassmorphicCard>
		</li>
	);
};

// ── Activity feed (Phase 3.2) ──────────────────────────────────────────

const ActivityFeedView = () => {
	const [filter, setFilter] = useState<FilterId>("all");
	const feed = useQuiActivityFeed(filter === "all" ? undefined : filter, 50);
	const events = useMemo(() => feed.data?.pages.flatMap((p) => p.events) ?? [], [feed.data]);

	if (feed.isLoading) {
		return <PremiumPageLoading cardCount={4} />;
	}

	return (
		<>
			<div className="mb-4 flex items-center gap-2 flex-wrap">
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
				<Button
					variant="secondary"
					className="ml-auto"
					onClick={() => feed.refetch()}
					disabled={feed.isFetching}
				>
					<RefreshCw
						className={cn("mr-2 h-4 w-4", feed.isFetching ? "animate-spin" : "")}
						aria-hidden
					/>
					Refresh
				</Button>
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
						<LoadMoreButton
							isLoading={feed.isFetchingNextPage}
							onClick={() => void feed.fetchNextPage()}
							label="Load older events"
						/>
					) : null}
				</>
			)}
		</>
	);
};

// ── My Actions (Phase 4.1) ─────────────────────────────────────────────

// Derive the filter union from the canonical wire enum so adding a new
// qui action (or removing one) requires updating exactly one place.
// Without this, an enum extension lands silently and the dropdown's
// `Record` keeps a stale value the route would 400 on.
type ActionFilterId = QuiAction | "all";
type StatusFilterId = "all" | "pending" | "success" | "failed";

const ACTION_LABELS: Record<ActionFilterId, string> = {
	all: "All actions",
	pause: "Pause",
	resume: "Resume",
	recheck: "Recheck",
	reannounce: "Reannounce",
	setTags: "Set tags",
	setCategory: "Set category",
	toggleAutoTMM: "Toggle ATM",
	forceStart: "Force start",
	setUploadLimit: "Set upload limit",
	setDownloadLimit: "Set download limit",
	setShareLimit: "Set share limit",
	setLocation: "Set location",
	delete: "Delete",
};

const STATUS_LABELS: Record<StatusFilterId, string> = {
	all: "All statuses",
	pending: "Pending",
	success: "Success",
	failed: "Failed",
};

const ACTION_STATUS_TONE: Record<QuiActionLogEntry["status"], string> = {
	pending: "text-blue-300 border-blue-500/30 bg-blue-500/5",
	success: "text-emerald-300 border-emerald-500/30 bg-emerald-500/5",
	failed: "text-red-300 border-red-500/30 bg-red-500/5",
};

const ACTION_STATUS_ICON: Record<QuiActionLogEntry["status"], typeof Activity> = {
	pending: Loader2,
	success: CheckCircle2,
	failed: XCircle,
};

const MyActionsView = () => {
	const [actionFilter, setActionFilter] = useState<ActionFilterId>("all");
	const [statusFilter, setStatusFilter] = useState<StatusFilterId>("all");

	const feed = useQuiActionLog({
		action: actionFilter === "all" ? undefined : actionFilter,
		status: statusFilter === "all" ? undefined : statusFilter,
	});

	const entries = useMemo(() => feed.data?.pages.flatMap((p) => p.entries) ?? [], [feed.data]);

	if (feed.isLoading) {
		return <PremiumPageLoading cardCount={4} />;
	}

	return (
		<>
			<div className="mb-4 flex items-center gap-2 flex-wrap">
				<select
					value={actionFilter}
					onChange={(e) => setActionFilter(e.target.value as ActionFilterId)}
					className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border/40 bg-card/20 text-foreground"
					aria-label="Filter by action"
				>
					{(Object.keys(ACTION_LABELS) as ActionFilterId[]).map((id) => (
						<option key={id} value={id}>
							{ACTION_LABELS[id]}
						</option>
					))}
				</select>
				<select
					value={statusFilter}
					onChange={(e) => setStatusFilter(e.target.value as StatusFilterId)}
					className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border/40 bg-card/20 text-foreground"
					aria-label="Filter by status"
				>
					{(Object.keys(STATUS_LABELS) as StatusFilterId[]).map((id) => (
						<option key={id} value={id}>
							{STATUS_LABELS[id]}
						</option>
					))}
				</select>
				<Button
					variant="secondary"
					className="ml-auto"
					onClick={() => feed.refetch()}
					disabled={feed.isFetching}
				>
					<RefreshCw
						className={cn("mr-2 h-4 w-4", feed.isFetching ? "animate-spin" : "")}
						aria-hidden
					/>
					Refresh
				</Button>
			</div>

			{feed.isError ? (
				<Alert variant="danger">
					<AlertDescription>
						Failed to load action log: {getErrorMessage(feed.error)}
					</AlertDescription>
				</Alert>
			) : entries.length === 0 ? (
				<PremiumEmptyState
					icon={Wrench}
					title="No torrent actions yet"
					description="When you pause, resume, recheck, or reannounce a torrent from arr-dashboard, the audit entry will appear here — including the qui instance, the info hash, and any error message qui returned."
				/>
			) : (
				<>
					<ul className="space-y-2">
						{entries.map((entry, idx) => (
							<ActionRow key={entry.id} entry={entry} animationDelay={Math.min(idx, 12) * 30} />
						))}
					</ul>

					{feed.hasNextPage ? (
						<LoadMoreButton
							isLoading={feed.isFetchingNextPage}
							onClick={() => void feed.fetchNextPage()}
							label="Load older actions"
						/>
					) : null}
				</>
			)}
		</>
	);
};

const LoadMoreButton = ({
	isLoading,
	onClick,
	label,
}: {
	isLoading: boolean;
	onClick: () => void;
	label: string;
}) => (
	<div className="mt-6 flex justify-center">
		<Button variant="secondary" onClick={onClick} disabled={isLoading}>
			{isLoading ? (
				<>
					<Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Loading…
				</>
			) : (
				<>
					{label} <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
				</>
			)}
		</Button>
	</div>
);

interface ActionRowProps {
	entry: QuiActionLogEntry;
	animationDelay: number;
}

const ActionRow = ({ entry, animationDelay }: ActionRowProps) => {
	const [isIncognito] = useIncognitoMode();
	const StatusIcon = ACTION_STATUS_ICON[entry.status];
	// Incognito guidance per CLAUDE.md rule 6 — anonymize the qui instance
	// label so screenshots don't leak operator setups. The hash is already
	// pseudo-anonymous (no PII), but instance labels can be personal.
	const instanceLabel = isIncognito
		? getLinuxInstanceName(entry.serviceInstanceLabel)
		: entry.serviceInstanceLabel;
	const tags = readTags(entry.payload);

	return (
		<li>
			<GlassmorphicCard padding="sm" animationDelay={animationDelay}>
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"flex-shrink-0 mt-0.5 rounded-full p-1.5 border",
							ACTION_STATUS_TONE[entry.status],
						)}
						aria-hidden
					>
						<StatusIcon
							className={cn("h-3.5 w-3.5", entry.status === "pending" ? "animate-spin" : "")}
						/>
					</div>
					<div className="flex-1 min-w-0">
						<div className="flex items-baseline justify-between gap-3 flex-wrap">
							<span className="text-sm font-medium text-foreground">
								{ACTION_LABELS[entry.action as ActionFilterId] ?? entry.action} ·{" "}
								<span className="text-muted-foreground">{instanceLabel}</span>
							</span>
							<time
								className="text-xs text-muted-foreground"
								dateTime={entry.requestedAt}
								title={new Date(entry.requestedAt).toLocaleString()}
							>
								{formatRelative(entry.requestedAt)}
							</time>
						</div>
						<div className="mt-1 text-xs text-muted-foreground font-mono break-all">
							{shortenHash(entry.torrentHash)}
							{tags ? <span className="ml-2 font-sans">tags: {tags}</span> : null}
						</div>
						{entry.status === "failed" && entry.error ? (
							<div className="mt-1 text-xs text-red-300">{entry.error}</div>
						) : null}
					</div>
				</div>
			</GlassmorphicCard>
		</li>
	);
};

function shortenHash(hash: string): string {
	if (hash.length <= 16) return hash;
	return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

function readTags(payload: unknown): string | null {
	if (
		payload &&
		typeof payload === "object" &&
		"tags" in payload &&
		typeof (payload as Record<string, unknown>).tags === "string"
	) {
		return (payload as { tags: string }).tags;
	}
	return null;
}

interface EventRowProps {
	event: QuiActivityEvent;
	animationDelay: number;
}

const EventRow = ({ event, animationDelay }: EventRowProps) => {
	const severity = resolveSeverity(event);
	const StatusIcon = SEVERITY_ICON[severity];
	const title = describeEvent(event);
	const summary = summarizeEvent(event);

	return (
		<li>
			<GlassmorphicCard padding="sm" animationDelay={animationDelay}>
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"flex-shrink-0 mt-0.5 rounded-full p-1.5 border",
							SEVERITY_TONE[severity],
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
