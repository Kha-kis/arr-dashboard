"use client";

import type {
	QuiActionLogEntry,
	QuiActionStatus,
	QuiActivityEvent,
	QuiBackfillCompleteDetails,
	QuiLoggedOperation,
	QuiSyncCompleteDetails,
} from "@arr/shared";
import { QUI_ACTION_PENDING_GRACE_MS } from "@arr/shared";
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
	useQuiActionReconciliation,
	useQuiActivityFeed,
	useQuiEventLog,
} from "../../../hooks/api/useQui";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
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

	// Service-availability gate — surface a single coherent "configure
	// qui first" panel when no enabled qui instance is configured. The
	// previous behavior rendered every tab unconditionally, so an
	// unconfigured operator saw three nearly-identical empty states
	// ("qui-related events will appear here", "audit entries will
	// appear here", etc.) without any direction toward Settings. Mirror
	// the existing Webhook tab's pattern.
	const services = useServicesQuery();
	const hasEnabledQui = (services.data ?? []).some(
		(s) => s.service.toLowerCase() === "qui" && s.enabled,
	);

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

			{services.isError || (!services.isLoading && services.data === undefined) ? (
				<Alert variant="danger">
					<AlertDescription>
						qui configuration unavailable.
						{services.data !== undefined ? " Showing last-known configuration." : ""}
						<Button
							variant="secondary"
							disabled={services.isFetching}
							onClick={() => void services.refetch()}
						>
							Retry
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{services.isLoading ? (
				<PremiumPageLoading cardCount={4} />
			) : !hasEnabledQui ? (
				// Replace the tabs entirely when no qui is configured.
				// Rendering the tabs WITH the empty state above would let
				// the operator click through three identical-looking
				// "nothing here yet" panels — confusing rather than
				// directive. One clear panel pointing at Settings is
				// strictly better.
				services.isError || services.data === undefined ? null : (
					<PremiumEmptyState
						icon={Database}
						title="No qui instance configured"
						description="Add a qui service in Settings → Services to populate the Activity feed, My Actions, and My Events tabs. Once an instance is enabled, this page becomes the live feed of every qui-related operation arr-dashboard performs for you."
					/>
				)
			) : (
				<>
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
	const refresh = () => {
		// Infinite-query refetch starts at the latest page and derives older
		// cursors again, retaining known pages until the read succeeds.
		void feed.refetch();
	};

	if (feed.isLoading) {
		return <PremiumPageLoading cardCount={4} />;
	}

	return (
		<>
			{feed.isError ? (
				<Alert variant="danger">
					<AlertDescription>
						Failed to load webhook events: {getErrorMessage(feed.error)}
						{entries.length > 0 ? " Showing last-known events." : ""}
						<Button variant="secondary" disabled={feed.isFetching} onClick={refresh}>
							Retry
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			<div className="mb-4 flex items-center justify-end">
				<Button variant="secondary" onClick={refresh} disabled={feed.isFetching}>
					<RefreshCw
						className={cn("mr-2 h-4 w-4", feed.isFetching ? "animate-spin" : "")}
						aria-hidden
					/>
					Refresh
				</Button>
			</div>

			{entries.length === 0 && !feed.isError ? (
				<PremiumEmptyState
					icon={Webhook}
					title="No webhook events yet"
					description="No retained inbound webhook events are available. Configure the receiver in the Webhook tab to receive events."
				/>
			) : null}

			{entries.length > 0 ? (
				<ul className="space-y-2">
					{entries.map((entry, idx) => (
						<EventLogRow key={entry.id} entry={entry} animationDelay={Math.min(idx, 12) * 30} />
					))}
				</ul>
			) : null}

			{feed.hasNextPage && !feed.isError ? (
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
		serviceInstanceLabel?: string | null;
		receivedAt: string;
	};
	animationDelay: number;
}

/**
 * Map event types to a severity tone. The classification is heuristic
 * (qui's event-type vocabulary isn't a closed enum), so the default
 * is the neutral "info" tone — only events whose name clearly signals
 * a problem get tinted. Future event types added by qui fall through
 * to neutral until someone classifies them here.
 */
function eventTypeSeverity(eventType: string): "info" | "warn" | "error" {
	const lower = eventType.toLowerCase();
	if (
		lower.includes("error") ||
		lower.includes("failed") ||
		lower.includes("dropped") ||
		lower.includes("unreachable")
	) {
		return "error";
	}
	if (
		lower.includes("warn") ||
		lower.includes("stalled") ||
		lower.includes("retry") ||
		lower.includes("tracker_problem")
	) {
		return "warn";
	}
	return "info";
}

const EVENT_SEVERITY_TONE: Record<"info" | "warn" | "error", string> = {
	info: "text-blue-300 border-blue-500/30 bg-blue-500/5",
	warn: "text-amber-300 border-amber-500/30 bg-amber-500/5",
	error: "text-red-300 border-red-500/30 bg-red-500/5",
};

const EventLogRow = ({ entry, animationDelay }: EventLogRowProps) => {
	const [isIncognito] = useIncognitoMode();
	// Prefer the human-readable label hydrated server-side. Falls back
	// through the id (for older payloads pre-CR1) and finally "—" so
	// the row always shows SOMETHING in the instance slot.
	const instanceRaw = entry.serviceInstanceLabel ?? entry.serviceInstanceId ?? "—";
	const instance = isIncognito ? getLinuxInstanceName(instanceRaw) : instanceRaw;
	const severity = eventTypeSeverity(entry.eventType);

	return (
		<li>
			<GlassmorphicCard padding="sm" animationDelay={animationDelay}>
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"flex-shrink-0 mt-0.5 rounded-full p-1.5 border",
							EVENT_SEVERITY_TONE[severity],
						)}
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
type ActionFilterId = QuiLoggedOperation | "all";
type StatusFilterId = "all" | QuiActionStatus;

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
	topPriority: "Move to top",
	bottomPriority: "Move to bottom",
	increasePriority: "Increase priority",
	decreasePriority: "Decrease priority",
	toggleSequentialDownload: "Toggle sequential download",
	setUploadLimit: "Set upload limit",
	setDownloadLimit: "Set download limit",
	setShareLimit: "Set share limit",
	setLocation: "Set location",
	delete: "Delete",
	renameTorrent: "Rename torrent",
	addTrackers: "Add trackers",
	removeTrackers: "Remove trackers",
	editTracker: "Edit tracker",
};

const STATUS_LABELS: Record<StatusFilterId, string> = {
	all: "All statuses",
	pending: "Pending",
	success: "Success",
	failed: "Failed",
	uncertain: "Needs review",
	operator_verified_applied: "Verified applied",
	operator_verified_not_applied: "Verified not applied",
};

const ACTION_STATUS_TONE: Record<QuiActionLogEntry["status"], string> = {
	pending: "text-blue-300 border-blue-500/30 bg-blue-500/5",
	success: "text-emerald-300 border-emerald-500/30 bg-emerald-500/5",
	failed: "text-red-300 border-red-500/30 bg-red-500/5",
	uncertain: "text-amber-300 border-amber-500/30 bg-amber-500/5",
	operator_verified_applied: "text-sky-300 border-sky-500/30 bg-sky-500/5",
	operator_verified_not_applied: "text-sky-300 border-sky-500/30 bg-sky-500/5",
};

const ACTION_STATUS_ICON: Record<QuiActionLogEntry["status"], typeof Activity> = {
	pending: AlertCircle,
	success: CheckCircle2,
	failed: XCircle,
	uncertain: AlertCircle,
	operator_verified_applied: CheckCircle2,
	operator_verified_not_applied: CheckCircle2,
};

const MyActionsView = () => {
	const [actionFilter, setActionFilter] = useState<ActionFilterId>("all");
	const [statusFilter, setStatusFilter] = useState<StatusFilterId>("all");

	const feed = useQuiActionLog({
		action: actionFilter === "all" ? undefined : actionFilter,
		status: statusFilter === "all" ? undefined : statusFilter,
	});
	const reconciliation = useQuiActionReconciliation();
	const resolveAction = (actionLogId: string, decision: "applied" | "not_applied") => {
		const outcome = decision === "applied" ? "applied" : "not applied";
		if (
			!window.confirm(
				`Only continue after checking this exact torrent in qUI and verifying the action was ${outcome}. If you cannot verify it, cancel and leave the action held. This records your judgment, not a qUI-confirmed result.`,
			)
		) {
			return;
		}
		reconciliation.mutate({ actionLogId, decision });
	};

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
					description="When you act on a torrent from arr-dashboard, its audit entry appears here. Interrupted actions remain held until their outcome is verified."
				/>
			) : (
				<>
					{reconciliation.isError ? (
						<Alert variant="danger">
							<AlertDescription>
								Could not resolve this action. Refresh the log and verify its state before trying
								again.
							</AlertDescription>
						</Alert>
					) : null}
					<ul className="space-y-2">
						{entries.map((entry, idx) => (
							<ActionRow
								key={entry.id}
								entry={entry}
								animationDelay={Math.min(idx, 12) * 30}
								onResolve={resolveAction}
								isResolving={
									reconciliation.isPending && reconciliation.variables?.actionLogId === entry.id
								}
							/>
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
	onResolve: (actionLogId: string, decision: "applied" | "not_applied") => void;
	isResolving: boolean;
}

const ActionRow = ({ entry, animationDelay, onResolve, isResolving }: ActionRowProps) => {
	const [isIncognito] = useIncognitoMode();
	const [showFullHash, setShowFullHash] = useState(false);
	const StatusIcon = ACTION_STATUS_ICON[entry.status];
	// Incognito guidance per AGENTS.md — anonymize the qui instance
	// label so screenshots don't leak operator setups. The hash is already
	// pseudo-anonymous (no PII), but instance labels can be personal.
	const instanceLabel = isIncognito
		? getLinuxInstanceName(entry.serviceInstanceLabel)
		: entry.serviceInstanceLabel;
	const tags = readTags(entry.payload);
	const trackerCount = readTrackerCount(entry.payload);
	const canResolve =
		(entry.status === "pending" || entry.status === "uncertain") &&
		Date.now() - new Date(entry.requestedAt).getTime() >= QUI_ACTION_PENDING_GRACE_MS;

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
						<StatusIcon className="h-3.5 w-3.5" />
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
							{showFullHash ? entry.torrentHash : shortenHash(entry.torrentHash)}
							{tags ? <span className="ml-2 font-sans">tags: {tags}</span> : null}
							{trackerCount !== null ? (
								<span className="ml-2 font-sans">
									{trackerCount} tracker{trackerCount === 1 ? "" : "s"}
								</span>
							) : null}
						</div>
						{entry.action === "renameTorrent" ||
						entry.action === "addTrackers" ||
						entry.action === "removeTrackers" ||
						entry.action === "editTracker" ? (
							<p className="mt-1 text-xs text-muted-foreground">
								Exact names and announce URLs are not retained in the action history.
							</p>
						) : null}
						{entry.status === "pending" || entry.status === "uncertain" ? (
							<button
								type="button"
								className="mt-1 text-xs text-sky-300 underline"
								onClick={() => setShowFullHash((shown) => !shown)}
								aria-expanded={showFullHash}
							>
								{showFullHash ? "Hide full info hash" : "Show full info hash for verification"}
							</button>
						) : null}
						{entry.status === "failed" && entry.error ? (
							<div className="mt-1 text-xs text-red-300">{entry.error}</div>
						) : null}
						{entry.status === "pending" || entry.status === "uncertain" ? (
							<div className="mt-2 space-y-2 text-xs text-amber-200">
								<p>
									Outcome not confirmed. This torrent is held against further dashboard actions.
									Check the exact torrent and action in qUI; if unsure, leave it held. Recent
									requests cannot be resolved until the in-flight grace period ends; refresh this
									log if it remains pending.
								</p>
								{canResolve ? (
									<div className="flex flex-wrap gap-2">
										<Button
											variant="secondary"
											disabled={isResolving}
											onClick={() => onResolve(entry.id, "applied")}
										>
											Verified applied
										</Button>
										<Button
											variant="secondary"
											disabled={isResolving}
											onClick={() => onResolve(entry.id, "not_applied")}
										>
											Verified not applied
										</Button>
									</div>
								) : null}
							</div>
						) : null}
						{entry.status === "operator_verified_applied" ||
						entry.status === "operator_verified_not_applied" ? (
							<p className="mt-2 text-xs text-sky-300">
								Operator-verified outcome; qUI did not confirm the original request.
							</p>
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

function readTrackerCount(payload: unknown): number | null {
	if (
		payload &&
		typeof payload === "object" &&
		"trackerCount" in payload &&
		typeof (payload as Record<string, unknown>).trackerCount === "number" &&
		Number.isInteger((payload as { trackerCount: number }).trackerCount) &&
		(payload as { trackerCount: number }).trackerCount >= 1 &&
		(payload as { trackerCount: number }).trackerCount <= 50
	) {
		return (payload as { trackerCount: number }).trackerCount;
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
