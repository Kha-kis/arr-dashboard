"use client";

import { useState, useEffect, useRef } from "react";
import { AlertCircle, CheckCircle2, XCircle, Info } from "lucide-react";
import { useValidateSync } from "../../../hooks/api/useSync";
import type { ConflictInfo, ValidationResult } from "../../../lib/api-client/sync";
import { Button } from "../../../components/ui";

interface SyncValidationModalProps {
	templateId: string;
	templateName: string;
	instanceId: string;
	instanceName: string;
	onConfirm: (resolutions: Record<string, "REPLACE" | "SKIP">) => void;
	onCancel: () => void;
}

export const SyncValidationModal = ({
	templateId,
	templateName,
	instanceId,
	instanceName,
	onConfirm,
	onCancel,
}: SyncValidationModalProps) => {
	const validateMutation = useValidateSync();
	const [resolutions, setResolutions] = useState<Record<string, "REPLACE" | "SKIP">>({});
	const [validation, setValidation] = useState<ValidationResult | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const previousActiveElement = useRef<Element | null>(null);

	// Focus trap and keyboard handling
	useEffect(() => {
		// Save the element that had focus before opening
		previousActiveElement.current = document.activeElement;

		// Focus the dialog on mount
		dialogRef.current?.focus();

		const getFocusableElements = (): HTMLElement[] => {
			if (!dialogRef.current) return [];
			const focusableSelectors = [
				'button:not([disabled])',
				'[href]',
				'input:not([disabled])',
				'select:not([disabled])',
				'textarea:not([disabled])',
				'[tabindex]:not([tabindex="-1"])',
			].join(', ');
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

	// Auto-validate on mount
	useEffect(() => {
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
		// eslint-disable-next-line react-hooks/exhaustive-deps -- Only run on mount with templateId/instanceId
	}, [templateId, instanceId]);

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

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onClick={(e) => e.target === e.currentTarget && onCancel()}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				className="w-full max-w-2xl rounded-xl border border-white/10 bg-[#0d1117] shadow-2xl focus:outline-none"
				role="dialog"
				aria-modal="true"
				aria-labelledby="sync-validation-title"
			>
				{/* Header */}
				<div className="border-b border-white/10 p-6">
					<h2 id="sync-validation-title" className="text-xl font-semibold text-white">Validate Sync</h2>
					<p className="mt-1 text-sm text-white/60">
						Template: <span className="font-medium text-white">{templateName}</span> →
						Instance: <span className="font-medium text-white">{instanceName}</span>
					</p>
				</div>

				{/* Content */}
				<div className="max-h-[60vh] overflow-y-auto p-6">
					{isValidating && (
						<div className="flex items-center justify-center py-12">
							<div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
							<span className="ml-3 text-white/60">Validating...</span>
						</div>
					)}

					{!isValidating && validation && (
						<div className="space-y-4">
							{/* Validation Errors */}
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
										</div>
									</div>
								</div>
							)}

							{/* Warnings */}
							{hasWarnings && (
								<div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-4">
									<div className="flex items-start gap-3">
										<AlertCircle className="h-5 w-5 flex-shrink-0 text-yellow-400" />
										<div className="flex-1">
											<h3 className="font-medium text-yellow-200">Warnings</h3>
											<ul className="mt-2 space-y-1 text-sm text-yellow-300">
												{validation.warnings.map((warning, index) => (
													<li key={index}>• {warning}</li>
												))}
											</ul>
										</div>
									</div>
								</div>
							)}

							{/* Conflicts */}
							{hasConflicts && validation.conflicts && (
								<div className="rounded-lg border border-white/10 bg-white/5 p-4">
									<div className="flex items-start gap-3">
										<Info className="h-5 w-5 flex-shrink-0 text-blue-400" />
										<div className="flex-1">
											<h3 className="font-medium text-white">
												{validation.conflicts.length} Conflict{validation.conflicts.length !== 1 ? "s" : ""} Detected
											</h3>
											<p className="mt-1 text-sm text-white/60">
												Choose how to handle existing Custom Formats with the same name
											</p>

											<div className="mt-4 space-y-3">
												{validation.conflicts.map((conflict) => (
													<div
														key={conflict.configName}
														className="rounded-lg border border-white/10 bg-white/5 p-3"
													>
														<div className="flex items-center justify-between">
															<div className="flex-1">
																<p className="font-medium text-white">{conflict.configName}</p>
																<p className="mt-0.5 text-xs text-white/50">{conflict.reason}</p>
															</div>

															<div className="flex gap-2">
																<Button
																	variant={resolutions[conflict.configName] === "REPLACE" ? "primary" : "secondary"}
																	size="sm"
																	onClick={() => handleResolutionChange(conflict.configName, "REPLACE")}
																>
																	Replace
																</Button>
																<Button
																	variant={resolutions[conflict.configName] === "SKIP" ? "primary" : "secondary"}
																	size="sm"
																	onClick={() => handleResolutionChange(conflict.configName, "SKIP")}
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

					{validateMutation.error && (
						<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
							<div className="flex items-start gap-3">
								<XCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
								<div>
									<h3 className="font-medium text-red-200">Validation Error</h3>
									<p className="mt-1 text-sm text-red-300">
										{validateMutation.error instanceof Error
											? validateMutation.error.message
											: "An unknown error occurred"}
									</p>
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-end gap-3 border-t border-white/10 p-6">
					<Button variant="secondary" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						variant="primary"
						onClick={handleConfirm}
						disabled={!canProceed || isValidating}
					>
						{hasConflicts ? "Proceed with Resolutions" : "Start Sync"}
					</Button>
				</div>
			</div>
		</div>
	);
};
