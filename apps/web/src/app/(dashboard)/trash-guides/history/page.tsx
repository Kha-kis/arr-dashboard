"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Calendar, Clock, CheckCircle2, XCircle, AlertCircle, ChevronRight, ChevronLeft } from "lucide-react";
import { useSyncHistory } from "../../../../hooks/api/useSync";
import { Button, Badge } from "../../../../components/ui";

const STATUS_ICONS = {
	SUCCESS: CheckCircle2,
	PARTIAL_SUCCESS: AlertCircle,
	FAILED: XCircle,
};

const STATUS_BADGE_VARIANTS: Record<string, "success" | "warning" | "danger" | "default"> = {
	SUCCESS: "success",
	PARTIAL_SUCCESS: "warning",
	FAILED: "danger",
};

export default function SyncHistoryPage() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const instanceId = searchParams.get("instanceId");

	const [page, setPage] = useState(0);
	const limit = 20;

	// Reset pagination when instanceId changes
	useEffect(() => {
		setPage(0);
	}, [instanceId]);

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
								const statusVariant = STATUS_BADGE_VARIANTS[sync.status as keyof typeof STATUS_BADGE_VARIANTS] || "default";

								return (
									<tr
										key={sync.id}
										className="transition hover:bg-white/5 cursor-pointer"
										onClick={() => handleViewDetails(sync.id)}
									>
										<td className="px-6 py-4">
											<div className="flex items-center gap-2">
												<span className="font-medium text-white">{sync.templateName}</span>
											</div>
										</td>
										<td className="px-6 py-4">
											<Badge variant={statusVariant} size="sm" className="gap-1.5">
												<StatusIcon className="h-3.5 w-3.5" />
												{sync.status.replace("_", " ")}
											</Badge>
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
											<Button
												variant="ghost"
												size="sm"
												onClick={(e) => {
													e.stopPropagation();
													handleViewDetails(sync.id);
												}}
												className="gap-1.5"
											>
												View Details
												<ChevronRight className="h-4 w-4" />
											</Button>
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
					<p className="text-sm text-white/70">
						Page <span className="font-medium text-white">{page + 1}</span> of{" "}
						<span className="font-medium text-white">{totalPages}</span>
					</p>
					<div className="flex gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setPage((p) => Math.max(0, p - 1))}
							disabled={page === 0}
							className="gap-1.5"
						>
							<ChevronLeft className="h-4 w-4" />
							Previous
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
							disabled={page >= totalPages - 1}
							className="gap-1.5"
						>
							Next
							<ChevronRight className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
