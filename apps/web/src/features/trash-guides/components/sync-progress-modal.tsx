"use client";

import { useEffect, useRef, useCallback } from "react";
import { CheckCircle2, XCircle, Loader2, AlertCircle } from "lucide-react";
import { useSyncProgress } from "../../../hooks/api/useSync";
import type { SyncProgressStatus } from "../../../lib/api-client/sync";
import { Button } from "../../../components/ui";

const FOCUSABLE_SELECTOR =
	'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface SyncProgressModalProps {
	syncId: string;
	templateName: string;
	instanceName: string;
	/**
	 * Callback fired when sync completes successfully.
	 * IMPORTANT: Parent components should wrap this in useCallback to ensure
	 * stable reference and prevent multiple invocations.
	 */
	onComplete: () => void;
	onClose: () => void;
}

const STAGE_ORDER: SyncProgressStatus[] = [
	"INITIALIZING",
	"VALIDATING",
	"BACKING_UP",
	"APPLYING",
	"COMPLETED",
];

const STAGE_LABELS: Record<SyncProgressStatus, string> = {
	INITIALIZING: "Initializing",
	VALIDATING: "Validating",
	BACKING_UP: "Creating Backup",
	APPLYING: "Applying Configurations",
	COMPLETED: "Completed",
	FAILED: "Failed",
};

