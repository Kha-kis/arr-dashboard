"use client";

import {
	AlertCircle,
	Bug,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	ExternalLink,
	Eye,
	HelpCircle,
	Info,
	Plug,
	RefreshCw,
	Upload,
	XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui";
import { useValidateSync, MAX_RETRY_ATTEMPTS } from "../../../hooks/api/useSync";
import type { ValidationResult } from "../../../lib/api-client/sync";

// Check if we're in development mode
const isDevelopment = process.env.NODE_ENV === "development";

// Error type detection patterns
const ERROR_PATTERNS = {
	MISSING_MAPPING: /no quality profile mappings found|deploy this template/i,
	UNREACHABLE_INSTANCE: /unable to connect|unreachable|connection refused|timeout/i,
	USER_MODIFICATIONS: /auto-sync is blocked|local modifications|user modifications/i,
	DELETED_PROFILES: /quality profiles no longer exist|mapped.*deleted/i,
	CORRUPTED_TEMPLATE: /corrupted|cannot be parsed|missing custom formats/i,
	CACHE_ISSUE: /cache is empty|cache.*corrupted|cache needs refreshing/i,
} as const;

type ErrorType = keyof typeof ERROR_PATTERNS;

/** Detect error types from error messages */
function detectErrorTypes(errors: string[]): Set<ErrorType> {
	const detected = new Set<ErrorType>();
	for (const error of errors) {
		for (const [type, pattern] of Object.entries(ERROR_PATTERNS)) {
			if (pattern.test(error)) {
				detected.add(type as ErrorType);
			}
		}
	}
	return detected;
}

interface SyncValidationModalProps {
	templateId: string;
	templateName: string;
	instanceId: string;
	instanceName: string;
	onConfirm: (resolutions: Record<string, "REPLACE" | "SKIP">) => void;
	onCancel: () => void;
	/** Optional callback to navigate to deployment workflow */
	onNavigateToDeploy?: () => void;
	/** Optional callback to test instance connection */
	onTestConnection?: () => void;
	/** Optional callback to view template changes (for manual sync) */
	onViewChanges?: () => void;
	/** Optional callback to switch to manual sync mode */
	onSwitchToManualSync?: () => void;
}

interface ValidationTiming {
	startTime: number;
	endTime: number | null;
	duration: number | null;
}

interface RetryProgress {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	isWaiting: boolean;
}

export const SyncValidationModal = ({
	templateId,
	templateName,
	instanceId,
	instanceName,
	onConfirm,
	onCancel,
	onNavigateToDeploy,
	onTestConnection,
	onViewChanges,
	onSwitchToManualSync,
}: SyncValidationModalProps) => {
	const [resolutions, setResolutions] = useState<Record<string, "REPLACE" | "SKIP">>({});
	const [validation, setValidation] = useState<ValidationResult | null>(null);
	const [retryCount, setRetryCount] = useState(0);
	const [localError, setLocalError] = useState<Error | null>(null);
	const [showDebugPanel, setShowDebugPanel] = useState(false);
	const [timing, setTiming] = useState<ValidationTiming>({
		startTime: 0,
		endTime: null,
		duration: null,
	});
	const [retryProgress, setRetryProgress] = useState<RetryProgress | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const previousActiveElement = useRef<Element | null>(null);
	// Track mounted state to prevent state updates after unmount
	const isMountedRef = useRef(true);
	// Track timeout IDs for cleanup on unmount
	const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const handleRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cleanup mounted ref and pending timeouts on unmount
	useEffect(() => {
		return () => {
			isMountedRef.current = false;
			if (retryTimeoutRef.current) {
				clearTimeout(retryTimeoutRef.current);
			}
			if (handleRetryTimeoutRef.current) {
				clearTimeout(handleRetryTimeoutRef.current);
			}
		};
	}, []);

	// Use the validation hook with error and retry callbacks
	const validateMutation = useValidateSync({
		onError: (error) => {
			setLocalError(error);
			setRetryProgress(null);
			const endTime = Date.now();
			setTiming((prev) => {
				const duration = prev.startTime > 0 ? endTime - prev.startTime : null;
				// Log timing using prev.startTime to avoid stale closure
				console.error("[SyncValidationModal] Validation error:", {
					error: error.message,
					templateId,
					instanceId,
					retryCount,
					timing: {
						startTime: prev.startTime > 0 ? new Date(prev.startTime).toISOString() : null,
						endTime: new Date(endTime).toISOString(),
						durationMs: duration,
					},
				});
				return { ...prev, endTime, duration };
			});
		},
		onSuccess: (data) => {
			setRetryProgress(null);
			const endTime = Date.now();
			setTiming((prev) => {
				const duration = endTime - prev.startTime;
				// Log full validation object for debugging silent failures
				// Use prev.startTime to avoid stale closure
				if (!data.valid && (!data.errors || data.errors.length === 0)) {
					console.warn("[SyncValidationModal] Silent failure - full validation response:", {
						validation: data,
						templateId,
						instanceId,
						timing: {
							startTime: prev.startTime > 0 ? new Date(prev.startTime).toISOString() : null,
							endTime: new Date(endTime).toISOString(),
							durationMs: duration,
						},
					});
				}
				return { ...prev, endTime, duration };
			});
		},
		onRetryProgress: (attempt, maxAttempts, delayMs) => {
			setRetryProgress({ attempt, maxAttempts, delayMs, isWaiting: true });
			// Clear waiting state after delay (only if still mounted)
			// Store timeout ID in ref for cleanup on unmount
			retryTimeoutRef.current = setTimeout(() => {
				if (!isMountedRef.current) return;
				setRetryProgress((prev) =>
					prev && prev.attempt === attempt ? { ...prev, isWaiting: false } : prev,
				);
			}, delayMs);
		},
	});

	// Maximum manual retry attempts (user clicking "Retry" button, separate from automatic retries in useValidateSync)
	const MAX_MANUAL_RETRIES = 3;

	// Focus trap and keyboard handling
	useEffect(() => {
		// Save the element that had focus before opening
		previousActiveElement.current = document.activeElement;

		// Focus the dialog on mount
		dialogRef.current?.focus();

		const getFocusableElements = (): HTMLElement[] => {
			if (!dialogRef.current) return [];
			const focusableSelectors = [
				"button:not([disabled])",
				"[href]",
				"input:not([disabled])",
				"select:not([disabled])",
				"textarea:not([disabled])",
				'[tabindex]:not([tabindex="-1"])',
			].join(", ");
			return Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelectors));
		};

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onCancel();
				return;
			}

			if (e.key === "Tab") {
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
			// Restore focus to the element that opened the modal
			if (previousActiveElement.current instanceof HTMLElement) {
				previousActiveElement.current.focus();
			}
		};
	}, [onCancel]);

	// Validation function that can be called for initial load and retries
	const runValidation = () => {
		// Reset local error state and start timing
		setLocalError(null);
		const startTime = Date.now();
		setTiming({ startTime, endTime: null, duration: null });

		validateMutation.mutate(
			{ templateId, instanceId },
			{
				onSuccess: (data) => {
					setValidation(data);
					// Set default resolutions to REPLACE only if conflicts is a valid array
					if (data && Array.isArray(data.conflicts) && data.conflicts.length > 0) {
						const defaultResolutions: Record<string, "REPLACE" | "SKIP"> = {};
						data.conflicts.forEach((conflict) => {
							defaultResolutions[conflict.configName] = "REPLACE";
						});
						setResolutions(defaultResolutions);
					} else {
						setResolutions({});
					}
				},
			},
		);
	};

	// Auto-validate on mount and when template/instance IDs change
	useEffect(() => {
		runValidation();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runValidation is stable, only re-run when IDs change
	}, [templateId, instanceId]);

	// Handle retry with exponential backoff
	const handleRetry = () => {
		if (retryCount < MAX_MANUAL_RETRIES) {
			setRetryCount((prev) => prev + 1);
			setValidation(null);
			// Exponential backoff: 1s, 2s
			const delay = Math.pow(2, retryCount) * 1000;
			// Store timeout ID in ref for cleanup on unmount
			handleRetryTimeoutRef.current = setTimeout(runValidation, delay);
		} else {
			// Max retries exceeded, just run immediately
			setValidation(null);
			setRetryCount(0);
			runValidation();
		}
	};

	const handleResolutionChange = (configName: string, action: "REPLACE" | "SKIP") => {
		setResolutions((prev) => ({
			...prev,
			[configName]: action,
		}));
	};

	const handleConfirm = () => {
		onConfirm(resolutions);
	};

	const isValidating = validateMutation.isPending;
	const hasErrors = Array.isArray(validation?.errors) && validation.errors.length > 0;
	const hasWarnings = Array.isArray(validation?.warnings) && validation.warnings.length > 0;
	const hasConflicts = Array.isArray(validation?.conflicts) && validation.conflicts.length > 0;
	const canProceed = validation && validation.valid && !hasErrors;

	// Detect silent failure: validation returned invalid=false but no errors
	const hasSilentFailure = validation && !validation.valid && !hasErrors;

	// Detect error types for contextual actions
	const errorTypes = hasErrors ? detectErrorTypes(validation.errors) : new Set<ErrorType>();

	// Separate informational warnings (like "Instance is reachable") from actual warnings
	const informationalWarnings = (validation?.warnings || []).filter(
		(w) => w.includes("is reachable") || w.includes("Validation passed"),
	);
	const actualWarnings = (validation?.warnings || []).filter(
		(w) => !w.includes("is reachable") && !w.includes("Validation passed"),
	);
	const hasActualWarnings = actualWarnings.length > 0;

	// Check if we're showing automatic retry progress
	const isAutoRetrying = retryProgress !== null && retryProgress.isWaiting;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onClick={(e) => e.target === e.currentTarget && onCancel()}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				className="w-full max-w-2xl rounded-xl border border-border bg-bg shadow-2xl focus:outline-none"
				role="dialog"
				aria-modal="true"
				aria-labelledby="sync-validation-title"
			>
				{/* Header */}
				<div className="border-b border-border p-6">
					<h2 id="sync-validation-title" className="text-xl font-semibold text-fg">
						Validate Sync
					</h2>
					<p className="mt-1 text-sm text-fg/60">
						Template: <span className="font-medium text-fg">{templateName}</span> → Instance:{" "}
						<span className="font-medium text-fg">{instanceName}</span>
					</p>
				</div>

				{/* Content */}
				<div className="max-h-[60vh] overflow-y-auto p-6">
					{/* Validating state with optional retry progress */}
					{isValidating && (
						<div className="flex flex-col items-center justify-center py-12">
							<div className="flex items-center">
								<div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
								<span className="ml-3 text-fg/60">
									{retryProgress
										? `Retrying... (attempt ${retryProgress.attempt + 1}/${retryProgress.maxAttempts + 1})`
										: "Validating..."}
								</span>
							</div>
							{retryProgress && retryProgress.isWaiting && (
								<div className="mt-4 text-center">
									<p className="text-sm text-fg/50">
										Waiting {retryProgress.delayMs / 1000}s before retry due to network error...
									</p>
									<Button
										variant="secondary"
										size="sm"
										className="mt-2"
										onClick={onCancel}
									>
										Cancel
									</Button>
								</div>
							)}
						</div>
					)}

					{!isValidating && validation && (
						<div className="space-y-4">
							{/* Silent Failure Fallback - validation failed but no errors reported */}
							{hasSilentFailure && (
								<div className="rounded-lg border border-orange-500/20 bg-orange-500/10 p-4">
									<div className="flex items-start gap-3">
										<HelpCircle className="h-5 w-5 flex-shrink-0 text-orange-400" />
										<div className="flex-1">
											<h3 className="font-medium text-orange-200">Validation Failed</h3>
											<p className="mt-1 text-sm text-orange-300">
												Validation could not be completed, but no specific errors were reported.
												This may be a temporary issue.
											</p>
											<div className="mt-3 flex items-center gap-3">
												<Button
													variant="secondary"
													size="sm"
													onClick={handleRetry}
													disabled={isValidating}
												>
													<RefreshCw
														className={`mr-2 h-3 w-3 ${isValidating ? "animate-spin" : ""}`}
													/>
													{retryCount > 0
														? `Retry (${retryCount}/${MAX_MANUAL_RETRIES})`
														: "Retry Validation"}
												</Button>
												<span className="text-xs text-orange-300/70">
													Try again or check your instance connectivity
												</span>
											</div>
										</div>
									</div>
								</div>
							)}

							{/* Validation Errors with Contextual Actions */}
							{hasErrors && (
								<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
									<div className="flex items-start gap-3">
										<XCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
										<div className="flex-1">
											<h3 className="font-medium text-red-200">Validation Failed</h3>
											<ul className="mt-2 space-y-1 text-sm text-red-300">
												{validation.errors.map((error, index) => (
													<li key={index}>• {error}</li>
												))}
											</ul>

											{/* Contextual action buttons based on error types */}
											<div className="mt-4 flex flex-wrap gap-2">
												{/* Missing quality profile mappings → Deploy Template */}
												{errorTypes.has("MISSING_MAPPING") && onNavigateToDeploy && (
													<Button
														variant="primary"
														size="sm"
														onClick={() => {
															onCancel();
															onNavigateToDeploy();
														}}
													>
														<Upload className="mr-2 h-3 w-3" />
														Deploy Template
													</Button>
												)}

												{/* Unreachable instance → Test Connection */}
												{errorTypes.has("UNREACHABLE_INSTANCE") && onTestConnection && (
													<Button
														variant="secondary"
														size="sm"
														onClick={onTestConnection}
													>
														<Plug className="mr-2 h-3 w-3" />
														Test Connection
													</Button>
												)}

												{/* User modifications blocking auto-sync → Manual sync options */}
												{errorTypes.has("USER_MODIFICATIONS") && (
													<>
														{onSwitchToManualSync && (
															<Button
																variant="primary"
																size="sm"
																onClick={() => {
																	onCancel();
																	onSwitchToManualSync();
																}}
															>
																<RefreshCw className="mr-2 h-3 w-3" />
																Switch to Manual Sync
															</Button>
														)}
														{onViewChanges && (
															<Button
																variant="secondary"
																size="sm"
																onClick={onViewChanges}
															>
																<Eye className="mr-2 h-3 w-3" />
																View Changes
															</Button>
														)}
													</>
												)}

												{/* Generic retry button */}
												<Button
													variant="secondary"
													size="sm"
													onClick={handleRetry}
													disabled={isValidating}
												>
													<RefreshCw
														className={`mr-2 h-3 w-3 ${isValidating ? "animate-spin" : ""}`}
													/>
													{retryCount > 0
														? `Retry (${retryCount}/${MAX_MANUAL_RETRIES})`
														: "Retry Validation"}
												</Button>
											</div>

											{/* Helpful hints based on error types */}
											{errorTypes.has("MISSING_MAPPING") && (
												<p className="mt-3 text-xs text-red-300/70">
													This template needs to be deployed to the instance before syncing.
												</p>
											)}
											{errorTypes.has("USER_MODIFICATIONS") && (
												<p className="mt-3 text-xs text-red-300/70">
													Auto-sync is disabled for templates with local modifications to protect your changes.
												</p>
											)}
											{errorTypes.has("UNREACHABLE_INSTANCE") && (
												<p className="mt-3 text-xs text-red-300/70">
													Check that the instance is running and the URL/API key are correct.
												</p>
											)}
										</div>
									</div>
								</div>
							)}

							{/* Actual Warnings (not informational) */}
							{hasActualWarnings && (
								<div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-4">
									<div className="flex items-start gap-3">
										<AlertCircle className="h-5 w-5 flex-shrink-0 text-yellow-400" />
										<div className="flex-1">
											<h3 className="font-medium text-yellow-200">Warnings</h3>
											<ul className="mt-2 space-y-1 text-sm text-yellow-300">
												{actualWarnings.map((warning, index) => (
													<li key={index}>• {warning}</li>
												))}
											</ul>
										</div>
									</div>
								</div>
							)}

							{/* Informational messages (like connectivity status) */}
							{informationalWarnings.length > 0 && canProceed && (
								<div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-4">
									<div className="flex items-start gap-3">
										<Info className="h-5 w-5 flex-shrink-0 text-blue-400" />
										<div className="flex-1">
											<ul className="space-y-1 text-sm text-blue-300">
												{informationalWarnings.map((info, index) => (
													<li key={index}>• {info}</li>
												))}
											</ul>
										</div>
									</div>
								</div>
							)}

							{/* Conflicts */}
							{hasConflicts && validation.conflicts && (
								<div className="rounded-lg border border-border bg-bg-subtle p-4">
									<div className="flex items-start gap-3">
										<Info className="h-5 w-5 flex-shrink-0 text-blue-400" />
										<div className="flex-1">
											<h3 className="font-medium text-fg">
												{validation.conflicts.length} Conflict
												{validation.conflicts.length !== 1 ? "s" : ""} Detected
											</h3>
											<p className="mt-1 text-sm text-fg/60">
												Choose how to handle existing Custom Formats with the same name
											</p>

											<div className="mt-4 space-y-3">
												{validation.conflicts.map((conflict) => (
													<div
														key={conflict.configName}
														className="rounded-lg border border-border bg-bg-subtle p-3"
													>
														<div className="flex items-center justify-between">
															<div className="flex-1">
																<p className="font-medium text-fg">{conflict.configName}</p>
																<p className="mt-0.5 text-xs text-fg/50">{conflict.reason}</p>
															</div>

															<div className="flex gap-2">
																<Button
																	variant={
																		resolutions[conflict.configName] === "REPLACE"
																			? "primary"
																			: "secondary"
																	}
																	size="sm"
																	onClick={() =>
																		handleResolutionChange(conflict.configName, "REPLACE")
																	}
																>
																	Replace
																</Button>
																<Button
																	variant={
																		resolutions[conflict.configName] === "SKIP"
																			? "primary"
																			: "secondary"
																	}
																	size="sm"
																	onClick={() =>
																		handleResolutionChange(conflict.configName, "SKIP")
																	}
																>
																	Skip
																</Button>
															</div>
														</div>
													</div>
												))}
											</div>
										</div>
									</div>
								</div>
							)}

							{/* Success */}
							{canProceed && !hasConflicts && (
								<div className="rounded-lg border border-green-500/20 bg-green-500/10 p-4">
									<div className="flex items-center gap-3">
										<CheckCircle2 className="h-5 w-5 text-green-400" />
										<div>
											<h3 className="font-medium text-green-200">Validation Passed</h3>
											<p className="mt-0.5 text-sm text-green-300">Ready to sync</p>
										</div>
									</div>
								</div>
							)}
						</div>
					)}

					{/* Mutation Error or Local Error */}
					{(validateMutation.error || localError) && (
						<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
							<div className="flex items-start gap-3">
								<XCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
								<div className="flex-1">
									<h3 className="font-medium text-red-200">Validation Error</h3>
									<p className="mt-1 text-sm text-red-300">
										{(localError ?? validateMutation.error)?.message ??
											"An unknown error occurred while validating the sync request."}
									</p>
									<div className="mt-3 flex items-center gap-3">
										<Button
											variant="secondary"
											size="sm"
											onClick={handleRetry}
											disabled={isValidating}
										>
											<RefreshCw className={`mr-2 h-3 w-3 ${isValidating ? "animate-spin" : ""}`} />
											{retryCount > 0 ? `Retry (${retryCount}/${MAX_MANUAL_RETRIES})` : "Retry Validation"}
										</Button>
										{retryCount >= MAX_MANUAL_RETRIES && (
											<span className="text-xs text-red-300/70">
												Max retries reached. Check instance connectivity.
											</span>
										)}
									</div>
								</div>
							</div>
						</div>
					)}

					{/* Development Debug Panel */}
					{isDevelopment && (
						<div className="mt-4 rounded-lg border border-purple-500/20 bg-purple-500/5">
							<button
								type="button"
								onClick={() => setShowDebugPanel(!showDebugPanel)}
								className="flex w-full items-center justify-between p-3 text-left text-sm font-medium text-purple-300 hover:bg-purple-500/10"
							>
								<span className="flex items-center gap-2">
									<Bug className="h-4 w-4" />
									Debug Panel (Development Only)
								</span>
								{showDebugPanel ? (
									<ChevronUp className="h-4 w-4" />
								) : (
									<ChevronDown className="h-4 w-4" />
								)}
							</button>
							{showDebugPanel && (
								<div className="border-t border-purple-500/20 p-3">
									<div className="space-y-2 font-mono text-xs">
										<div className="grid grid-cols-2 gap-2">
											<span className="text-purple-400">Template ID:</span>
											<span className="text-purple-200 break-all">{templateId}</span>
										</div>
										<div className="grid grid-cols-2 gap-2">
											<span className="text-purple-400">Instance ID:</span>
											<span className="text-purple-200 break-all">{instanceId}</span>
										</div>
										<div className="grid grid-cols-2 gap-2">
											<span className="text-purple-400">Mutation Status:</span>
											<span className="text-purple-200">
												{validateMutation.isPending
													? "pending"
													: validateMutation.isError
														? "error"
														: validateMutation.isSuccess
															? "success"
															: "idle"}
											</span>
										</div>
										<div className="grid grid-cols-2 gap-2">
											<span className="text-purple-400">Manual Retry Count:</span>
											<span className="text-purple-200">{retryCount} / {MAX_MANUAL_RETRIES}</span>
										</div>
										<div className="grid grid-cols-2 gap-2">
											<span className="text-purple-400">Auto Retry Max:</span>
											<span className="text-purple-200">{MAX_RETRY_ATTEMPTS}</span>
										</div>
										{retryProgress && (
											<div className="grid grid-cols-2 gap-2">
												<span className="text-purple-400">Auto Retry Progress:</span>
												<span className="text-purple-200">
													Attempt {retryProgress.attempt}/{retryProgress.maxAttempts}
													{retryProgress.isWaiting ? ` (waiting ${retryProgress.delayMs}ms)` : ""}
												</span>
											</div>
										)}
										{timing.startTime > 0 && (
											<>
												<div className="grid grid-cols-2 gap-2">
													<span className="text-purple-400">Start Time:</span>
													<span className="text-purple-200">
														{new Date(timing.startTime).toISOString()}
													</span>
												</div>
												{timing.duration !== null && (
													<div className="grid grid-cols-2 gap-2">
														<span className="text-purple-400">Duration:</span>
														<span className="text-purple-200">{timing.duration}ms</span>
													</div>
												)}
											</>
										)}
										{validation && (
											<>
												<div className="mt-2 border-t border-purple-500/20 pt-2">
													<span className="text-purple-400">Validation Response:</span>
												</div>
												<div className="grid grid-cols-2 gap-2">
													<span className="text-purple-400">Valid:</span>
													<span className={validation.valid ? "text-green-400" : "text-red-400"}>
														{String(validation.valid)}
													</span>
												</div>
												<div className="grid grid-cols-2 gap-2">
													<span className="text-purple-400">Errors:</span>
													<span className="text-purple-200">{validation.errors?.length ?? 0}</span>
												</div>
												<div className="grid grid-cols-2 gap-2">
													<span className="text-purple-400">Warnings:</span>
													<span className="text-purple-200">{validation.warnings?.length ?? 0}</span>
												</div>
												<div className="grid grid-cols-2 gap-2">
													<span className="text-purple-400">Conflicts:</span>
													<span className="text-purple-200">{validation.conflicts?.length ?? 0}</span>
												</div>
												{hasSilentFailure && (
													<div className="mt-2 rounded bg-orange-500/20 p-2 text-orange-300">
														Silent Failure Detected: valid=false with 0 errors
													</div>
												)}
											</>
										)}
										{(localError || validateMutation.error) && (
											<div className="mt-2 border-t border-purple-500/20 pt-2">
												<span className="text-purple-400">Error Details:</span>
												<pre className="mt-1 overflow-auto rounded bg-black/30 p-2 text-red-300">
													{(localError || validateMutation.error)?.message}
												</pre>
											</div>
										)}
									</div>
								</div>
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-end gap-3 border-t border-border p-6">
					<Button variant="secondary" onClick={onCancel}>
						Cancel
					</Button>
					<Button variant="primary" onClick={handleConfirm} disabled={!canProceed || isValidating}>
						{hasConflicts ? "Proceed with Resolutions" : "Start Sync"}
					</Button>
				</div>
			</div>
		</div>
	);
};
