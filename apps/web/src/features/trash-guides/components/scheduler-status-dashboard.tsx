"use client";

import { useSchedulerStatus, useTriggerUpdateCheck } from "../../../hooks/api/useTemplateUpdates";
import { RefreshCw, Clock, CheckCircle2, AlertCircle, Play } from "lucide-react";
import { Alert, AlertDescription, Skeleton } from "../../../components/ui";
import { formatDistanceToNow } from "date-fns";

export const SchedulerStatusDashboard = () => {
	const { data, isLoading, error, refetch } = useSchedulerStatus({
		refetchInterval: 60000, // Refresh every minute
	});
	const triggerCheck = useTriggerUpdateCheck();

	const handleManualTrigger = async () => {
		if (
			!confirm(
				"Manually trigger an update check? This will check for TRaSH Guides updates immediately.",
			)
		) {
			return;
		}

		try {
			await triggerCheck.mutateAsync();
			// Refetch status after a brief delay
			setTimeout(() => refetch(), 2000);
		} catch (error) {
			console.error("Failed to trigger update check:", error);
			alert("Failed to trigger update check. Please try again.");
		}
	};

	if (isLoading) {
		return <Skeleton className="h-64" />;
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertDescription>
					Failed to load scheduler status:{" "}
					{error instanceof Error ? error.message : "Please try again"}
				</AlertDescription>
			</Alert>
		);
	}

	const schedulerData = data?.data;

	if (!schedulerData) {
		return (
			<Alert variant="info">
				<AlertDescription>
					Scheduler status not available
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<div className="rounded-xl border border-white/10 bg-white/5 p-6">
			<div className="space-y-6">
				{/* Header */}
				<div className="flex items-center justify-between">
					<div>
						<h3 className="text-lg font-semibold text-fg">
							TRaSH Guides Update Scheduler
						</h3>
						<p className="text-sm text-fg-muted mt-1">
							Automatic update checking and synchronization
						</p>
					</div>
					<div className="flex items-center gap-2">
						{schedulerData.isRunning ? (
							<span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 text-sm font-medium">
								<span className="relative flex h-2 w-2">
									<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
									<span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
								</span>
								Running
							</span>
						) : (
							<span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-500/10 text-gray-600 dark:text-gray-400 text-sm font-medium">
								<span className="h-2 w-2 rounded-full bg-gray-500" />
								Stopped
							</span>
						)}
					</div>
				</div>

				{/* Stats Grid */}
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
					{/* Last Check */}
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<div className="flex items-center gap-2 text-fg-muted mb-2">
							<Clock className="h-4 w-4" />
							<span className="text-xs font-medium">Last Check</span>
						</div>
						<p className="text-lg font-semibold text-fg">
							{schedulerData.lastCheckAt
								? formatDistanceToNow(new Date(schedulerData.lastCheckAt), {
										addSuffix: true,
								  })
								: "Never"}
						</p>
					</div>

					{/* Next Check */}
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<div className="flex items-center gap-2 text-fg-muted mb-2">
							<RefreshCw className="h-4 w-4" />
							<span className="text-xs font-medium">Next Check</span>
						</div>
						<p className="text-lg font-semibold text-fg">
							{schedulerData.nextCheckAt
								? formatDistanceToNow(new Date(schedulerData.nextCheckAt), {
										addSuffix: true,
								  })
								: "Not scheduled"}
						</p>
					</div>

					{/* Templates Checked */}
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<div className="flex items-center gap-2 text-fg-muted mb-2">
							<CheckCircle2 className="h-4 w-4" />
							<span className="text-xs font-medium">Templates Checked</span>
						</div>
						<p className="text-lg font-semibold text-fg">
							{schedulerData.lastCheckResult?.templatesChecked ?? 0}
						</p>
					</div>

					{/* Outdated */}
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<div className="flex items-center gap-2 text-fg-muted mb-2">
							<AlertCircle className="h-4 w-4" />
							<span className="text-xs font-medium">Outdated</span>
						</div>
						<p className="text-lg font-semibold text-fg">
							{schedulerData.lastCheckResult?.templatesOutdated ?? 0}
						</p>
					</div>
				</div>

				{/* Last Check Results */}
				{schedulerData.lastCheckResult && (
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<h4 className="text-sm font-medium text-fg mb-3">
							Last Check Results
						</h4>

						{/* Template Results */}
						<div className="mb-4">
							<h5 className="text-xs font-medium text-fg-muted mb-2">Templates</h5>
							<div className="grid gap-3 md:grid-cols-3">
								<div>
									<span className="text-xs text-fg-muted">Auto-synced</span>
									<p className="text-sm font-medium text-fg mt-1">
										{schedulerData.lastCheckResult.templatesAutoSynced}
									</p>
								</div>
								<div>
									<span className="text-xs text-fg-muted">
										Needing Attention
									</span>
									<p className="text-sm font-medium text-fg mt-1">
										{schedulerData.lastCheckResult.templatesNeedingAttention}
									</p>
								</div>
								<div>
									<span className="text-xs text-fg-muted">Errors</span>
									<p className="text-sm font-medium text-fg mt-1">
										{schedulerData.lastCheckResult.errors.length}
									</p>
								</div>
							</div>
						</div>

						{/* Cache Refresh Results */}
						<div className="pt-3 border-t border-white/10">
							<h5 className="text-xs font-medium text-fg-muted mb-2">Cache Refresh</h5>
							<div className="grid gap-3 md:grid-cols-2">
								<div>
									<span className="text-xs text-fg-muted">Caches Refreshed</span>
									<p className="text-sm font-medium text-green-600 dark:text-green-400 mt-1">
										{schedulerData.lastCheckResult.cachesRefreshed ?? 0}
									</p>
								</div>
								<div>
									<span className="text-xs text-fg-muted">Cache Failures</span>
									<p className="text-sm font-medium text-fg mt-1">
										{schedulerData.lastCheckResult.cachesFailed ?? 0}
									</p>
								</div>
							</div>
						</div>

						{schedulerData.lastCheckResult.errors.length > 0 && (
							<div className="mt-3 rounded border border-red-500/30 bg-red-500/10 p-3">
								<p className="text-xs font-medium text-red-600 dark:text-red-400 mb-2">
									Errors:
								</p>
								<ul className="text-xs text-fg-muted space-y-1">
									{schedulerData.lastCheckResult.errors.map((error, idx) => (
										<li key={idx}>• {error}</li>
									))}
								</ul>
							</div>
						)}
					</div>
				)}

				{/* Actions */}
				<div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
					<button
						type="button"
						onClick={handleManualTrigger}
						disabled={triggerCheck.isPending || !schedulerData.isRunning}
						className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
					>
						<Play className="h-4 w-4" />
						{triggerCheck.isPending ? "Triggering..." : "Trigger Check Now"}
					</button>
				</div>
			</div>
		</div>
	);
};
