"use client";

import { Clock, Loader2, Layers } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { NotificationEventType } from "@arr/shared";
import { GlassmorphicCard, GradientButton } from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import {
	useAggregationConfigs,
	useUpdateAggregationConfigs,
} from "../../../hooks/api/useNotifications";

const EVENT_LABELS: Record<string, string> = {
	HUNT_CONTENT_FOUND: "Hunt: Content Found",
	HUNT_COMPLETED: "Hunt: Completed",
	HUNT_FAILED: "Hunt: Failed",
	QUEUE_ITEMS_REMOVED: "Queue: Items Removed",
	QUEUE_STRIKES_ISSUED: "Queue: Strikes Issued",
	QUEUE_CLEANER_FAILED: "Queue: Cleaner Failed",
	TRASH_PROFILE_UPDATED: "TRaSH: Profile Updated",
	TRASH_SYNC_ERROR: "TRaSH: Sync Error",
	TRASH_DEPLOY_FAILED: "TRaSH: Deploy Failed",
	BACKUP_COMPLETED: "Backup: Completed",
	BACKUP_FAILED: "Backup: Failed",
	LIBRARY_NEW_CONTENT: "Library: New Content",
	CLEANUP_ITEMS_FLAGGED: "Cleanup: Items Flagged",
	CLEANUP_ITEMS_REMOVED: "Cleanup: Items Removed",
	ACCOUNT_LOCKED: "Security: Account Locked",
	LOGIN_FAILED: "Security: Login Failed",
	SERVICE_CONNECTION_FAILED: "Services: Connection Failed",
	CACHE_REFRESH_STALE: "Cache: Refresh Stale",
	PLEX_CONCURRENT_PEAK: "Plex: Concurrent Peak",
	PLEX_TRANSCODE_HEAVY: "Plex: Heavy Transcoding",
	PLEX_NEW_DEVICE: "Plex: New Device",
	SYSTEM_STARTUP: "System: Startup",
	SYSTEM_ERROR: "System: Error",
};

/** High-frequency events that benefit most from aggregation */
const AGGREGATABLE_EVENTS: NotificationEventType[] = [
	"HUNT_CONTENT_FOUND",
	"HUNT_COMPLETED",
	"HUNT_FAILED",
	"QUEUE_ITEMS_REMOVED",
	"QUEUE_STRIKES_ISSUED",
	"LIBRARY_NEW_CONTENT",
	"CLEANUP_ITEMS_FLAGGED",
	"CLEANUP_ITEMS_REMOVED",
	"LOGIN_FAILED",
	"PLEX_CONCURRENT_PEAK",
	"PLEX_TRANSCODE_HEAVY",
	"PLEX_NEW_DEVICE",
];

interface LocalConfig {
	eventType: NotificationEventType;
	windowSeconds: number;
	maxBatchSize: number;
	enabled: boolean;
}

export function AggregationConfig() {
	const { gradient } = useThemeGradient();
	const { data: configs = [], isLoading } = useAggregationConfigs();
	const updateConfigs = useUpdateAggregationConfigs();
	const [localConfigs, setLocalConfigs] = useState<LocalConfig[]>([]);
	const [isDirty, setIsDirty] = useState(false);

	// Sync remote → local when data loads
	useEffect(() => {
		const merged = AGGREGATABLE_EVENTS.map((eventType) => {
			const existing = configs.find((c) => c.eventType === eventType);
			return {
				eventType,
				windowSeconds: existing?.windowSeconds ?? 300,
				maxBatchSize: existing?.maxBatchSize ?? 10,
				enabled: existing?.enabled ?? false,
			};
		});
		setLocalConfigs(merged);
		setIsDirty(false);
	}, [configs]);

	const updateLocal = useCallback((eventType: string, patch: Partial<LocalConfig>) => {
		setLocalConfigs((prev) =>
			prev.map((c) => (c.eventType === eventType ? { ...c, ...patch } : c)),
		);
		setIsDirty(true);
	}, []);

	const handleSave = () => {
		const enabled = localConfigs.filter((c) => c.enabled);
		updateConfigs.mutate(
			enabled.map((c) => ({
				eventType: c.eventType,
				windowSeconds: c.windowSeconds,
				maxBatchSize: c.maxBatchSize,
				enabled: true,
			})),
			{ onSuccess: () => setIsDirty(false) },
		);
	};

	const inputClass =
		"w-full bg-background/50 border border-border/50 rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors";

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	const enabledCount = localConfigs.filter((c) => c.enabled).length;

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-sm font-medium text-foreground flex items-center gap-2">
						<Layers className="h-4 w-4" style={{ color: gradient.from }} />
						Event Aggregation
					</h3>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Batch high-frequency events into digest notifications instead of sending each one
						individually.
					</p>
				</div>
				{isDirty && (
					<GradientButton onClick={handleSave} disabled={updateConfigs.isPending}>
						{updateConfigs.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						Save Changes
					</GradientButton>
				)}
			</div>

			{enabledCount > 0 && (
				<p className="text-xs text-muted-foreground">
					{enabledCount} event type{enabledCount !== 1 ? "s" : ""} aggregated
				</p>
			)}

			<div className="grid gap-2">
				{localConfigs.map((config) => (
					<GlassmorphicCard key={config.eventType} padding="sm">
						<div className="flex items-center gap-4">
							{/* Toggle */}
							<button
								type="button"
								onClick={() => updateLocal(config.eventType, { enabled: !config.enabled })}
								className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
									config.enabled ? "" : "bg-border/50"
								}`}
								style={config.enabled ? { backgroundColor: gradient.from } : undefined}
							>
								<span
									className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
										config.enabled ? "translate-x-5" : "translate-x-0"
									}`}
								/>
							</button>

							{/* Label */}
							<div className="min-w-0 flex-1">
								<span
									className={`text-sm ${config.enabled ? "text-foreground" : "text-muted-foreground"}`}
								>
									{EVENT_LABELS[config.eventType] ?? config.eventType}
								</span>
							</div>

							{/* Window + batch size — only shown when enabled */}
							{config.enabled && (
								<div className="flex items-center gap-3 shrink-0">
									<div className="flex items-center gap-1.5">
										<Clock className="h-3.5 w-3.5 text-muted-foreground" />
										<select
											value={config.windowSeconds}
											onChange={(e) =>
												updateLocal(config.eventType, {
													windowSeconds: Number(e.target.value),
												})
											}
											className={`${inputClass} !w-auto !py-1 text-xs`}
											onFocus={(e) => (e.target.style.borderColor = gradient.from)}
											onBlur={(e) => (e.target.style.borderColor = "")}
										>
											<option value={60}>1 min</option>
											<option value={120}>2 min</option>
											<option value={300}>5 min</option>
											<option value={600}>10 min</option>
											<option value={900}>15 min</option>
											<option value={1800}>30 min</option>
											<option value={3600}>60 min</option>
										</select>
									</div>
									<div className="flex items-center gap-1.5">
										<span className="text-xs text-muted-foreground">max</span>
										<input
											type="number"
											min={2}
											max={100}
											value={config.maxBatchSize}
											onChange={(e) =>
												updateLocal(config.eventType, {
													maxBatchSize: Math.max(2, Math.min(100, Number(e.target.value))),
												})
											}
											className={`${inputClass} !w-16 !py-1 text-xs text-center`}
											onFocus={(e) => (e.target.style.borderColor = gradient.from)}
											onBlur={(e) => (e.target.style.borderColor = "")}
										/>
									</div>
								</div>
							)}
						</div>
					</GlassmorphicCard>
				))}
			</div>
		</div>
	);
}
