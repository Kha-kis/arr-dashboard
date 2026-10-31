"use client";

import type { NotificationEventType } from "@arr/shared";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { GradientButton } from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { getLinuxInstanceName, useIncognitoMode } from "@/lib/incognito";
import {
	useNotificationSubscriptions,
	useUpdateSubscriptions,
} from "../../../hooks/api/useNotifications";
import type {
	SubscriptionGridResponse,
	SubscriptionUpdateEntry,
} from "../../../lib/api-client/notifications";
import { SubscriptionSaveUnverifiedError } from "../../../lib/api-client/notifications";

/** Local map: eventType → channelId[] (convenient for checkbox toggling) */
type SubsMap = Record<string, string[]>;

/** Event display config */
const EVENT_LABELS: Record<string, string> = {
	HUNT_CONTENT_FOUND: "Content Found",
	HUNT_COMPLETED: "Hunt Completed",
	HUNT_FAILED: "Hunt Failed",
	QUEUE_ITEMS_REMOVED: "Items Removed",
	QUEUE_STRIKES_ISSUED: "Strikes Issued",
	QUEUE_CLEANER_FAILED: "Cleaner Failed",
	QUI_TORRENT_ERRORED: "Torrent Errored",
	QUI_DOWNLOAD_STALLED: "Download Stalled",
	QUI_TORRENT_COMPLETED: "Torrent Completed",
	TRASH_PROFILE_UPDATED: "Profile Updated",
	TRASH_SYNC_ERROR: "Sync Error",
	TRASH_DEPLOY_FAILED: "Deploy Failed",
	TRASH_DEPLOY_UNCERTAIN: "Deploy Needs Review",
	BACKUP_COMPLETED: "Backup Completed",
	BACKUP_FAILED: "Backup Failed",
	LIBRARY_NEW_CONTENT: "New Content",
	CLEANUP_ITEMS_FLAGGED: "Items Flagged",
	CLEANUP_ITEMS_REMOVED: "Items Removed",
	ACCOUNT_LOCKED: "Account Locked",
	LOGIN_FAILED: "Login Failed",
	SERVICE_CONNECTION_FAILED: "Connection Failed",
	CACHE_REFRESH_STALE: "Cache Stale",
	PLEX_CONCURRENT_PEAK: "Concurrent Peak",
	PLEX_TRANSCODE_HEAVY: "Heavy Transcoding",
	PLEX_NEW_DEVICE: "New Device",
	JELLYFIN_CONCURRENT_PEAK: "Concurrent Peak",
	JELLYFIN_TRANSCODE_HEAVY: "Heavy Transcoding",
	JELLYFIN_NEW_DEVICE: "New Device",
	SYSTEM_STARTUP: "Startup",
	SYSTEM_ERROR: "System Error",
	LIBRARY_INSIGHT_REQUESTED_UNWATCHED: "Requested Unwatched",
	LIBRARY_INSIGHT_WATCHED_MONITORED: "Watched Monitored",
};

const EVENT_GROUPS: Array<{ label: string; events: NotificationEventType[] }> = [
	{
		label: "Hunting",
		events: ["HUNT_CONTENT_FOUND", "HUNT_COMPLETED", "HUNT_FAILED"],
	},
	{
		label: "Queue Cleaner",
		events: ["QUEUE_ITEMS_REMOVED", "QUEUE_STRIKES_ISSUED", "QUEUE_CLEANER_FAILED"],
	},
	{
		label: "qui (torrents)",
		events: ["QUI_TORRENT_ERRORED", "QUI_DOWNLOAD_STALLED", "QUI_TORRENT_COMPLETED"],
	},
	{
		label: "TRaSH Guides",
		events: [
			"TRASH_PROFILE_UPDATED",
			"TRASH_SYNC_ERROR",
			"TRASH_DEPLOY_FAILED",
			"TRASH_DEPLOY_UNCERTAIN",
		],
	},
	{
		label: "Backup",
		events: ["BACKUP_COMPLETED", "BACKUP_FAILED"],
	},
	{
		label: "Library",
		events: ["LIBRARY_NEW_CONTENT", "CLEANUP_ITEMS_FLAGGED", "CLEANUP_ITEMS_REMOVED"],
	},
	{
		label: "Security",
		events: ["ACCOUNT_LOCKED", "LOGIN_FAILED"],
	},
	{
		label: "Services",
		events: ["SERVICE_CONNECTION_FAILED"],
	},
	{
		label: "Cache & Media Servers",
		events: [
			"CACHE_REFRESH_STALE",
			"PLEX_CONCURRENT_PEAK",
			"PLEX_TRANSCODE_HEAVY",
			"PLEX_NEW_DEVICE",
			"JELLYFIN_CONCURRENT_PEAK",
			"JELLYFIN_TRANSCODE_HEAVY",
			"JELLYFIN_NEW_DEVICE",
		],
	},
	{
		label: "System",
		events: ["SYSTEM_STARTUP", "SYSTEM_ERROR"],
	},
	{
		label: "Library Insights",
		events: ["LIBRARY_INSIGHT_REQUESTED_UNWATCHED", "LIBRARY_INSIGHT_WATCHED_MONITORED"],
	},
];