export const SyncProgressModal = ({
	syncId,
	templateName,
	instanceName,
	onComplete,
	onClose,
}: SyncProgressModalProps) => {
	const { progress, error, isLoading, isPolling } = useSyncProgress(syncId);

	// Track whether completion callback has been scheduled to prevent duplicate calls
	const completionScheduledRef = useRef(false);

	// Accessibility refs
	const dialogRef = useRef<HTMLDivElement>(null);
	const previousActiveElementRef = useRef<HTMLElement | null>(null);

	// Handle Escape key to close modal
	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (event.key === "Escape") {
				const currentStage = progress?.status || "INITIALIZING";
				const isFailed = currentStage === "FAILED";
				const isCompleted = currentStage === "COMPLETED";
				// Only allow closing when sync is finished
				if (isCompleted || isFailed) {
					onClose();
				}
			}

			// Focus trap: cycle focus within modal
			if (event.key === "Tab" && dialogRef.current) {
				const focusableElements = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
				const firstElement = focusableElements[0];
				const lastElement = focusableElements[focusableElements.length - 1];

				if (focusableElements.length === 0) return;

				if (event.shiftKey && document.activeElement === firstElement) {
					event.preventDefault();
					lastElement?.focus();
				} else if (!event.shiftKey && document.activeElement === lastElement) {
					event.preventDefault();
					firstElement?.focus();
				}
			}
		},
		[onClose, progress?.status]
	);

	// Focus management: save previous focus, set initial focus, restore on close
	useEffect(() => {
		// Save the previously focused element
		previousActiveElementRef.current = document.activeElement as HTMLElement;

		// Set initial focus to the dialog
		if (dialogRef.current) {
			dialogRef.current.focus();
		}

		// Add keyboard event listener
		document.addEventListener("keydown", handleKeyDown);

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			// Restore focus to previously focused element on unmount
			if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === "function") {
				previousActiveElementRef.current.focus();
			}
		};
	}, [handleKeyDown]);

	// Auto-call onComplete when sync finishes successfully
	// Uses ref flag to ensure callback is only scheduled once per completion
	useEffect(() => {
		if (progress?.status === "COMPLETED" && !completionScheduledRef.current) {
			completionScheduledRef.current = true;
			const timeoutId = setTimeout(() => {
				onComplete();
			}, 2000); // Give user time to see completion
			return () => {
				clearTimeout(timeoutId);
				// Reset flag if effect cleanup runs before timeout fires
				// (e.g., component unmounts or syncId changes)
				completionScheduledRef.current = false;
			};
		}
	}, [progress?.status, onComplete]);

	const currentStage = progress?.status || "INITIALIZING";
	const rawStageIndex = STAGE_ORDER.indexOf(currentStage);
	// Handle FAILED status which is not in STAGE_ORDER - clamp to valid range
	const currentStageIndex = currentStage === "FAILED"
		? STAGE_ORDER.length - 1
		: Math.max(0, rawStageIndex);
	const isFailed = currentStage === "FAILED";
	const isCompleted = currentStage === "COMPLETED";

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="sync-progress-title"
				aria-describedby="sync-progress-description"
				tabIndex={-1}
				className="w-full max-w-3xl rounded-xl border border-border bg-bg shadow-2xl outline-none"
			>
				{/* Header */}
				<div className="border-b border-border p-6">
					<div className="flex items-center justify-between">
						<div>
							<h2 id="sync-progress-title" className="text-xl font-semibold text-fg">Sync Progress</h2>
							<p id="sync-progress-description" className="mt-1 text-sm text-fg-muted">
								Template: <span className="font-medium text-fg">{templateName}</span> →
								Instance: <span className="font-medium text-fg">{instanceName}</span>
							</p>
						</div>
						{isPolling && (
							<span className="rounded-full bg-yellow-500/10 px-3 py-1 text-xs font-medium text-yellow-400">
								Polling Mode
							</span>
						)}
					</div>
				</div>

				{/* Content */}
				<div className="p-6">
					{isLoading && (
						<div className="flex items-center justify-center py-12">
							<div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
							<span className="ml-3 text-fg-muted">Connecting...</span>
						</div>
					)}

					{!isLoading && progress && (
						<div className="space-y-6">
							{/* 5-Stage Stepper */}
							<div className="relative">
								<div className="flex items-center justify-between">
									{STAGE_ORDER.map((stage, index, visibleStages) => {
										const isActive = currentStageIndex === index;
										const isPast = currentStageIndex > index;
										const isCurrentFailed = isFailed && currentStageIndex === index;

										return (
											<div key={stage} className="flex flex-1 items-center">
												{/* Stage Circle */}
												<div className="relative flex flex-col items-center">
													<div
														className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition ${
															isCurrentFailed
																? "border-red-500 bg-red-500/10"
																: isPast || isCompleted
																	? "border-green-500 bg-green-500/10"
																	: isActive
																		? "border-primary bg-primary/10"
																		: "border-border bg-bg-subtle"
														}`}
													>
														{isCurrentFailed ? (
															<XCircle className="h-5 w-5 text-red-400" />
														) : isPast || isCompleted ? (
															<CheckCircle2 className="h-5 w-5 text-green-400" />
														) : isActive ? (
															<Loader2 className="h-5 w-5 animate-spin text-primary" />
														) : (
															<span className="text-sm font-medium text-fg-muted">{index + 1}</span>
														)}
													</div>
													<span
														className={`mt-2 text-xs font-medium ${
															isActive ? "text-fg" : "text-fg-muted"
														}`}
													>
														{STAGE_LABELS[stage]}
													</span>
												</div>

												{/* Connector Line - render for all but last stage */}
												{index < visibleStages.length - 1 && (
													<div
														className={`mx-2 h-0.5 flex-1 transition ${
															isPast || isCompleted ? "bg-green-500" : "bg-border"
														}`}
													/>
												)}
											</div>
										);
									})}
								</div>
							</div>

							{/* Progress Bar */}
							<div>
								<div className="mb-2 flex items-center justify-between text-sm">
									<span className="font-medium text-fg">{progress.currentStep}</span>
									<span className="text-fg-muted">{Math.round(progress.progress)}%</span>
								</div>
								<div className="h-2 overflow-hidden rounded-full bg-bg-subtle">
									<div
										className={`h-full transition-all duration-300 ${
											isFailed ? "bg-red-500" : isCompleted ? "bg-green-500" : "bg-primary"
										}`}
										style={{ width: `${progress.progress}%` }}
									/>
								</div>
							</div>

							{/* Statistics */}
							<div className="grid grid-cols-3 gap-4">
								<div className="rounded-lg border border-border bg-bg-subtle p-4">
									<p className="text-sm text-fg-muted">Total Configs</p>
									<p className="mt-1 text-2xl font-semibold text-fg">{progress.totalConfigs}</p>
								</div>
								<div className="rounded-lg border border-green-500/20 bg-green-500/10 p-4">
									<p className="text-sm text-green-400">Applied</p>
									<p className="mt-1 text-2xl font-semibold text-green-300">
										{progress.appliedConfigs}
									</p>
								</div>
								<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
									<p className="text-sm text-red-400">Failed</p>
									<p className="mt-1 text-2xl font-semibold text-red-300">{progress.failedConfigs}</p>
								</div>
							</div>

							{/* Errors */}
							{progress.errors.length > 0 && (
								<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
									<div className="flex items-start gap-3">
										<AlertCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
										<div className="flex-1">
											<h3 className="font-medium text-red-200">
												{progress.errors.length} Error{progress.errors.length !== 1 ? "s" : ""}{" "}
												Occurred
											</h3>
											<ul className="mt-2 space-y-1 text-sm text-red-300">
												{progress.errors.map((errItem, index) => (
													<li key={index}>
														<span className="font-medium">{errItem.configName}:</span> {errItem.error}
														{errItem.retryable && (
															<span className="ml-2 text-xs text-red-400">(retryable)</span>
														)}
													</li>
												))}
											</ul>
										</div>
									</div>
								</div>
							)}

							{/* Success Message */}
							{isCompleted && progress.errors.length === 0 && (
								<div className="rounded-lg border border-green-500/20 bg-green-500/10 p-4">
									<div className="flex items-center gap-3">
										<CheckCircle2 className="h-5 w-5 text-green-400" />
										<div>
											<h3 className="font-medium text-green-200">Sync Completed Successfully</h3>
											<p className="mt-0.5 text-sm text-green-300">
												All configurations have been applied to {instanceName}
											</p>
										</div>
									</div>
								</div>
							)}
						</div>
					)}

					{error && (
						<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
							<div className="flex items-start gap-3">
								<XCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
								<div>
									<h3 className="font-medium text-red-200">Connection Error</h3>
									<p className="mt-1 text-sm text-red-300">{error.message}</p>
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-end gap-3 border-t border-border p-6">
					{(isCompleted || isFailed) && (
						<Button variant="secondary" onClick={onClose}>
							Close
						</Button>
					)}
					{!isCompleted && !isFailed && (
						<div className="flex items-center gap-2 text-sm text-fg-muted">
							<Loader2 className="h-4 w-4 animate-spin" />
							Sync in progress...
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
