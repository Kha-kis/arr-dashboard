/**
 * Enhanced Template Import Modal
 *
 * Premium import templates panel with validation and conflict resolution
 * - Theme-aware styling using THEME_GRADIENTS
 * - Semantic color feedback for validation states
 * - Premium toggle switches and form controls
 */

"use client";

import type {
	TemplateCompatibility,
	TemplateImportOptions,
	TemplateImportValidation,
} from "@arr/shared";
import { onlineManager } from "@tanstack/react-query";
import {
	AlertCircle,
	AlertTriangle,
	CheckCircle,
	FileJson,
	Info,
	Loader2,
	Settings2,
	Upload,
	X,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Input, Textarea } from "../../../components/ui";
import { useEnhancedImportTemplate } from "../../../hooks/api/useTemplates";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

interface EnhancedTemplateImportModalProps {
	onImportComplete?: () => void;
	onClose?: () => void;
}

type ImportSource = "file" | "paste";

type InputValidation =
	| { status: "validating" }
	| {
			status: "validated";
			id: number;
			jsonData: string;
			validation: TemplateImportValidation;
			compatibility: TemplateCompatibility;
	  };

export function EnhancedTemplateImportModal({
	onImportComplete,
	onClose,
}: EnhancedTemplateImportModalProps) {
	const { gradient: themeGradient } = useThemeGradient();

	const controlId = useId();
	const [source, setSource] = useState<ImportSource>("file");
	const [pasteDraft, setPasteDraft] = useState("");
	const [inputValidation, setInputValidation] = useState<InputValidation | null>(null);
	const inputRevision = useRef(0);
	const [options, setOptions] = useState<TemplateImportOptions>({
		onNameConflict: "rename",
		includeQualitySettings: true,
		includeCustomConditions: true,
		includeMetadata: true,
		strictValidation: false,
	});
	const [focusedSelect, setFocusedSelect] = useState(false);

	const importMutation = useEnhancedImportTemplate();

	const isValidating = inputValidation?.status === "validating";
	const validatedInput = inputValidation?.status === "validated" ? inputValidation : null;
	const validation = validatedInput?.validation;
	const compatibility = validatedInput?.compatibility;
	const canImport =
		Boolean(validatedInput?.jsonData) &&
		validation?.valid === true &&
		compatibility?.compatible === true;

	const isImportPending = importMutation.hasPendingImport;

	const invalidateInput = () => {
		setInputValidation(null);
		setOptions((current) => ({ ...current, onNameConflict: "rename" }));
		setFocusedSelect(false);
		return ++inputRevision.current;
	};

	const validateInput = async (
		read: () => string | Promise<string>,
		resetFileInput?: () => void,
	) => {
		const id = invalidateInput();
		setInputValidation({ status: "validating" });

		let failureMessage = "Failed to read template file";
		try {
			const jsonData = await read();
			if (id !== inputRevision.current) return;

			failureMessage = "Failed to validate template";
			const response = await fetch("/api/trash-guides/sharing/validate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonData }),
			});

			if (!response.ok) {
				throw new Error("Validation failed");
			}

			const result = await response.json();
			if (id !== inputRevision.current) return;
			if (result.success !== true || !result.data?.validation || !result.data.compatibility) {
				throw new Error("Validation failed");
			}

			setInputValidation({
				status: "validated",
				id,
				jsonData,
				validation: result.data.validation,
				compatibility: result.data.compatibility,
			});
		} catch (_error) {
			if (id !== inputRevision.current) return;

			setInputValidation(null);
			resetFileInput?.();
			alert(failureMessage);
		}
	};

	const handleSourceChange = (next: ImportSource) => {
		if (isImportPending()) return;
		invalidateInput();
		setSource(next);
	};

	const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
		if (isImportPending()) return;
		const input = event.currentTarget;
		const file = input.files?.[0];
		if (!file) {
			invalidateInput();
			return;
		}
		void validateInput(
			() => file.text(),
			() => {
				input.value = "";
			},
		);
	};

	const handlePasteEdit = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
		if (isImportPending()) return;
		invalidateInput();
		setPasteDraft(event.currentTarget.value);
	};

	const handleValidatePaste = () => {
		if (isImportPending() || isValidating || !pasteDraft.trim()) return;
		void validateInput(() => pasteDraft);
	};

	const handleClose = () => {
		if (isImportPending()) return;
		invalidateInput();
		onClose?.();
	};

	const handleImport = () => {
		if (
			!validatedInput ||
			!canImport ||
			validatedInput.id !== inputRevision.current ||
			isImportPending()
		) {
			return;
		}

		if (!onlineManager.isOnline()) {
			toast.error("Reconnect to import the template");
			return;
		}

		importMutation.mutate(
			{ jsonData: validatedInput.jsonData, options },
			{
				onSuccess: () => {
					onImportComplete?.();
					onClose?.();
				},
			},
		);
	};

	const incompatible = compatibility?.compatible === false;
	const hasValidationStatus =
		isValidating || canImport || (validation && (!validation.valid || incompatible));
	const hasErrors = validation?.errors && validation.errors.length > 0;
	const hasWarnings = validation?.warnings && validation.warnings.length > 0;
	const hasConflicts = validation?.conflicts && validation.conflicts.length > 0;

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: `1px solid ${themeGradient.from}30`,
						}}
					>
						<Upload className="h-5 w-5" style={{ color: themeGradient.from }} />
					</div>
					<div>
						<h3 className="text-lg font-semibold text-foreground">Import Template</h3>
						<p className="text-xs text-muted-foreground">Upload or paste a JSON template</p>
					</div>
				</div>
				{onClose && (
					<button
						type="button"
						onClick={handleClose}
						disabled={importMutation.isPending}
						aria-label="Close import modal"
						className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
					>
						<X className="h-4 w-4" />
					</button>
				)}
			</div>

			{/* Info Banner */}
			<div
				className="flex items-start gap-3 rounded-xl px-4 py-3"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}08, ${themeGradient.to}08)`,
					border: `1px solid ${themeGradient.from}20`,
				}}
			>
				<Info className="h-4 w-4 mt-0.5 shrink-0" style={{ color: themeGradient.from }} />
				<p className="text-sm text-muted-foreground">
					Templates are checked for compatibility and conflicts before import.
				</p>
			</div>

			<fieldset disabled={importMutation.isPending} className="flex flex-wrap gap-4">
				<legend className="mb-2 text-xs uppercase tracking-wider text-muted-foreground font-medium">
					Import source
				</legend>
				<label className="flex items-center gap-2 text-sm">
					<input
						type="radio"
						name={controlId}
						checked={source === "file"}
						onChange={() => handleSourceChange("file")}
						className="accent-primary"
					/>
					Upload JSON file
				</label>
				<label className="flex items-center gap-2 text-sm">
					<input
						type="radio"
						name={controlId}
						checked={source === "paste"}
						onChange={() => handleSourceChange("paste")}
						className="accent-primary"
					/>
					Paste JSON
				</label>
			</fieldset>

			{source === "file" ? (
				<div className="space-y-2">
					<label
						htmlFor={`${controlId}-file`}
						className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium"
					>
						<FileJson className="h-3 w-3" />
						Select Template File
					</label>
					<Input
						id={`${controlId}-file`}
						type="file"
						accept=".json"
						onChange={handleFileSelect}
						disabled={importMutation.isPending}
						className="w-full rounded-xl"
					/>
				</div>
			) : (
				<div className="space-y-2">
					<label
						htmlFor={`${controlId}-paste`}
						className="text-xs uppercase tracking-wider text-muted-foreground font-medium"
					>
						Template JSON
					</label>
					<Textarea
						id={`${controlId}-paste`}
						value={pasteDraft}
						onChange={handlePasteEdit}
						disabled={importMutation.isPending}
						rows={6}
						className="rounded-xl font-mono"
					/>
					<Button
						type="button"
						variant="outline"
						onClick={handleValidatePaste}
						disabled={isValidating || importMutation.isPending || !pasteDraft.trim()}
						className="rounded-xl"
					>
						Validate JSON
					</Button>
				</div>
			)}

			{/* Validation Status */}
			<div role="status" aria-atomic="true" className={hasValidationStatus ? undefined : "sr-only"}>
				{isValidating && (
					<div className="flex items-center gap-3 py-4 justify-center text-muted-foreground">
						<Loader2 className="h-5 w-5 animate-spin" style={{ color: themeGradient.from }} />
						<span className="text-sm">Validating template...</span>
					</div>
				)}
				{canImport && (
					<div
						className="flex items-center gap-3 rounded-xl px-4 py-3"
						style={{
							backgroundColor: SEMANTIC_COLORS.success.bg,
							border: `1px solid ${SEMANTIC_COLORS.success.border}`,
						}}
					>
						<CheckCircle
							className="h-5 w-5 shrink-0"
							style={{ color: SEMANTIC_COLORS.success.from }}
						/>
						<p className="text-sm" style={{ color: SEMANTIC_COLORS.success.text }}>
							Template is valid and ready to import
						</p>
					</div>
				)}
				{validation && (!validation.valid || incompatible) && (
					<div
						className="flex items-center gap-3 rounded-xl px-4 py-3"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
						}}
					>
						<AlertCircle
							className="h-5 w-5 shrink-0"
							style={{ color: SEMANTIC_COLORS.error.from }}
						/>
						<p className="text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
							{validation.valid
								? "Template is incompatible and cannot be imported"
								: "Template has validation errors that must be fixed"}
						</p>
					</div>
				)}
			</div>

			{/* Validation Results */}
			{validation && (
				<div className="space-y-4">
					{/* Errors */}
					{hasErrors && (
						<div
							className="rounded-xl p-4 space-y-3"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<div className="flex items-center gap-2">
								<AlertCircle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.error.from }} />
								<span className="font-medium text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
									Validation Errors
								</span>
							</div>
							<ul className="space-y-1.5 text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>
								{validation.errors.map((error, i) => (
									<li key={i} className="flex items-start gap-2">
										<span style={{ color: SEMANTIC_COLORS.error.from }}>•</span>
										<span>
											{error.field}: {error.message}
										</span>
									</li>
								))}
							</ul>
						</div>
					)}

					{/* Warnings */}
					{hasWarnings && (
						<div
							className="rounded-xl p-4 space-y-3"
							style={{
								backgroundColor: SEMANTIC_COLORS.warning.bg,
								border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
							}}
						>
							<div className="flex items-center gap-2">
								<AlertTriangle
									className="h-4 w-4"
									style={{ color: SEMANTIC_COLORS.warning.from }}
								/>
								<span
									className="font-medium text-sm"
									style={{ color: SEMANTIC_COLORS.warning.text }}
								>
									Warnings
								</span>
							</div>
							<ul className="space-y-1.5 text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>
								{validation.warnings.map((warning, i) => (
									<li key={i} className="flex items-start gap-2">
										<span style={{ color: SEMANTIC_COLORS.warning.from }}>•</span>
										<span>
											{warning.field}: {warning.message}
											{warning.suggestion && ` (${warning.suggestion})`}
										</span>
									</li>
								))}
							</ul>
						</div>
					)}

					{/* Conflicts */}
					{hasConflicts && (
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 space-y-4">
							<div className="flex items-center gap-2">
								<AlertTriangle className="h-4 w-4 text-muted-foreground" />
								<span className="font-medium text-sm text-foreground">Conflicts Detected</span>
							</div>

							{validation.conflicts.map((conflict, i) => (
								<div key={i} className="space-y-3">
									<p className="text-sm text-muted-foreground">{conflict.message}</p>

									{conflict.type === "name" && (
										<div className="space-y-2">
											<label className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
												Resolution:
											</label>
											<select
												value={options.onNameConflict}
												onFocus={() => setFocusedSelect(true)}
												onBlur={() => setFocusedSelect(false)}
												onChange={(e) =>
													setOptions({
														...options,
														onNameConflict: e.target.value as "rename" | "replace" | "cancel",
													})
												}
												className="w-full rounded-lg border bg-card/50 backdrop-blur-xs px-3 py-2 text-sm text-foreground transition-all duration-200 focus:outline-hidden appearance-none cursor-pointer"
												style={{
													borderColor: focusedSelect
														? themeGradient.from
														: "hsl(var(--border) / 0.5)",
													boxShadow: focusedSelect ? `0 0 0 1px ${themeGradient.from}` : undefined,
												}}
											>
												<option value="rename">Rename (add number suffix)</option>
												<option value="replace">Replace existing template</option>
												<option value="cancel">Cancel import</option>
											</select>
										</div>
									)}
								</div>
							))}
						</div>
					)}

					{/* Compatibility */}
					{compatibility && incompatible && (
						<div
							className="rounded-xl p-4 space-y-3"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<div className="flex items-center gap-2">
								<AlertCircle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.error.from }} />
								<span className="font-medium text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
									Compatibility Issues
								</span>
							</div>
							<ul className="space-y-1 text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>
								{compatibility.issues.map((issue, i) => (
									<li key={i} className="flex items-start gap-2">
										<span style={{ color: SEMANTIC_COLORS.error.from }}>•</span>
										<span>{issue.message}</span>
									</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}

			{/* Import Options */}
			{canImport && (
				<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 space-y-4">
					<div className="flex items-center gap-2">
						<Settings2 className="h-4 w-4" style={{ color: themeGradient.from }} />
						<h4 className="text-sm font-semibold text-foreground">Import Options</h4>
					</div>

					<div className="space-y-3">
						{/* Quality Settings Toggle */}
						<label className="flex items-center justify-between cursor-pointer group">
							<span className="text-sm text-foreground">Import Quality Settings</span>
							<div
								className="relative h-5 w-9 rounded-full transition-colors duration-200"
								style={{
									background: options.includeQualitySettings
										? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
										: "hsl(var(--muted) / 0.5)",
								}}
							>
								<div
									className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
										options.includeQualitySettings ? "translate-x-4" : "translate-x-0.5"
									}`}
								/>
							</div>
							<input
								type="checkbox"
								className="sr-only"
								checked={options.includeQualitySettings}
								onChange={(e) =>
									setOptions({ ...options, includeQualitySettings: e.target.checked })
								}
							/>
						</label>

						{/* Custom Conditions Toggle */}
						<label className="flex items-center justify-between cursor-pointer group">
							<span className="text-sm text-foreground">Import Custom Conditions</span>
							<div
								className="relative h-5 w-9 rounded-full transition-colors duration-200"
								style={{
									background: options.includeCustomConditions
										? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
										: "hsl(var(--muted) / 0.5)",
								}}
							>
								<div
									className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
										options.includeCustomConditions ? "translate-x-4" : "translate-x-0.5"
									}`}
								/>
							</div>
							<input
								type="checkbox"
								className="sr-only"
								checked={options.includeCustomConditions}
								onChange={(e) =>
									setOptions({ ...options, includeCustomConditions: e.target.checked })
								}
							/>
						</label>

						{/* Metadata Toggle */}
						<label className="flex items-center justify-between cursor-pointer group">
							<span className="text-sm text-foreground">Import Metadata</span>
							<div
								className="relative h-5 w-9 rounded-full transition-colors duration-200"
								style={{
									background: options.includeMetadata
										? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
										: "hsl(var(--muted) / 0.5)",
								}}
							>
								<div
									className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
										options.includeMetadata ? "translate-x-4" : "translate-x-0.5"
									}`}
								/>
							</div>
							<input
								type="checkbox"
								className="sr-only"
								checked={options.includeMetadata}
								onChange={(e) => setOptions({ ...options, includeMetadata: e.target.checked })}
							/>
						</label>
					</div>
				</div>
			)}

			{/* Actions */}
			<div className="flex justify-end gap-3 pt-4 border-t border-border/30">
				{onClose && (
					<Button
						variant="outline"
						onClick={handleClose}
						disabled={importMutation.isPending}
						className="rounded-xl"
					>
						Cancel
					</Button>
				)}
				<Button
					onClick={handleImport}
					disabled={!canImport || importMutation.isPending}
					className="gap-2 rounded-xl font-medium"
					style={
						canImport
							? {
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
								}
							: undefined
					}
				>
					{importMutation.isPending ? (
						<>
							<Loader2 className="h-4 w-4 animate-spin" />
							Importing...
						</>
					) : (
						<>
							<Upload className="h-4 w-4" />
							Import Template
						</>
					)}
				</Button>
			</div>
		</div>
	);
}
