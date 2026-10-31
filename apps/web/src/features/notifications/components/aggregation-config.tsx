"use client";

import type { AggregationConfigResponse, NotificationEventType } from "@arr/shared";
import { Clock, Layers, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GradientButton } from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { INPUT_BASE_CLASSES } from "@/lib/theme-input-styles";
import {
	useAggregationConfigs,
	useUpdateAggregationConfigs,
} from "../../../hooks/api/useNotifications";
import { NotificationAggregationSaveUnverifiedError } from "../../../lib/api-client/notifications";

const EVENT_LABELS: Record<string, string> = {
	HUNT_CONTENT_FOUND: "Hunt: Content Found",
	HUNT_COMPLETED: "Hunt: Completed",
	HUNT_FAILED: "Hunt: Failed",
	QUEUE_ITEMS_REMOVED: "Queue: Items Removed",
	QUEUE_STRIKES_ISSUED: "Queue: Strikes Issued",
	QUEUE_CLEANER_FAILED: "Queue: Cleaner Failed",
	QUI_TORRENT_ERRORED: "qui: Torrent Errored",
	QUI_DOWNLOAD_STALLED: "qui: Download Stalled",
	QUI_TORRENT_COMPLETED: "qui: Torrent Completed",
	TRASH_PROFILE_UPDATED: "TRaSH: Profile Updated",
	TRASH_SYNC_ERROR: "TRaSH: Sync Error",
	TRASH_DEPLOY_FAILED: "TRaSH: Deploy Failed",
	TRASH_DEPLOY_UNCERTAIN: "TRaSH: Deploy Needs Review",
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
	JELLYFIN_CONCURRENT_PEAK: "Jellyfin: Concurrent Peak",
	JELLYFIN_TRANSCODE_HEAVY: "Jellyfin: Heavy Transcoding",
	JELLYFIN_NEW_DEVICE: "Jellyfin: New Device",
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
	"QUI_TORRENT_ERRORED",
	"QUI_DOWNLOAD_STALLED",
	"QUI_TORRENT_COMPLETED",
	"LIBRARY_NEW_CONTENT",
	"CLEANUP_ITEMS_FLAGGED",
	"CLEANUP_ITEMS_REMOVED",
	"LOGIN_FAILED",
	"PLEX_CONCURRENT_PEAK",
	"PLEX_TRANSCODE_HEAVY",
	"PLEX_NEW_DEVICE",
	"JELLYFIN_CONCURRENT_PEAK",
	"JELLYFIN_TRANSCODE_HEAVY",
	"JELLYFIN_NEW_DEVICE",
];

interface LocalConfig {
	eventType: NotificationEventType;
	windowSeconds: number;
	maxBatchSize: number;
	enabled: boolean;
}

