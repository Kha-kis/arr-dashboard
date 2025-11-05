"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Calendar, Clock, CheckCircle2, XCircle, AlertCircle, ChevronRight } from "lucide-react";
import { useSyncHistory } from "../../../../hooks/api/useSync";

const STATUS_ICONS = {
	SUCCESS: CheckCircle2,
	PARTIAL_SUCCESS: AlertCircle,
	FAILED: XCircle,
};

const STATUS_COLORS = {
	SUCCESS: "text-green-400 bg-green-500/10 border-green-500/20",
	PARTIAL_SUCCESS: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
	FAILED: "text-red-400 bg-red-500/10 border-red-500/20",
};

export default function SyncHistoryPage() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const instanceId = searchParams.get("instanceId");

	const [page, setPage] = useState(0);
	const limit = 20;

	const { data, isLoading, error } = useSyncHistory(instanceId || "", {
		limit,
		offset: page * limit,
	});

	const handleViewDetails = (syncId: string) => {
		router.push(`/trash-guides/history/${syncId}`);
	};

	const formatDuration = (ms: number | null) => {
		if (!ms) return "N/A";
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;
	};

	const formatDate = (isoString: string) => {
		return new Date(isoString).toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	};

	if (!instanceId) {
		return (
			<div className="flex h-[60vh] items-center justify-center">
				<div className="text-center">
					<AlertCircle className="mx-auto h-12 w-12 text-yellow-400" />
					<h2 className="mt-4 text-xl font-semibold text-white">No Instance Selected</h2>
					<p className="mt-2 text-white/60">Please select an instance to view sync history</p>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex h-[60vh] items-center justify-center">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
				<span className="ml-3 text-white/60">Loading sync history...</span>
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex h-[60vh] items-center justify-center">
				<div className="text-center">
					<XCircle className="mx-auto h-12 w-12 text-red-400" />
					<h2 className="mt-4 text-xl font-semibold text-white">Error Loading History</h2>
					<p className="mt-2 text-white/60">{error.message}</p>
				</div>
			</div>
		);
	}

	const totalPages = data ? Math.ceil(data.total / limit) : 0;

	return (
		<div className="space-y-6 p-6">
			{/* Header */}
			<div>
				<h1 className="text-2xl font-bold text-white">Sync History</h1>
				<p className="mt-1 text-white/60">
					{data?.total || 0} sync operation{data?.total !== 1 ? "s" : ""} recorded
				</p>
			</div>

			{/* History Table */}
			{data && data.syncs.length > 0 ? (
				<div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
					<table className="w-full">
						<thead className="border-b border-white/10 bg-white/5">
							<tr>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Template
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Status
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Type
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Results
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Started
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Duration
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Actions
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/10">
							{data.syncs.map((sync) => {
								const StatusIcon = STATUS_ICONS[sync.status as keyof typeof STATUS_ICONS] || AlertCircle;
								const statusColor = STATUS_COLORS[sync.status as keyof typeof STATUS_COLORS] || "";

								return (
									<tr
										key={sync.id}
										className="transition hover:bg-white/5"
										onClick={() => handleViewDetails(sync.id)}
									>
										<td className="px-6 py-4">
											<div className="flex items-center gap-2">
												<span className="font-medium text-white">{sync.templateName}</span>
											</div>
										</td>
										<td className="px-6 py-4">
											<div
												className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusColor}`}
											>
												<StatusIcon className="h-3.5 w-3.5" />
												{sync.status.replace("_", " ")}
											</div>
										</td>
										<td className="px-6 py-4">
											<span className="text-sm text-white/80">{sync.syncType}</span>
										</td>
										<td className="px-6 py-4">
											<div className="flex items-center gap-3 text-xs">
												<span className="text-green-400">✓ {sync.configsApplied}</span>
												{sync.configsFailed > 0 && (
													<span className="text-red-400">✗ {sync.configsFailed}</span>
												)}
												{sync.configsSkipped > 0 && (
													<span className="text-yellow-400">⊘ {sync.configsSkipped}</span>
												)}
											</div>
										</td>
										<td className="px-6 py-4">
											<div className="flex items-center gap-1.5 text-sm text-white/60">
												<Calendar className="h-3.5 w-3.5" />
												{formatDate(sync.startedAt)}
											</div>
										</td>
										<td className="px-6 py-4">
											<div className="flex items-center gap-1.5 text-sm text-white/60">
												<Clock className="h-3.5 w-3.5" />
												{formatDuration(sync.duration)}
											</div>
										</td>
										<td className="px-6 py-4">
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													handleViewDetails(sync.id);
												}}
												className="flex items-center gap-1 text-sm text-primary transition hover:text-primary/80"
											>
												View Details
												<ChevronRight className="h-4 w-4" />
											</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			) : (
				<div className="flex h-[40vh] items-center justify-center rounded-xl border border-white/10 bg-white/5">
					<div className="text-center">
						<Clock className="mx-auto h-12 w-12 text-white/40" />
						<h3 className="mt-4 text-lg font-medium text-white">No Sync History</h3>
						<p className="mt-2 text-white/60">No sync operations have been performed yet</p>
					</div>
				</div>
			)}

			{/* Pagination */}
			{totalPages > 1 && (
				<div className="flex items-center justify-between">
					<p className="text-sm text-white/60">
						Page {page + 1} of {totalPages}
					</p>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => setPage((p) => Math.max(0, p - 1))}
							disabled={page === 0}
							className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
						>
							Previous
						</button>
						<button
							type="button"
							onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
							disabled={page >= totalPages - 1}
							className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
						>
							Next
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
