"use client";

import { useParams, useRouter } from "next/navigation";
import {
	ArrowLeft,
	Calendar,
	Clock,
	CheckCircle2,
	XCircle,
	AlertCircle,
	Database,
	RotateCcw,
} from "lucide-react";
import { useSyncDetail, useRollbackSync } from "../../../../../hooks/api/useSync";
import { useState } from "react";
import { toast } from "sonner";

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

export default function SyncDetailPage() {
	const params = useParams();
	const router = useRouter();
	const syncId = params.syncId as string;

	const { data: sync, isLoading, error } = useSyncDetail(syncId);
	const rollbackMutation = useRollbackSync();

	const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);

	const handleRollback = async () => {
		try {
			await rollbackMutation.mutateAsync({
				syncId,
				instanceId: sync?.instanceId,
			});
			setShowRollbackConfirm(false);
			toast.success("Rollback completed successfully");
		} catch (error) {
			console.error("Rollback failed:", error);
			toast.error("Rollback failed. Please try again.");
		}
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
			second: "2-digit",
		});
	};

	if (isLoading) {
		return (
			<div className="flex h-[60vh] items-center justify-center">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
				<span className="ml-3 text-white/60">Loading sync details...</span>
			</div>
		);
	}

	if (error || !sync) {
		return (
			<div className="flex h-[60vh] items-center justify-center">
				<div className="text-center">
					<XCircle className="mx-auto h-12 w-12 text-red-400" />
					<h2 className="mt-4 text-xl font-semibold text-white">Error Loading Details</h2>
					<p className="mt-2 text-white/60">{error?.message || "Sync not found"}</p>
					<button
						type="button"
						onClick={() => router.back()}
						className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
					>
						Go Back
					</button>
				</div>
			</div>
		);
	}

	const StatusIcon = STATUS_ICONS[sync.status as keyof typeof STATUS_ICONS] || AlertCircle;
	const statusColor = STATUS_COLORS[sync.status as keyof typeof STATUS_COLORS] || "";

	return (
		<div className="space-y-6 p-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<button
						type="button"
						onClick={() => router.back()}
						className="rounded-lg bg-white/10 p-2 text-white transition hover:bg-white/20"
					>
						<ArrowLeft className="h-5 w-5" />
					</button>
					<div>
						<h1 className="text-2xl font-bold text-white">Sync Details</h1>
						<p className="mt-1 text-white/60">
							{sync.templateName} → {sync.instanceName}
						</p>
					</div>
				</div>

				{sync.backupId && (
					<button
						type="button"
						onClick={() => setShowRollbackConfirm(true)}
						className="flex items-center gap-2 rounded-lg bg-yellow-500/10 px-4 py-2 text-sm font-medium text-yellow-400 transition hover:bg-yellow-500/20"
					>
						<RotateCcw className="h-4 w-4" />
						Rollback
					</button>
				)}
			</div>

			{/* Status Overview */}
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
				<div className={`rounded-xl border p-4 ${statusColor}`}>
					<div className="flex items-center gap-2">
						<StatusIcon className="h-5 w-5" />
						<span className="text-sm font-medium">Status</span>
					</div>
					<p className="mt-2 text-lg font-semibold">{sync.status.replace("_", " ")}</p>
				</div>

				<div className="rounded-xl border border-white/10 bg-white/5 p-4">
					<div className="flex items-center gap-2 text-white/60">
						<Calendar className="h-4 w-4" />
						<span className="text-sm font-medium">Started</span>
					</div>
					<p className="mt-2 text-sm text-white">{formatDate(sync.startedAt)}</p>
				</div>

				<div className="rounded-xl border border-white/10 bg-white/5 p-4">
					<div className="flex items-center gap-2 text-white/60">
						<Clock className="h-4 w-4" />
						<span className="text-sm font-medium">Duration</span>
					</div>
					<p className="mt-2 text-sm text-white">{formatDuration(sync.duration)}</p>
				</div>

				<div className="rounded-xl border border-white/10 bg-white/5 p-4">
					<div className="flex items-center gap-2 text-white/60">
						<Database className="h-4 w-4" />
						<span className="text-sm font-medium">Backup</span>
					</div>
					<p className="mt-2 text-sm text-white">{sync.backupId ? "Available" : "N/A"}</p>
				</div>
			</div>

			{/* Results Summary */}
			<div className="grid grid-cols-3 gap-4">
				<div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
					<p className="text-sm text-green-400">Applied</p>
					<p className="mt-1 text-3xl font-bold text-green-300">{sync.configsApplied}</p>
				</div>
				<div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
					<p className="text-sm text-red-400">Failed</p>
					<p className="mt-1 text-3xl font-bold text-red-300">{sync.configsFailed}</p>
				</div>
				<div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-4">
					<p className="text-sm text-yellow-400">Skipped</p>
					<p className="mt-1 text-3xl font-bold text-yellow-300">{sync.configsSkipped}</p>
				</div>
			</div>

			{/* Applied Configurations */}
			{sync.appliedConfigs && sync.appliedConfigs.length > 0 && (
				<div className="rounded-xl border border-white/10 bg-white/5 p-6">
					<h2 className="mb-4 text-lg font-semibold text-white">Applied Configurations</h2>
					<div className="space-y-2">
						{sync.appliedConfigs.map((config: any, index: number) => (
							<div
								key={index}
								className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-3"
							>
								<span className="font-medium text-white">{config.name}</span>
								<CheckCircle2 className="h-5 w-5 text-green-400" />
							</div>
						))}
					</div>
				</div>
			)}

			{/* Failed Configurations */}
			{sync.failedConfigs && sync.failedConfigs.length > 0 && (
				<div className="rounded-xl border border-red-500/20 bg-red-500/10 p-6">
					<h2 className="mb-4 text-lg font-semibold text-red-200">Failed Configurations</h2>
					<div className="space-y-2">
						{sync.failedConfigs.map((config: any, index: number) => (
							<div
								key={index}
								className="flex items-start justify-between rounded-lg border border-red-500/20 bg-red-500/10 p-3"
							>
								<div className="flex-1">
									<p className="font-medium text-red-200">{config.name}</p>
									{config.error && <p className="mt-1 text-sm text-red-300">{config.error}</p>}
								</div>
								<XCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
							</div>
						))}
					</div>
				</div>
			)}

			{/* Error Log */}
			{sync.errorLog && (
				<div className="rounded-xl border border-white/10 bg-white/5 p-6">
					<h2 className="mb-4 text-lg font-semibold text-white">Error Log</h2>
					<pre className="overflow-x-auto rounded-lg bg-black/40 p-4 text-xs text-red-300">
						{sync.errorLog}
					</pre>
				</div>
			)}

			{/* Rollback Confirmation Modal */}
			{showRollbackConfirm && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
					<div className="w-full max-w-md rounded-xl border border-white/10 bg-gray-900 p-6">
						<h3 className="text-xl font-semibold text-white">Confirm Rollback</h3>
						<p className="mt-2 text-sm text-white/60">
							This will restore the instance to its state before this sync operation. All configurations
							applied during this sync will be removed.
						</p>
						<div className="mt-6 flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setShowRollbackConfirm(false)}
								disabled={rollbackMutation.isPending}
								className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleRollback}
								disabled={rollbackMutation.isPending}
								className="flex items-center gap-2 rounded-lg bg-yellow-500 px-4 py-2 text-sm font-medium text-black transition hover:bg-yellow-400 disabled:opacity-50"
							>
								{rollbackMutation.isPending ? (
									<>
										<div className="h-4 w-4 animate-spin rounded-full border-2 border-black border-t-transparent" />
										Rolling back...
									</>
								) : (
									<>
										<RotateCcw className="h-4 w-4" />
										Confirm Rollback
									</>
								)}
							</button>
						</div>
						{rollbackMutation.error && (
							<div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3">
								<p className="text-sm text-red-300">{rollbackMutation.error.message}</p>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