/** Derive local map from the backend normalized response */
function toSubsMap(response: SubscriptionGridResponse): SubsMap {
	const map: SubsMap = Object.create(null);
	for (const event of response.events) {
		map[event] = [];
	}
	for (const sub of response.subscriptions) {
		const existing = map[sub.eventType];
		if (existing) {
			existing.push(sub.channelId);
		} else {
			map[sub.eventType] = [sub.channelId];
		}
	}
	return map;
}

/** Diff local state vs server state to produce the minimal update payload */
function buildUpdateEntries(
	serverData: SubscriptionGridResponse,
	localSubs: SubsMap,
): SubscriptionUpdateEntry[] {
	const serverSet = new Set(serverData.subscriptions.map((s) => `${s.channelId}::${s.eventType}`));

	const entries: SubscriptionUpdateEntry[] = [];
	for (const event of serverData.events) {
		for (const ch of serverData.channels) {
			const key = `${ch.id}::${event}`;
			const isLocal = (localSubs[event] ?? []).includes(ch.id);
			const isServer = serverSet.has(key);
			if (isLocal !== isServer) {
				entries.push({ channelId: ch.id, eventType: event, enabled: isLocal });
			}
		}
	}
	return entries;
}

export function SubscriptionGrid() {
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const {
		data: serverData,
		isLoading,
		isError,
		isFetching,
		refetch,
	} = useNotificationSubscriptions();
	const updateSubs = useUpdateSubscriptions();

	const [localSubs, setLocalSubs] = useState<SubsMap>({});
	const [hasChanges, setHasChanges] = useState(false);
	const [referenceGrid, setReferenceGrid] = useState<SubscriptionGridResponse | undefined>(
		serverData,
	);
	const [unverified, setUnverified] = useState(false);
	const [reloading, setReloading] = useState(false);
	const [saveNotice, setSaveNotice] = useState<string | null>(null);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

	// A draft remains tied to the grid it was edited against. Background reads
	// cannot replace its cells, columns or baseline while saving or recovering.
	useEffect(() => {
		if (serverData && !hasChanges && !updateSubs.isPending && !unverified) {
			setReferenceGrid(serverData);
			setLocalSubs(toSubsMap(serverData));
		}
	}, [serverData, hasChanges, updateSubs.isPending, unverified]);

	const editableLocked = updateSubs.isPending || unverified || reloading;

	const acceptGrid = (grid: SubscriptionGridResponse) => {
		setReferenceGrid(grid);
		setLocalSubs(toSubsMap(grid));
		setHasChanges(false);
		setUnverified(false);
	};

	const toggleSubscription = (eventType: string, channelId: string) => {
		if (editableLocked) return;
		setSaveNotice(null);
		setLocalSubs((prev) => {
			const current = prev[eventType] ?? [];
			const updated = current.includes(channelId)
				? current.filter((id) => id !== channelId)
				: [...current, channelId];
			return { ...prev, [eventType]: updated };
		});
		setHasChanges(true);
	};

	const toggleGroup = (label: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(label)) {
				next.delete(label);
			} else {
				next.add(label);
			}
			return next;
		});
	};

	const handleSave = () => {
		if (!referenceGrid || editableLocked) return;
		const entries = buildUpdateEntries(referenceGrid, localSubs);
		if (entries.length === 0) {
			setHasChanges(false);
			return;
		}
		updateSubs.mutate(entries, {
			onSuccess: (confirmed) => {
				acceptGrid(confirmed.grid);
				setSaveNotice(
					confirmed.omittedCount === null
						? "Saved subscriptions reloaded. Omitted selection count is unknown; review the current grid."
						: confirmed.omittedCount > 0
							? `${confirmed.omittedCount} selection entries were omitted. Review the saved grid.`
							: null,
				);
			},
			onError: (error) => {
				if (error instanceof SubscriptionSaveUnverifiedError) setUnverified(true);
				else toast.error("Subscriptions could not be saved. Review your draft and try again.");
			},
		});
	};

	const reloadSavedGrid = async () => {
		if (reloading || updateSubs.isPending) return;
		setReloading(true);
		try {
			const result = await refetch();
			if (result.isSuccess && result.data) {
				acceptGrid(result.data);
				setSaveNotice(null);
			}
		} finally {
			setReloading(false);
		}
	};

	// Columns (channels) and rows (events) come from the server response
	const channels = useMemo(() => referenceGrid?.channels ?? [], [referenceGrid]);
	const availableEvents = useMemo(() => new Set(referenceGrid?.events ?? []), [referenceGrid]);

	if (isLoading && !referenceGrid) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (isError && !referenceGrid) {
		return (
			<div
				role="alert"
				className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground"
			>
				<AlertTriangle className="h-6 w-6" />
				<p className="text-sm">Subscriptions are unavailable. Please try again.</p>
				<GradientButton onClick={() => void refetch()} disabled={isFetching}>
					Try again
				</GradientButton>
			</div>
		);
	}

	const readNotice = unverified ? (
		<div role="alert" className="rounded-xl border border-border/30 bg-muted/10 p-4 space-y-2">
			<p className="text-sm text-muted-foreground">
				Subscription save outcome could not be verified. Your draft is retained. Reload saved
				subscriptions and review before saving again.
			</p>
			<GradientButton onClick={() => void reloadSavedGrid()} disabled={reloading}>
				Reload saved subscriptions and discard draft
			</GradientButton>
		</div>
	) : isError ? (
		<div role="alert" className="text-sm text-muted-foreground space-y-2">
			<p>Showing last-known saved subscriptions; refresh failed. Any draft is retained.</p>
			<GradientButton onClick={() => void refetch()} disabled={isFetching}>
				Try again
			</GradientButton>
		</div>
	) : isFetching ? (
		<p role="status" className="text-sm text-muted-foreground">
			Showing last-known saved subscriptions while refreshing. Any draft is retained.
		</p>
	) : null;

	if (channels.length === 0) {
		return (
			<div className="space-y-4">
				{readNotice}
				{saveNotice && <p className="text-sm text-muted-foreground">{saveNotice}</p>}
				<div className="rounded-xl border border-border/30 bg-muted/10 p-6">
					<p className="text-center text-muted-foreground py-8">
						Create at least one notification channel before configuring event subscriptions.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{readNotice}
			{saveNotice && <p className="text-sm text-muted-foreground">{saveNotice}</p>}
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Select which channels receive notifications for each event type.
				</p>
				{hasChanges && (
					<GradientButton onClick={handleSave} disabled={editableLocked}>
						{updateSubs.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Save className="mr-2 h-4 w-4" />
						)}
						Save Changes
					</GradientButton>
				)}
			</div>

			<div className="overflow-hidden rounded-xl border border-border/30 bg-muted/10">
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border/30">
								<th className="px-4 py-3 text-left text-muted-foreground font-medium">Event</th>
								{channels.map((ch) => (
									<th
										key={ch.id}
										className="px-3 py-3 text-center text-muted-foreground font-medium whitespace-nowrap"
									>
										{incognitoMode ? getLinuxInstanceName(ch.name) : ch.name}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{EVENT_GROUPS.map((group) => {
								// Filter to only events that exist in the server response
								const groupEvents = group.events.filter((e) => availableEvents.has(e));
								if (groupEvents.length === 0) return null;

								const isCollapsed = collapsedGroups.has(group.label);

								return [
									// Group header row
									<tr
										key={`group-${group.label}`}
										className="border-b border-border/20 bg-card/20 cursor-pointer select-none"
										onClick={() => toggleGroup(group.label)}
									>
										<td colSpan={channels.length + 1} className="px-4 py-2">
											<div className="flex items-center gap-2">
												{isCollapsed ? (
													<ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
												) : (
													<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
												)}
												<span
													className="text-xs font-semibold uppercase tracking-wider"
													style={{ color: gradient.from }}
												>
													{group.label}
												</span>
												<span className="text-xs text-muted-foreground">
													({groupEvents.length})
												</span>
											</div>
										</td>
									</tr>,
									// Event rows (hidden when collapsed)
									...(!isCollapsed
										? groupEvents.map((event) => (
												<tr key={event} className="border-b border-border/10 hover:bg-card/20">
													<td className="px-4 py-2.5 pl-9">
														<span className="text-foreground">{EVENT_LABELS[event] ?? event}</span>
													</td>
													{channels.map((ch) => {
														const isChecked = (localSubs[event] ?? []).includes(ch.id);
														return (
															<td key={ch.id} className="px-3 py-2.5 text-center">
																<button
																	type="button"
																	disabled={editableLocked}
																	onClick={() => toggleSubscription(event, ch.id)}
																	className={`h-5 w-5 rounded border transition-colors ${
																		isChecked
																			? "border-transparent"
																			: "border-border/50 bg-background/30"
																	}`}
																	style={isChecked ? { backgroundColor: gradient.from } : undefined}
																	aria-label={`${isChecked ? "Unsubscribe" : "Subscribe"} ${incognitoMode ? getLinuxInstanceName(ch.name) : ch.name} from ${EVENT_LABELS[event] ?? event}`}
																>
																	{isChecked && (
																		<svg
																			className="h-5 w-5 text-white"
																			fill="none"
																			viewBox="0 0 24 24"
																			stroke="currentColor"
																			strokeWidth={3}
																			aria-hidden="true"
																		>
																			<path
																				strokeLinecap="round"
																				strokeLinejoin="round"
																				d="M5 13l4 4L19 7"
																			/>
																		</svg>
																	)}
																</button>
															</td>
														);
													})}
												</tr>
											))
										: []),
								];
							})}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}
