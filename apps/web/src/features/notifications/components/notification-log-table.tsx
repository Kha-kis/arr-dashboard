"use client";

import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard, StatusBadge } from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { useNotificationLogs } from "../../../hooks/api/useNotifications";

const STATUS_OPTIONS = [
	{ value: "", label: "All" },
	{ value: "sent", label: "Sent" },
	{ value: "failed", label: "Failed" },
	{ value: "dead_letter", label: "Dead Letter" },
];

const EVENT_TYPE_OPTIONS = [
	{ value: "", label: "All Events" },
	{ value: "HUNT_CONTENT_FOUND", label: "Hunt: Content Found" },
	{ value: "HUNT_COMPLETED", label: "Hunt: Completed" },
	{ value: "HUNT_FAILED", label: "Hunt: Failed" },
	{ value: "QUEUE_ITEMS_REMOVED", label: "Queue: Items Removed" },
	{ value: "QUEUE_STRIKES_ISSUED", label: "Queue: Strikes Issued" },
	{ value: "QUEUE_CLEANER_FAILED", label: "Queue: Cleaner Failed" },
	{ value: "TRASH_PROFILE_UPDATED", label: "TRaSH: Profile Updated" },
	{ value: "TRASH_SYNC_ERROR", label: "TRaSH: Sync Error" },
	{ value: "TRASH_DEPLOY_FAILED", label: "TRaSH: Deploy Failed" },
	{ value: "BACKUP_COMPLETED", label: "Backup: Completed" },
	{ value: "BACKUP_FAILED", label: "Backup: Failed" },
	{ value: "LIBRARY_NEW_CONTENT", label: "Library: New Content" },
	{ value: "CLEANUP_ITEMS_FLAGGED", label: "Cleanup: Items Flagged" },
	{ value: "CLEANUP_ITEMS_REMOVED", label: "Cleanup: Items Removed" },
	{ value: "ACCOUNT_LOCKED", label: "Security: Account Locked" },
	{ value: "LOGIN_FAILED", label: "Security: Login Failed" },
	{ value: "SERVICE_CONNECTION_FAILED", label: "Service: Connection Failed" },
	{ value: "CACHE_REFRESH_STALE", label: "Cache: Refresh Stale" },
	{ value: "PLEX_CONCURRENT_PEAK", label: "Plex: Concurrent Peak" },
	{ value: "PLEX_TRANSCODE_HEAVY", label: "Plex: Heavy Transcoding" },
	{ value: "PLEX_NEW_DEVICE", label: "Plex: New Device" },
	{ value: "SYSTEM_STARTUP", label: "System: Startup" },
	{ value: "SYSTEM_ERROR", label: "System: Error" },
];

interface Filters {
	status: string;
	eventType: string;
}

export function NotificationLogTable() {
	const { gradient } = useThemeGradient();
	const [page, setPage] = useState(1);
	const [filters, setFilters] = useState<Filters>({ status: "", eventType: "" });

	const activeFilters = {
		status: filters.status || undefined,
		eventType: filters.eventType || undefined,
	};

	const { data, isLoading } = useNotificationLogs(page, 15, activeFilters);

	const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
		setFilters((prev) => ({ ...prev, [key]: value }));
		setPage(1);
	};

	const clearFilters = () => {
		setFilters({ status: "", eventType: "" });
		setPage(1);
	};

	const hasFilters = filters.status !== "" || filters.eventType !== "";

	const selectClass =
		"bg-background/50 border border-border/50 rounded-lg px-3 py-1.5 text-sm focus:outline-none transition-colors";

	return (
		<div className="space-y-4">
			{/* Filter bar */}
			<div className="flex flex-wrap items-center gap-3">
				{/* Status toggle buttons */}
				<div className="flex items-center gap-1">
					{STATUS_OPTIONS.map((opt) => (
						<button
							type="button"
							key={opt.value}
							onClick={() => setFilter("status", opt.value)}
							className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
								filters.status === opt.value
									? "text-white"
									: "text-muted-foreground hover:text-foreground bg-card/30 border border-border/50"
							}`}
							style={
								filters.status === opt.value ? { backgroundColor: gradient.from } : undefined
							}
						>
							{opt.label}
						</button>
					))}
				</div>

				{/* Event type dropdown */}
				<select
					value={filters.eventType}
					onChange={(e) => setFilter("eventType", e.target.value)}
					className={selectClass}
					onFocus={(e) => (e.target.style.borderColor = gradient.from)}
					onBlur={(e) => (e.target.style.borderColor = "")}
				>
					{EVENT_TYPE_OPTIONS.map((opt) => (
						<option key={opt.value} value={opt.value}>
							{opt.label}
						</option>
					))}
				</select>

				{/* Clear filters */}
				{hasFilters && (
					<button
						type="button"
						onClick={clearFilters}
						className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground bg-card/30 border border-border/50 transition-colors"
					>
						<X className="h-3.5 w-3.5" />
						Clear
					</button>
				)}
			</div>

			{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
				</div>
			) : !data || data.logs.length === 0 ? (
				<GlassmorphicCard padding="lg">
					<p className="text-center text-muted-foreground py-8">
						{hasFilters
							? "No logs match the current filters."
							: "No notification logs yet. Logs appear after notifications are sent."}
					</p>
				</GlassmorphicCard>
			) : (
				<>
					<GlassmorphicCard padding="none">
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-border/30">
										<th className="px-4 py-3 text-left text-muted-foreground font-medium">
											Event
										</th>
										<th className="px-4 py-3 text-left text-muted-foreground font-medium">
											Title
										</th>
										<th className="px-4 py-3 text-left text-muted-foreground font-medium">
											Channel
										</th>
										<th className="px-4 py-3 text-left text-muted-foreground font-medium">
											Status
										</th>
										<th className="px-4 py-3 text-left text-muted-foreground font-medium">
											Sent
										</th>
									</tr>
								</thead>
								<tbody>
									{data.logs.map((log) => (
										<tr key={log.id} className="border-b border-border/10 hover:bg-card/20">
											<td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">
												{log.eventType}
											</td>
											<td className="px-4 py-2.5 truncate max-w-[200px]">{log.title}</td>
											<td className="px-4 py-2.5 text-xs text-muted-foreground">
												{log.channelType}
											</td>
											<td className="px-4 py-2.5">
												<StatusBadge
													status={
														log.status === "sent"
															? "success"
															: log.status === "dead_letter"
																? "warning"
																: "error"
													}
												>
													{log.status === "dead_letter" ? "Dead Letter" : log.status}
												</StatusBadge>
												{log.error && (
													<p
														className="text-xs text-red-400/70 mt-1 max-w-[200px] truncate"
														title={log.error}
													>
														{log.error}
													</p>
												)}
											</td>
											<td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
												{new Date(log.sentAt).toLocaleString()}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</GlassmorphicCard>

					{/* Pagination */}
					{data.total > data.limit && (
						<div className="flex items-center justify-center gap-4">
							<button
								type="button"
								onClick={() => setPage((p) => Math.max(1, p - 1))}
								disabled={page === 1}
								className="rounded-md p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
							>
								<ChevronLeft className="h-4 w-4" />
							</button>
							<span className="text-sm text-muted-foreground">
								Page {page} of {Math.ceil(data.total / data.limit)}
							</span>
							<button
								type="button"
								onClick={() => setPage((p) => Math.min(Math.ceil(data.total / data.limit), p + 1))}
								disabled={page === Math.ceil(data.total / data.limit)}
								className="rounded-md p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
							>
								<ChevronRight className="h-4 w-4" />
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}
