"use client";

import { Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

/** Event display config — labels + grouping for the grid rows */
const EVENT_LABELS: Record<string, string> = {
	HUNT_CONTENT_FOUND: "Hunt: Content Found",
	HUNT_COMPLETED: "Hunt: Completed",
	QUEUE_ITEMS_REMOVED: "Queue: Items Removed",
	QUEUE_STRIKES_ISSUED: "Queue: Strikes Issued",
	TRASH_PROFILE_UPDATED: "TRaSH: Profile Updated",
	TRASH_SYNC_ERROR: "TRaSH: Sync Error",
	BACKUP_COMPLETED: "Backup: Completed",
	BACKUP_FAILED: "Backup: Failed",
	LIBRARY_NEW_CONTENT: "Library: New Content",
	SYSTEM_STARTUP: "System: Startup",
	SYSTEM_ERROR: "System: Error",
	CLEANUP_ITEMS_FLAGGED: "Cleanup: Items Flagged",
	CLEANUP_ITEMS_REMOVED: "Cleanup: Items Removed",
};

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
	const events = useMemo(() => serverData?.events ?? [], [serverData]);

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
							{events.map((event) => (
								<tr key={event} className="border-b border-border/10 hover:bg-card/20">
									<td className="px-4 py-2.5">
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
														isChecked ? "border-transparent" : "border-border/50 bg-background/30"
													}`}
													style={
														isChecked
															? {
																	backgroundColor: gradient.from,
																}
															: undefined
													}
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
							))}
						</tbody>
					</table>
				</div>
			</GlassmorphicCard>
		</div>
	);
}
