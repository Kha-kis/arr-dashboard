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
import { useState, useRef, useEffect } from "react";
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
	const rawSyncId = Array.isArray(params.syncId) ? params.syncId[0] : params.syncId;
	const syncId = rawSyncId ?? null;

	const { data: sync, isLoading, error } = useSyncDetail(syncId);
	const rollbackMutation = useRollbackSync();

	const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);
	
	// Accessibility refs for modal
	const modalRef = useRef<HTMLDivElement>(null);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const previousActiveElementRef = useRef<HTMLElement | null>(null);

	const handleRollback = async () => {
		if (!sync?.instanceId) {
			setShowRollbackConfirm(false);
			toast.error("Cannot rollback: sync data is unavailable");
			return;
		}

		try {
			await rollbackMutation.mutateAsync({
				syncId: syncId!,
				instanceId: sync.instanceId,
			});
			setShowRollbackConfirm(false);
			toast.success("Rollback completed successfully");
		} catch (error) {
			console.error("Rollback failed:", error);
			toast.error("Rollback failed. Please try again.");
		}
	};

	// Focus management and accessibility for modal
	useEffect(() => {
		if (!showRollbackConfirm) return;

		// Save the element that had focus before opening
		previousActiveElementRef.current = document.activeElement as HTMLElement;

		// Prevent body scrolling
		document.body.style.overflow = "hidden";

		// Focus the modal container or title when opened
		const focusTarget = titleRef.current || modalRef.current;
		if (focusTarget) {
			// Use setTimeout to ensure the modal is rendered
			setTimeout(() => {
				if (titleRef.current) {
					titleRef.current.focus();
				} else if (modalRef.current) {
					modalRef.current.focus();
				}
			}, 0);
		}

		// Get all focusable elements within the modal
		const getFocusableElements = (): HTMLElement[] => {
			if (!modalRef.current) return [];
			const focusableSelectors = [
				'button:not([disabled])',
				'[href]',
				'input:not([disabled])',
				'select:not([disabled])',
				'textarea:not([disabled])',
				'[tabindex]:not([tabindex="-1"])',
			].join(', ');
			return Array.from(modalRef.current.querySelectorAll<HTMLElement>(focusableSelectors));
		};

		// Handle keyboard events
		const handleKeyDown = (e: KeyboardEvent) => {
			// Escape key: close modal only if not pending
			if (e.key === "Escape" && !rollbackMutation.isPending) {
				setShowRollbackConfirm(false);
				return;
			}

			// Focus trap: cycle focus within modal
			if (e.key === "Tab" && modalRef.current) {
				const focusableElements = getFocusableElements();
				if (focusableElements.length === 0) return;

				const firstElement = focusableElements[0];
				const lastElement = focusableElements[focusableElements.length - 1];

				if (e.shiftKey) {
					// Shift+Tab: if on first element, wrap to last
					if (document.activeElement === firstElement && lastElement) {
						e.preventDefault();
						lastElement.focus();
					}
				} else {
					// Tab: if on last element, wrap to first
					if (document.activeElement === lastElement && firstElement) {
						e.preventDefault();
						firstElement.focus();
					}
				}
			}
		};

		document.addEventListener("keydown", handleKeyDown);

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.body.style.overflow = "";
			
			// Restore focus to the element that had focus before opening
			if (previousActiveElementRef.current) {
				previousActiveElementRef.current.focus();
			}
		};
	}, [showRollbackConfirm, rollbackMutation.isPending]);

	const formatDuration = (ms: number | null) => {
		if (!ms) return "N/A";
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;
	};

	const formatDate = (isoString: string) => {
		return new Date(isoString).toLocaleString(undefined, {
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
				<span className="ml-3 text-fg-muted">Loading sync details...</span>
			</div>
		);
	}

	if (error || !sync) {
		return (
			<div className="flex h-[60vh] items-center justify-center">
				<div className="text-center">
					<XCircle className="mx-auto h-12 w-12 text-red-400" />
					<h2 className="mt-4 text-xl font-semibold text-fg">Error Loading Details</h2>
					<p className="mt-2 text-fg-muted">{error?.message || "Sync not found"}</p>
					<button
						type="button"
						onClick={() => router.back()}
						className="mt-4 rounded-lg border border-border bg-bg-subtle px-4 py-2 text-sm font-medium text-fg transition hover:bg-bg-subtle/80"
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
						className="rounded-lg border border-border bg-bg-subtle p-2 text-fg transition hover:bg-bg-subtle/80"
					>
						<ArrowLeft className="h-5 w-5" />
					</button>
					<div>
						<h1 className="text-2xl font-bold text-fg">Sync Details</h1>
						<p className="mt-1 text-fg-muted">
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

				<div className="rounded-xl border border-border bg-bg-subtle p-4">
					<div className="flex items-center gap-2 text-fg-muted">
						<Calendar className="h-4 w-4" />
						<span className="text-sm font-medium">Started</span>
					</div>
					<p className="mt-2 text-sm text-fg">{formatDate(sync.startedAt)}</p>
				</div>

				<div className="rounded-xl border border-border bg-bg-subtle p-4">
					<div className="flex items-center gap-2 text-fg-muted">
						<Clock className="h-4 w-4" />
						<span className="text-sm font-medium">Duration</span>
					</div>
					<p className="mt-2 text-sm text-fg">{formatDuration(sync.duration)}</p>
				</div>

				<div className="rounded-xl border border-border bg-bg-subtle p-4">
					<div className="flex items-center gap-2 text-fg-muted">
						<Database className="h-4 w-4" />
						<span className="text-sm font-medium">Backup</span>
					</div>
					<p className="mt-2 text-sm text-fg">{sync.backupId ? "Available" : "N/A"}</p>
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
				<div className="rounded-xl border border-border bg-bg-subtle p-6">
					<h2 className="mb-4 text-lg font-semibold text-fg">Applied Configurations</h2>
					<div className="space-y-2">
						{sync.appliedConfigs.map((config: any, index: number) => (
							<div
								key={index}
								className="flex items-center justify-between rounded-lg border border-border bg-bg-subtle p-3"
							>
								<span className="font-medium text-fg">{config.name}</span>
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
				<div className="rounded-xl border border-border bg-bg-subtle p-6">
					<h2 className="mb-4 text-lg font-semibold text-fg">Error Log</h2>
					<pre className="overflow-x-auto rounded-lg bg-black/40 p-4 text-xs text-red-300">
						{sync.errorLog}
					</pre>
				</div>
			)}

			{/* Rollback Confirmation Modal */}
			{showRollbackConfirm && (
				<div 
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
					aria-hidden="true"
					onClick={(e) => {
						// Close on backdrop click only if not pending
						if (e.target === e.currentTarget && !rollbackMutation.isPending) {
							setShowRollbackConfirm(false);
						}
					}}
				>
					<div
						ref={modalRef}
						tabIndex={-1}
						role="dialog"
						aria-modal="true"
						aria-labelledby="rollback-confirm-title"
						aria-describedby="rollback-confirm-description"
						className="w-full max-w-md rounded-xl border border-border bg-bg p-6 focus:outline-none"
						onClick={(e) => e.stopPropagation()}
					>
						<h3 
							id="rollback-confirm-title"
							ref={titleRef}
							tabIndex={-1}
							className="text-xl font-semibold text-fg focus:outline-none"
						>
							Confirm Rollback
						</h3>
						<p 
							id="rollback-confirm-description"
							className="mt-2 text-sm text-fg-muted"
						>
							This will restore the instance to its state before this sync operation. All configurations
							applied during this sync will be removed.
						</p>
						<div className="mt-6 flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setShowRollbackConfirm(false)}
								disabled={rollbackMutation.isPending}
								className="rounded-lg border border-border bg-bg-subtle px-4 py-2 text-sm font-medium text-fg transition hover:bg-bg-subtle/80 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleRollback}
								disabled={rollbackMutation.isPending}
								className="flex items-center gap-2 rounded-lg bg-yellow-500 px-4 py-2 text-sm font-medium text-black transition hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed"
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
							<div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3" role="alert">
								<p className="text-sm text-red-300">{rollbackMutation.error.message}</p>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
