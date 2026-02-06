"use client";

/**
 * Sync Validation Modal
 *
 * Premium modal for validating sync operations with:
 * - Glassmorphic backdrop and container
 * - Theme-aware styling using THEME_GRADIENTS
 * - SEMANTIC_COLORS for success/error/warning states
 * - Animated entrance and focus trap
 */

import {
	AlertCircle,
	Bug,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Eye,
	HelpCircle,
	Info,
	Loader2,
	Plug,
	RefreshCw,
	Upload,
	X,
	XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui";
import { useValidateSync, MAX_RETRY_ATTEMPTS } from "../../../hooks/api/useSync";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
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
	const { gradient: themeGradient } = useThemeGradient();
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
			retryTimeoutRef.current = setTimeout(() => {
				if (!isMountedRef.current) return;
				setRetryProgress((prev) =>
					prev && prev.attempt === attempt ? { ...prev, isWaiting: false } : prev,
				);
			}, delayMs);
		},
	});

	// Maximum manual retry attempts
	const MAX_MANUAL_RETRIES = 3;

	// Focus trap and keyboard handling
	useEffect(() => {
		previousActiveElement.current = document.activeElement;
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
					if (document.activeElement === firstElement && lastElement) {
						e.preventDefault();
						lastElement.focus();
					}
				} else {
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
			if (previousActiveElement.current instanceof HTMLElement) {
				previousActiveElement.current.focus();
			}
		};
	}, [onCancel]);

	// Validation function
	const runValidation = () => {
		setLocalError(null);
		const startTime = Date.now();
		setTiming({ startTime, endTime: null, duration: null });

		validateMutation.mutate(
			{ templateId, instanceId },
			{
				onSuccess: (data) => {
					setValidation(data);
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

	// Auto-validate on mount
	useEffect(() => {
		runValidation();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [templateId, instanceId]);

	// Handle retry with exponential backoff
	const handleRetry = () => {
		if (retryCount < MAX_MANUAL_RETRIES) {
			setRetryCount((prev) => prev + 1);
			setValidation(null);
			const delay = Math.pow(2, retryCount) * 1000;
			handleRetryTimeoutRef.current = setTimeout(runValidation, delay);
		} else {
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
	const _hasWarnings = Array.isArray(validation?.warnings) && validation.warnings.length > 0;
	const hasConflicts = Array.isArray(validation?.conflicts) && validation.conflicts.length > 0;
	const canProceed = validation && validation.valid && !hasErrors;

	const hasSilentFailure = validation && !validation.valid && !hasErrors;

	const errorTypes = hasErrors ? detectErrorTypes(validation.errors) : new Set<ErrorType>();

	const informationalWarnings = (validation?.warnings || []).filter(
		(w) => w.includes("is reachable") || w.includes("Validation passed"),
	);
	const actualWarnings = (validation?.warnings || []).filter(
		(w) => !w.includes("is reachable") && !w.includes("Validation passed"),
	);
	const hasActualWarnings = actualWarnings.length > 0;

	const _isAutoRetrying = retryProgress !== null && retryProgress.isWaiting;

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={(e) => e.target === e.currentTarget && onCancel()}
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

			{/* Modal */}
			<div
				ref={dialogRef}
				tabIndex={-1}
				className="relative w-full max-w-2xl max-h-[90vh] overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl focus:outline-hidden animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${themeGradient.from}15`,
				}}
				role="dialog"
				aria-modal="true"
				aria-labelledby="sync-validation-title"
			>
				{/* Close Button */}
				<button
					type="button"
					onClick={onCancel}
					aria-label="Close validation modal"
					className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white"
				>
					<X className="h-4 w-4" />
				</button>

				{/* Header */}
				<div
					className="border-b border-border/30 p-6"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}08, transparent)`,
					}}
				>
					<div className="flex items-center gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<RefreshCw className="h-6 w-6" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h2
								id="sync-validation-title"
								className="text-xl font-bold text-foreground"
							>
								Validate Sync
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								Template: <span className="font-medium text-foreground">{templateName}</span> → Instance:{" "}
								<span className="font-medium text-foreground">{instanceName}</span>
							</p>
						</div>
					</div>
				</div>

				{/* Content */}
				<div className="max-h-[60vh] overflow-y-auto p-6">
					{/* Validating state */}
					{isValidating && (
						<div className="flex flex-col items-center justify-center py-12">
							<div className="flex items-center">
								<Loader2 className="h-8 w-8 animate-spin" style={{ color: themeGradient.from }} />
								<span className="ml-3 text-muted-foreground">
									{retryProgress
										? `Retrying... (attempt ${retryProgress.attempt + 1}/${retryProgress.maxAttempts + 1})`
										: "Validating..."}
								</span>
							</div>
							{retryProgress && retryProgress.isWaiting && (
								<div className="mt-4 text-center">
									<p className="text-sm text-muted-foreground/70">
										Waiting {retryProgress.delayMs / 1000}s before retry due to network error...
									</p>
									<Button
										variant="outline"
										size="sm"
										className="mt-2 rounded-xl"
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
							{/* Silent Failure Fallback */}
							{hasSilentFailure && (
								<div
									className="rounded-xl p-4"
									style={{
										backgroundColor: SEMANTIC_COLORS.warning.bg,
										border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
									}}
								>
									<div className="flex items-start gap-3">
										<HelpCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.warning.from }} />
										<div className="flex-1">
											<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.warning.text }}>
												Validation Failed
											</h3>
											<p className="mt-1 text-sm" style={{ color: SEMANTIC_COLORS.warning.text }}>
												Validation could not be completed, but no specific errors were reported.
												This may be a temporary issue.
											</p>
											<div className="mt-3 flex items-center gap-3">
												<Button
													variant="outline"
													size="sm"
													onClick={handleRetry}
													disabled={isValidating}
													className="gap-2 rounded-xl"
												>
													<RefreshCw className={`h-3 w-3 ${isValidating ? "animate-spin" : ""}`} />
													{retryCount > 0
														? `Retry (${retryCount}/${MAX_MANUAL_RETRIES})`
														: "Retry Validation"}
												</Button>
												<span className="text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>
													Try again or check your instance connectivity
												</span>
											</div>
										</div>
									</div>
								</div>
							)}

							{/* Validation Errors */}
							{hasErrors && (
								<div
									className="rounded-xl p-4"
									style={{
										backgroundColor: SEMANTIC_COLORS.error.bg,
										border: `1px solid ${SEMANTIC_COLORS.error.border}`,
									}}
								>
									<div className="flex items-start gap-3">
										<XCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
										<div className="flex-1">
											<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
												Validation Failed
											</h3>
											<ul className="mt-2 space-y-1 text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
												{validation.errors.map((error, index) => (
													<li key={index}>• {error}</li>
												))}
											</ul>

											{/* Contextual action buttons */}
											<div className="mt-4 flex flex-wrap gap-2">
												{errorTypes.has("MISSING_MAPPING") && onNavigateToDeploy && (
													<Button
														size="sm"
														onClick={() => {
															onCancel();
															onNavigateToDeploy();
														}}
														className="gap-2 rounded-xl font-medium"
														style={{
															background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
														}}
													>
														<Upload className="h-3 w-3" />
														Deploy Template
													</Button>
												)}

												{errorTypes.has("UNREACHABLE_INSTANCE") && onTestConnection && (
													<Button
														variant="outline"
														size="sm"
														onClick={onTestConnection}
														className="gap-2 rounded-xl"
													>
														<Plug className="h-3 w-3" />
														Test Connection
													</Button>
												)}

												{errorTypes.has("USER_MODIFICATIONS") && (
													<>
														{onSwitchToManualSync && (
															<Button
																size="sm"
																onClick={() => {
																	onCancel();
																	onSwitchToManualSync();
																}}
																className="gap-2 rounded-xl font-medium"
																style={{
																	background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
																}}
															>
																<RefreshCw className="h-3 w-3" />
																Switch to Manual Sync
															</Button>
														)}
														{onViewChanges && (
															<Button
																variant="outline"
																size="sm"
																onClick={onViewChanges}
																className="gap-2 rounded-xl"
															>
																<Eye className="h-3 w-3" />
																View Changes
															</Button>
														)}
													</>
												)}

												<Button
													variant="outline"
													size="sm"
													onClick={handleRetry}
													disabled={isValidating}
													className="gap-2 rounded-xl"
												>
													<RefreshCw className={`h-3 w-3 ${isValidating ? "animate-spin" : ""}`} />
													{retryCount > 0
														? `Retry (${retryCount}/${MAX_MANUAL_RETRIES})`
														: "Retry Validation"}
												</Button>
											</div>

											{/* Helpful hints */}
											{errorTypes.has("MISSING_MAPPING") && (
												<p className="mt-3 text-xs opacity-80" style={{ color: SEMANTIC_COLORS.error.text }}>
													This template needs to be deployed to the instance before syncing.
												</p>
											)}
											{errorTypes.has("USER_MODIFICATIONS") && (
												<p className="mt-3 text-xs opacity-80" style={{ color: SEMANTIC_COLORS.error.text }}>
													Auto-sync is disabled for templates with local modifications to protect your changes.
												</p>
											)}
											{errorTypes.has("UNREACHABLE_INSTANCE") && (
												<p className="mt-3 text-xs opacity-80" style={{ color: SEMANTIC_COLORS.error.text }}>
													Check that the instance is running and the URL/API key are correct.
												</p>
											)}
										</div>
									</div>
								</div>
							)}

							{/* Actual Warnings */}
							{hasActualWarnings && (
								<div
									className="rounded-xl p-4"
									style={{
										backgroundColor: SEMANTIC_COLORS.warning.bg,
										border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
									}}
								>
									<div className="flex items-start gap-3">
										<AlertCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.warning.from }} />
										<div className="flex-1">
											<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.warning.text }}>
												Warnings
											</h3>
											<ul className="mt-2 space-y-1 text-sm" style={{ color: SEMANTIC_COLORS.warning.text }}>
												{actualWarnings.map((warning, index) => (
													<li key={index}>• {warning}</li>
												))}
											</ul>
										</div>
									</div>
								</div>
							)}

							{/* Informational messages */}
							{informationalWarnings.length > 0 && canProceed && (
								<div
									className="rounded-xl p-4"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}08, ${themeGradient.to}08)`,
										border: `1px solid ${themeGradient.from}20`,
									}}
								>
									<div className="flex items-start gap-3">
										<Info className="h-5 w-5 shrink-0" style={{ color: themeGradient.from }} />
										<div className="flex-1">
											<ul className="space-y-1 text-sm text-muted-foreground">
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
								<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
									<div className="flex items-start gap-3">
										<Info className="h-5 w-5 shrink-0" style={{ color: themeGradient.from }} />
										<div className="flex-1">
											<h3 className="font-medium text-foreground">
												{validation.conflicts.length} Conflict
												{validation.conflicts.length !== 1 ? "s" : ""} Detected
											</h3>
											<p className="mt-1 text-sm text-muted-foreground">
												Choose how to handle existing Custom Formats with the same name
											</p>

											<div className="mt-4 space-y-3">
												{validation.conflicts.map((conflict) => (
													<div
														key={conflict.configName}
														className="rounded-xl border border-border/50 bg-card/30 p-3"
													>
														<div className="flex items-center justify-between">
															<div className="flex-1">
																<p className="font-medium text-foreground">{conflict.configName}</p>
																<p className="mt-0.5 text-xs text-muted-foreground">{conflict.reason}</p>
															</div>

															<div className="flex gap-2">
																<Button
																	size="sm"
																	variant={resolutions[conflict.configName] === "REPLACE" ? "default" : "outline"}
																	onClick={() => handleResolutionChange(conflict.configName, "REPLACE")}
																	className="rounded-xl"
																	style={
																		resolutions[conflict.configName] === "REPLACE"
																			? {
																					background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
																				}
																			: undefined
																	}
																>
																	Replace
																</Button>
																<Button
																	size="sm"
																	variant={resolutions[conflict.configName] === "SKIP" ? "default" : "outline"}
																	onClick={() => handleResolutionChange(conflict.configName, "SKIP")}
																	className="rounded-xl"
																	style={
																		resolutions[conflict.configName] === "SKIP"
																			? {
																					background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
																				}
																			: undefined
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
								<div
									className="rounded-xl p-4"
									style={{
										backgroundColor: SEMANTIC_COLORS.success.bg,
										border: `1px solid ${SEMANTIC_COLORS.success.border}`,
									}}
								>
									<div className="flex items-center gap-3">
										<CheckCircle2 className="h-5 w-5" style={{ color: SEMANTIC_COLORS.success.from }} />
										<div>
											<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.success.text }}>
												Validation Passed
											</h3>
											<p className="mt-0.5 text-sm" style={{ color: SEMANTIC_COLORS.success.text }}>
												Ready to sync
											</p>
										</div>
									</div>
								</div>
							)}
						</div>
					)}

					{/* Mutation Error or Local Error */}
					{(validateMutation.error || localError) && (
						<div
							className="rounded-xl p-4"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<div className="flex items-start gap-3">
								<XCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
								<div className="flex-1">
									<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
										Validation Error
									</h3>
									<p className="mt-1 text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
										{(localError ?? validateMutation.error)?.message ??
											"An unknown error occurred while validating the sync request."}
									</p>
									<div className="mt-3 flex items-center gap-3">
										<Button
											variant="outline"
											size="sm"
											onClick={handleRetry}
											disabled={isValidating}
											className="gap-2 rounded-xl"
										>
											<RefreshCw className={`h-3 w-3 ${isValidating ? "animate-spin" : ""}`} />
											{retryCount > 0 ? `Retry (${retryCount}/${MAX_MANUAL_RETRIES})` : "Retry Validation"}
										</Button>
										{retryCount >= MAX_MANUAL_RETRIES && (
											<span className="text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>
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
						<div className="mt-4 rounded-xl border border-purple-500/30 bg-purple-500/10">
							<button
								type="button"
								onClick={() => setShowDebugPanel(!showDebugPanel)}
								className="flex w-full items-center justify-between p-3 text-left text-sm font-medium text-purple-300 hover:bg-purple-500/10 rounded-xl"
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
													<div
														className="mt-2 rounded-lg p-2"
														style={{
															backgroundColor: SEMANTIC_COLORS.warning.bg,
															color: SEMANTIC_COLORS.warning.text,
														}}
													>
														Silent Failure Detected: valid=false with 0 errors
													</div>
												)}
											</>
										)}
										{(localError || validateMutation.error) && (
											<div className="mt-2 border-t border-purple-500/20 pt-2">
												<span className="text-purple-400">Error Details:</span>
												<pre className="mt-1 overflow-auto rounded-lg bg-black/30 p-2 text-red-300">
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
				<div className="flex items-center justify-end gap-3 border-t border-border/30 p-6">
					<Button variant="outline" onClick={onCancel} className="rounded-xl">
						Cancel
					</Button>
					<Button
						onClick={handleConfirm}
						disabled={!canProceed || isValidating}
						className="gap-2 rounded-xl font-medium"
						style={
							canProceed && !isValidating
								? {
										background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
										boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
									}
								: undefined
						}
					>
						{hasConflicts ? "Proceed with Resolutions" : "Start Sync"}
					</Button>
				</div>
			</div>
		</div>
	);
};
