"use client";

import { useEffect, useRef, useCallback } from "react";
import { CheckCircle2, XCircle, Loader2, AlertCircle, RefreshCw, Zap } from "lucide-react";
import { useSyncProgress } from "../../../hooks/api/useSync";
import type { SyncProgressStatus } from "../../../lib/api-client/sync";
import { Button } from "../../../components/ui";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

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

/**
 * Premium Sync Progress Modal
 *
 * Displays real-time sync progress with:
 * - Glassmorphic modal styling
 * - Theme-aware stepper and progress bar
 * - Animated stage transitions
 * - Semantic color feedback for success/error states
 */
export const SyncProgressModal = ({
	syncId,
	templateName,
	instanceName,
	onComplete,
	onClose,
}: SyncProgressModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();
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
		<div
			className="fixed inset-0 z-modal flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={(e) => {
				if (isCompleted || isFailed) {
					onClose();
				}
			}}
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

			{/* Modal */}
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="sync-progress-title"
				aria-describedby="sync-progress-description"
				tabIndex={-1}
				className="relative w-full max-w-3xl rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl outline-none animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${themeGradient.from}15`,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div
					className="border-b border-border/30 p-6"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}08, transparent)`,
					}}
				>
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-4">
							<div
								className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<RefreshCw
									className={`h-6 w-6 ${!isCompleted && !isFailed ? "animate-spin" : ""}`}
									style={{ color: themeGradient.from }}
								/>
							</div>
							<div>
								<h2
									id="sync-progress-title"
									className="text-xl font-bold"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
										WebkitBackgroundClip: "text",
										WebkitTextFillColor: "transparent",
									}}
								>
									Sync Progress
								</h2>
								<p id="sync-progress-description" className="mt-1 text-sm text-muted-foreground">
									Template: <span className="font-medium text-foreground">{templateName}</span> →
									Instance: <span className="font-medium text-foreground">{instanceName}</span>
								</p>
							</div>
						</div>
						{isPolling && (
							<span
								className="rounded-full px-3 py-1 text-xs font-medium"
								style={{
									backgroundColor: SEMANTIC_COLORS.warning.bg,
									color: SEMANTIC_COLORS.warning.text,
									border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
								}}
							>
								Polling Mode
							</span>
						)}
					</div>
				</div>

				{/* Content */}
				<div className="p-6">
					{isLoading && (
						<div className="flex items-center justify-center py-12">
							<div
								className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
								style={{ borderColor: `${themeGradient.from} transparent ${themeGradient.from} ${themeGradient.from}` }}
							/>
							<span className="ml-3 text-muted-foreground">Connecting...</span>
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
											<div
												key={stage}
												className="flex flex-1 items-center animate-in fade-in"
												style={{
													animationDelay: `${index * 100}ms`,
													animationFillMode: "backwards",
												}}
											>
												{/* Stage Circle */}
												<div className="relative flex flex-col items-center">
													<div
														className="flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all duration-300"
														style={{
															borderColor: isCurrentFailed
																? SEMANTIC_COLORS.error.from
																: isPast || isCompleted
																	? SEMANTIC_COLORS.success.from
																	: isActive
																		? themeGradient.from
																		: "rgba(var(--border))",
															backgroundColor: isCurrentFailed
																? SEMANTIC_COLORS.error.bg
																: isPast || isCompleted
																	? SEMANTIC_COLORS.success.bg
																	: isActive
																		? `${themeGradient.from}10`
																		: "transparent",
														}}
													>
														{isCurrentFailed ? (
															<XCircle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.error.from }} />
														) : isPast || isCompleted ? (
															<CheckCircle2 className="h-5 w-5" style={{ color: SEMANTIC_COLORS.success.from }} />
														) : isActive ? (
															<Loader2 className="h-5 w-5 animate-spin" style={{ color: themeGradient.from }} />
														) : (
															<span className="text-sm font-medium text-muted-foreground">{index + 1}</span>
														)}
													</div>
													<span
														className={`mt-2 text-xs font-medium ${
															isActive ? "text-foreground" : "text-muted-foreground"
														}`}
													>
														{STAGE_LABELS[stage]}
													</span>
												</div>

												{/* Connector Line - render for all but last stage */}
												{index < visibleStages.length - 1 && (
													<div
														className="mx-2 h-0.5 flex-1 transition-all duration-500"
														style={{
															backgroundColor: isPast || isCompleted
																? SEMANTIC_COLORS.success.from
																: "rgba(var(--border))",
														}}
													/>
												)}
											</div>
										);
									})}
								</div>
							</div>

							{/* Progress Bar */}
							<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4">
								<div className="mb-2 flex items-center justify-between text-sm">
									<span className="font-medium text-foreground">{progress.currentStep}</span>
									<span className="text-muted-foreground">{Math.round(progress.progress)}%</span>
								</div>
								<div className="h-3 overflow-hidden rounded-full bg-muted/30">
									<div
										className="h-full transition-all duration-500 rounded-full"
										style={{
											width: `${progress.progress}%`,
											background: isFailed
												? `linear-gradient(90deg, ${SEMANTIC_COLORS.error.from}, ${SEMANTIC_COLORS.error.to})`
												: isCompleted
													? `linear-gradient(90deg, ${SEMANTIC_COLORS.success.from}, ${SEMANTIC_COLORS.success.to})`
													: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
										}}
									/>
								</div>
							</div>

							{/* Statistics */}
							<div className="grid grid-cols-3 gap-4">
								<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4">
									<p className="text-sm text-muted-foreground">Total Configs</p>
									<p
										className="mt-1 text-2xl font-bold"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											WebkitBackgroundClip: "text",
											WebkitTextFillColor: "transparent",
										}}
									>
										{progress.totalConfigs}
									</p>
								</div>
								<div
									className="rounded-xl p-4"
									style={{
										backgroundColor: SEMANTIC_COLORS.success.bg,
										border: `1px solid ${SEMANTIC_COLORS.success.border}`,
									}}
								>
									<p className="text-sm" style={{ color: SEMANTIC_COLORS.success.text }}>Applied</p>
									<p className="mt-1 text-2xl font-bold" style={{ color: SEMANTIC_COLORS.success.from }}>
										{progress.appliedConfigs}
									</p>
								</div>
								<div
									className="rounded-xl p-4"
									style={{
										backgroundColor: SEMANTIC_COLORS.error.bg,
										border: `1px solid ${SEMANTIC_COLORS.error.border}`,
									}}
								>
									<p className="text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>Failed</p>
									<p className="mt-1 text-2xl font-bold" style={{ color: SEMANTIC_COLORS.error.from }}>
										{progress.failedConfigs}
									</p>
								</div>
							</div>

							{/* Errors */}
							{progress.errors.length > 0 && (
								<div
									className="rounded-xl p-4"
									style={{
										backgroundColor: SEMANTIC_COLORS.error.bg,
										border: `1px solid ${SEMANTIC_COLORS.error.border}`,
									}}
								>
									<div className="flex items-start gap-3">
										<AlertCircle
											className="h-5 w-5 flex-shrink-0 mt-0.5"
											style={{ color: SEMANTIC_COLORS.error.from }}
										/>
										<div className="flex-1">
											<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
												{progress.errors.length} Error{progress.errors.length !== 1 ? "s" : ""}{" "}
												Occurred
											</h3>
											<ul className="mt-2 space-y-1 text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
												{progress.errors.map((errItem, index) => (
													<li key={index}>
														<span className="font-medium">{errItem.configName}:</span> {errItem.error}
														{errItem.retryable && (
															<span className="ml-2 text-xs opacity-70">(retryable)</span>
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
								<div
									className="rounded-xl p-4 animate-in fade-in slide-in-from-bottom-2"
									style={{
										backgroundColor: SEMANTIC_COLORS.success.bg,
										border: `1px solid ${SEMANTIC_COLORS.success.border}`,
									}}
								>
									<div className="flex items-center gap-3">
										<div
											className="flex h-10 w-10 items-center justify-center rounded-full"
											style={{
												background: `linear-gradient(135deg, ${SEMANTIC_COLORS.success.from}30, ${SEMANTIC_COLORS.success.to}30)`,
											}}
										>
											<CheckCircle2 className="h-5 w-5" style={{ color: SEMANTIC_COLORS.success.from }} />
										</div>
										<div>
											<h3 className="font-semibold" style={{ color: SEMANTIC_COLORS.success.text }}>
												Sync Completed Successfully
											</h3>
											<p className="mt-0.5 text-sm opacity-80" style={{ color: SEMANTIC_COLORS.success.text }}>
												All configurations have been applied to {instanceName}
											</p>
										</div>
									</div>
								</div>
							)}
						</div>
					)}

					{error && (
						<div
							className="rounded-xl p-4"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<div className="flex items-start gap-3">
								<XCircle
									className="h-5 w-5 flex-shrink-0 mt-0.5"
									style={{ color: SEMANTIC_COLORS.error.from }}
								/>
								<div>
									<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
										Connection Error
									</h3>
									<p className="mt-1 text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
										{error.message}
									</p>
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-end gap-3 border-t border-border/30 p-6">
					{(isCompleted || isFailed) && (
						<Button
							variant="outline"
							onClick={onClose}
							className="gap-2"
						>
							Close
						</Button>
					)}
					{!isCompleted && !isFailed && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" style={{ color: themeGradient.from }} />
							Sync in progress...
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
