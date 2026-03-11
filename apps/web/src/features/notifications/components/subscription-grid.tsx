"use client";

import { ChevronDown, ChevronRight, Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { NotificationEventType } from "@arr/shared";
import { GlassmorphicCard, GradientButton } from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import {
	useNotificationSubscriptions,
	useUpdateSubscriptions,
} from "../../../hooks/api/useNotifications";
import type {
	SubscriptionGridResponse,
	SubscriptionUpdateEntry,
} from "../../../lib/api-client/notifications";

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
	TRASH_PROFILE_UPDATED: "Profile Updated",
	TRASH_SYNC_ERROR: "Sync Error",
	TRASH_DEPLOY_FAILED: "Deploy Failed",
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
	SYSTEM_STARTUP: "Startup",
	SYSTEM_ERROR: "System Error",
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
		label: "TRaSH Guides",
		events: ["TRASH_PROFILE_UPDATED", "TRASH_SYNC_ERROR", "TRASH_DEPLOY_FAILED"],
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
		label: "Cache & Plex",
		events: [
			"CACHE_REFRESH_STALE",
			"PLEX_CONCURRENT_PEAK",
			"PLEX_TRANSCODE_HEAVY",
			"PLEX_NEW_DEVICE",
		],
	},
	{
		label: "System",
		events: ["SYSTEM_STARTUP", "SYSTEM_ERROR"],
	},
];

/** Derive local map from the backend normalized response */
function toSubsMap(response: SubscriptionGridResponse): SubsMap {
	const map: SubsMap = {};
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
	const { data: serverData, isLoading } = useNotificationSubscriptions();
	const updateSubs = useUpdateSubscriptions();

	const [localSubs, setLocalSubs] = useState<SubsMap>({});
	const [hasChanges, setHasChanges] = useState(false);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

	// Derive local state from server response
	useEffect(() => {
		if (serverData) {
			setLocalSubs(toSubsMap(serverData));
			setHasChanges(false);
		}
	}, [serverData]);

	const toggleSubscription = (eventType: string, channelId: string) => {
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
		if (!serverData) return;
		const entries = buildUpdateEntries(serverData, localSubs);
		if (entries.length === 0) {
			setHasChanges(false);
			return;
		}
		updateSubs.mutate(entries, {
			onSuccess: () => setHasChanges(false),
		});
	};

	// Columns (channels) and rows (events) come from the server response
	const channels = useMemo(() => serverData?.channels ?? [], [serverData]);
	const availableEvents = useMemo(() => new Set(serverData?.events ?? []), [serverData]);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (channels.length === 0) {
		return (
			<GlassmorphicCard padding="lg">
				<p className="text-center text-muted-foreground py-8">
					Create at least one notification channel before configuring event subscriptions.
				</p>
			</GlassmorphicCard>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Select which channels receive notifications for each event type.
				</p>
				{hasChanges && (
					<GradientButton onClick={handleSave} disabled={updateSubs.isPending}>
						{updateSubs.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Save className="mr-2 h-4 w-4" />
						)}
						Save Changes
					</GradientButton>
				)}
			</div>

			<GlassmorphicCard padding="none">
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
										{ch.name}
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
																	onClick={() => toggleSubscription(event, ch.id)}
																	className={`h-5 w-5 rounded border transition-colors ${
																		isChecked
																			? "border-transparent"
																			: "border-border/50 bg-background/30"
																	}`}
																	style={isChecked ? { backgroundColor: gradient.from } : undefined}
																	aria-label={`${isChecked ? "Unsubscribe" : "Subscribe"} ${ch.name} from ${EVENT_LABELS[event] ?? event}`}
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
			</GlassmorphicCard>
		</div>
	);
}
