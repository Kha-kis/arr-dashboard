"use client";

import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard, StatusBadge } from "@/components/layout/premium-components";
import { useNotificationLogs } from "../../../hooks/api/useNotifications";

export function NotificationLogTable() {
	const [page, setPage] = useState(1);
	const { data, isLoading } = useNotificationLogs(page, 15);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!data || data.logs.length === 0) {
		return (
			<GlassmorphicCard padding="lg">
				<p className="text-center text-muted-foreground py-8">
					No notification logs yet. Logs appear after notifications are sent.
				</p>
			</GlassmorphicCard>
		);
	}

	const totalPages = Math.ceil(data.total / data.limit);

	return (
		<div className="space-y-4">
			<GlassmorphicCard padding="none">
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border/30">
								<th className="px-4 py-3 text-left text-muted-foreground font-medium">Event</th>
								<th className="px-4 py-3 text-left text-muted-foreground font-medium">Title</th>
								<th className="px-4 py-3 text-left text-muted-foreground font-medium">Channel</th>
								<th className="px-4 py-3 text-left text-muted-foreground font-medium">Status</th>
								<th className="px-4 py-3 text-left text-muted-foreground font-medium">Sent</th>
							</tr>
						</thead>
						<tbody>
							{data.logs.map((log) => (
								<tr key={log.id} className="border-b border-border/10 hover:bg-card/20">
									<td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">
										{log.eventType}
									</td>
									<td className="px-4 py-2.5 truncate max-w-[200px]">{log.title}</td>
									<td className="px-4 py-2.5 text-xs text-muted-foreground">{log.channelType}</td>
									<td className="px-4 py-2.5">
										<StatusBadge status={log.status === "sent" ? "success" : "error"}>
											{log.status}
										</StatusBadge>
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
			{totalPages > 1 && (
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
						Page {page} of {totalPages}
					</span>
					<button
						type="button"
						onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
						disabled={page === totalPages}
						className="rounded-md p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
					>
						<ChevronRight className="h-4 w-4" />
					</button>
				</div>
			)}
		</div>
	);
}