export function AggregationConfig() {
	const { gradient } = useThemeGradient();
	const { data: configs, isLoading, isError, isFetching, refetch } = useAggregationConfigs();
	const updateConfigs = useUpdateAggregationConfigs();
	const [drafts, setDrafts] = useState<Partial<Record<NotificationEventType, LocalConfig>>>({});
	const dispatchPending = useRef(false);
	const saveBlocked = useRef(false);
	const mounted = useRef(true);
	const [isDispatching, setIsDispatching] = useState(false);
	const [saveUnverified, setSaveUnverified] = useState(false);
	const [reviewedConfigs, setReviewedConfigs] = useState<AggregationConfigResponse[]>();
	const [reviewError, setReviewError] = useState(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const controlsBusy = isDispatching || updateConfigs.isPending;
	const requiresReview = saveUnverified && reviewedConfigs === undefined;
	// Only user edits belong in local state. Untouched rows follow remote data,
	// while refetches cannot erase edited rows or certify absent data as disabled.
	const localConfigs = AGGREGATABLE_EVENTS.map((eventType) => {
		const existing = configs?.find((c) => c.eventType === eventType);
		return (
			drafts[eventType] ?? {
				eventType,
				windowSeconds: existing?.windowSeconds ?? 300,
				maxBatchSize: existing?.maxBatchSize ?? 10,
				enabled: existing?.enabled ?? false,
			}
		);
	});
	const isDirty = Object.keys(drafts).length > 0;

	const updateLocal = (eventType: NotificationEventType, patch: Partial<LocalConfig>) => {
		if (dispatchPending.current || updateConfigs.isPending) return;
		const current = localConfigs.find((c) => c.eventType === eventType);
		if (!current) return;
		setDrafts((previous) => ({ ...previous, [eventType]: { ...current, ...patch } }));
		if (updateConfigs.isError) updateConfigs.reset();
	};

	const handleSave = async () => {
		if (
			dispatchPending.current ||
			saveBlocked.current ||
			updateConfigs.isPending ||
			!configs ||
			!isDirty
		)
			return;
		// Fence before mutate's observer can render pending, including local edits.
		dispatchPending.current = true;
		setIsDispatching(true);
		setSaveUnverified(false);
		setReviewedConfigs(undefined);
		setReviewError(false);
		const submitted = Object.values(drafts);
		try {
			await updateConfigs.mutateAsync(submitted);
			if (mounted.current) setDrafts({});
		} catch (error) {
			if (mounted.current && error instanceof NotificationAggregationSaveUnverifiedError) {
				saveBlocked.current = true;
				setSaveUnverified(true);
			}
		} finally {
			dispatchPending.current = false;
			if (mounted.current) setIsDispatching(false);
		}
	};

	const handleReview = async () => {
		if (dispatchPending.current || updateConfigs.isPending) return;
		dispatchPending.current = true;
		saveBlocked.current = true;
		setReviewedConfigs(undefined);
		setIsDispatching(true);
		setReviewError(false);
		try {
			const current = await updateConfigs.recheckAggregation();
			if (mounted.current) {
				setReviewedConfigs(current);
				saveBlocked.current = false;
			}
		} catch {
			if (mounted.current) setReviewError(true);
		} finally {
			dispatchPending.current = false;
			if (mounted.current) setIsDispatching(false);
		}
	};

	const inputClass = INPUT_BASE_CLASSES.input;

	if (isLoading || (!configs && !isError)) {
		return (
			<div
				role="status"
				aria-label="Loading aggregation settings"
				className="flex items-center justify-center py-8"
			>
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!configs) {
		return (
			<div role="alert" className="space-y-3 rounded-xl border border-border/30 p-4">
				<p>Couldn&apos;t load event aggregation settings. Saved settings have not been verified.</p>
				<GradientButton onClick={() => void refetch()} disabled={isFetching}>
					Retry aggregation settings
				</GradientButton>
			</div>
		);
	}

	const enabledCount = localConfigs.filter((c) => c.enabled).length;

	return (
		<div className="space-y-4">
			{isError && (
				<div role="alert" className="space-y-2 rounded-xl border border-border/30 p-3">
					<p className="text-sm">
						Showing last-known aggregation settings and your edits; refresh failed.
					</p>
					<GradientButton onClick={() => void refetch()} disabled={isFetching || controlsBusy}>
						Retry aggregation settings
					</GradientButton>
				</div>
			)}
			{saveUnverified && (
				<div role="alert" className="space-y-2 rounded-xl border border-border/30 p-3">
					<p className="text-sm text-muted-foreground">
						{requiresReview
							? "Save outcome could not be verified. Changes may have been saved. Your edits are retained. Review current aggregation settings before a new save."
							: "Current saved settings were checked. Review the values shown beside your edits before a new manual save; the earlier save outcome remains unverified."}
					</p>
					{reviewError && (
						<p className="text-sm text-muted-foreground">
							Couldn&apos;t review current aggregation settings. Your edits are retained.
						</p>
					)}
					<GradientButton onClick={() => void handleReview()} disabled={controlsBusy}>
						Review current aggregation settings
					</GradientButton>
				</div>
			)}
			{updateConfigs.isError && !saveUnverified && (
				<p role="alert" className="text-sm text-muted-foreground">
					Couldn&apos;t save event aggregation changes. Your edits are retained; retry Save Changes.
				</p>
			)}
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
					<GradientButton
						onClick={() => void handleSave()}
						disabled={controlsBusy || requiresReview}
					>
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
					<div
						key={config.eventType}
						className="rounded-xl border border-border/30 bg-muted/10 p-3"
					>
						<div className="flex items-center gap-4">
							{/* Toggle */}
							<button
								type="button"
								aria-label={`Aggregate ${EVENT_LABELS[config.eventType] ?? config.eventType}`}
								aria-pressed={config.enabled}
								disabled={controlsBusy}
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
											aria-label={`${EVENT_LABELS[config.eventType] ?? config.eventType} aggregation window`}
											disabled={controlsBusy}
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
											aria-label={`${EVENT_LABELS[config.eventType] ?? config.eventType} maximum batch size`}
											disabled={controlsBusy}
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
						{drafts[config.eventType] && reviewedConfigs !== undefined && (
							<p className="mt-2 text-xs text-muted-foreground">
								{(() => {
									const checked = reviewedConfigs.find((row) => row.eventType === config.eventType);
									return checked
										? `Checked saved values: ${checked.enabled ? "enabled" : "disabled"}; window ${checked.windowSeconds} seconds; maximum batch ${checked.maxBatchSize}.`
										: "Checked saved values: not returned by this read. The earlier save outcome remains unverified.";
								})()}
							</p>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
