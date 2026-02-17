"use client";

/**
 * Sync Validation Modal
 *
 * Premium modal for validating sync operations with:
 * - Glassmorphic backdrop and container
 * - Theme-aware styling using THEME_GRADIENTS
 * - Animated entrance and focus trap
 *
 * Validation result panels are in sync-validation-panels.tsx.
 * Dev-only debug panel is in sync-debug-panel.tsx.
 */

import { Info, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui";
import { useValidateSync } from "../../../hooks/api/useSync";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { ValidationResult } from "../../../lib/api-client/trash-guides";
import { detectErrorTypes, type ErrorType, type ValidationTiming, type RetryProgress } from "../lib/sync-validation-utils";
import { SyncDebugPanel } from "./sync-debug-panel";
import {
	MutationErrorPanel,
	SilentFailurePanel,
	ValidationErrorPanel,
	ValidationSuccessPanel,
	ValidationWarningsPanel,
} from "./sync-validation-panels";

// Check if we're in development mode
const isDevelopment = process.env.NODE_ENV === "development";

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

	const displayError = localError ?? validateMutation.error ?? null;

	// Shared retry props for extracted panels
	const retryProps = {
		handleRetry,
		isValidating,
		retryCount,
		maxManualRetries: MAX_MANUAL_RETRIES,
	};

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
							{hasSilentFailure && <SilentFailurePanel {...retryProps} />}

							{hasErrors && (
								<ValidationErrorPanel
									errors={validation.errors}
									errorTypes={errorTypes}
									themeGradient={themeGradient}
									onCancel={onCancel}
									onNavigateToDeploy={onNavigateToDeploy}
									onTestConnection={onTestConnection}
									onViewChanges={onViewChanges}
									onSwitchToManualSync={onSwitchToManualSync}
									{...retryProps}
								/>
							)}

							{hasActualWarnings && <ValidationWarningsPanel warnings={actualWarnings} />}

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

							{canProceed && !hasConflicts && <ValidationSuccessPanel />}
						</div>
					)}

					{/* Mutation Error */}
					{displayError && <MutationErrorPanel error={displayError} {...retryProps} />}

					{/* Development Debug Panel */}
					{isDevelopment && (
						<SyncDebugPanel
							templateId={templateId}
							instanceId={instanceId}
							mutationStatus={
								validateMutation.isPending
									? "pending"
									: validateMutation.isError
										? "error"
										: validateMutation.isSuccess
											? "success"
											: "idle"
							}
							retryCount={retryCount}
							maxManualRetries={MAX_MANUAL_RETRIES}
							retryProgress={retryProgress}
							timing={timing}
							validation={validation}
							hasSilentFailure={!!hasSilentFailure}
							error={displayError}
						/>
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
