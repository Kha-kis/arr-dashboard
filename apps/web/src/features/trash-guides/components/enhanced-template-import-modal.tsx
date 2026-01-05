/**
 * Enhanced Template Import Modal
 *
 * Premium import templates panel with validation and conflict resolution
 * - Theme-aware styling using THEME_GRADIENTS
 * - Semantic color feedback for validation states
 * - Premium toggle switches and form controls
 */

"use client";

import { useState } from "react";
import { Button, Input } from "../../../components/ui";
import {
	Upload,
	AlertCircle,
	CheckCircle,
	Info,
	AlertTriangle,
	FileJson,
	Settings2,
	Loader2,
	X,
} from "lucide-react";
import { toast } from "sonner";
import type {
	TemplateImportOptions,
	TemplateImportValidation,
	TemplateCompatibility,
} from "@arr/shared";
import { useEnhancedImportTemplate } from "../../../hooks/api/useTemplates";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

interface EnhancedTemplateImportModalProps {
	onImportComplete?: () => void;
	onClose?: () => void;
}

export function EnhancedTemplateImportModal({
	onImportComplete,
	onClose,
}: EnhancedTemplateImportModalProps) {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	const [jsonData, setJsonData] = useState("");
	const [validation, setValidation] = useState<TemplateImportValidation | null>(
		null,
	);
	const [compatibility, setCompatibility] = useState<TemplateCompatibility | null>(
		null,
	);
	const [isValidating, setIsValidating] = useState(false);
	const [options, setOptions] = useState<TemplateImportOptions>({
		onNameConflict: "rename",
		includeQualitySettings: true,
		includeCustomConditions: true,
		includeMetadata: true,
		strictValidation: false,
	});
	const [focusedSelect, setFocusedSelect] = useState(false);

	const importMutation = useEnhancedImportTemplate();

	const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		try {
			const text = await file.text();
			setJsonData(text);
			await validateTemplate(text);
		} catch (error) {
			console.error("Failed to read file:", error);
			alert("Failed to read template file");
		}
	};

	const validateTemplate = async (data: string) => {
		setIsValidating(true);

		try {
			const response = await fetch("/api/trash-guides/sharing/validate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonData: data }),
			});

			if (!response.ok) {
				throw new Error("Validation failed");
			}

			const result = await response.json();
			setValidation(result.data.validation);
			setCompatibility(result.data.compatibility);
		} catch (error) {
			console.error("Failed to validate template:", error);
			alert("Failed to validate template");
		} finally {
			setIsValidating(false);
		}
	};

	const handleImport = () => {
		if (!jsonData || !validation?.valid) return;

		importMutation.mutate(
			{ jsonData, options },
			{
				onSuccess: () => {
					onImportComplete?.();
					onClose?.();
				},
				onError: (error) => {
					const errorMessage = error instanceof Error
						? error.message
						: "Failed to import template";
					toast.error(errorMessage);
				},
			},
		);
	};

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
						<p className="text-xs text-muted-foreground">Upload and validate template files</p>
					</div>
				</div>
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
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
					Import a template from JSON file. The template will be validated for
					compatibility and conflicts before import.
				</p>
			</div>

			{/* File Upload */}
			<div className="space-y-2">
				<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
					<FileJson className="h-3 w-3" />
					Select Template File
				</label>
				<Input
					type="file"
					accept=".json"
					onChange={handleFileSelect}
					className="w-full rounded-xl"
				/>
			</div>

			{/* Validation Status */}
			{isValidating && (
				<div className="flex items-center gap-3 py-4 justify-center text-muted-foreground">
					<Loader2 className="h-5 w-5 animate-spin" style={{ color: themeGradient.from }} />
					<span className="text-sm">Validating template...</span>
				</div>
			)}

			{/* Validation Results */}
			{validation && !isValidating && (
				<div className="space-y-4">
					{/* Overall Status */}
					{validation.valid ? (
						<div
							className="flex items-center gap-3 rounded-xl px-4 py-3"
							style={{
								backgroundColor: SEMANTIC_COLORS.success.bg,
								border: `1px solid ${SEMANTIC_COLORS.success.border}`,
							}}
						>
							<CheckCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.success.from }} />
							<p className="text-sm" style={{ color: SEMANTIC_COLORS.success.text }}>
								Template is valid and ready to import
							</p>
						</div>
					) : (
						<div
							className="flex items-center gap-3 rounded-xl px-4 py-3"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<AlertCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
							<p className="text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
								Template has validation errors that must be fixed
							</p>
						</div>
					)}

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
								{validation.errors.map((error: any, i: number) => (
									<li key={i} className="flex items-start gap-2">
										<span style={{ color: SEMANTIC_COLORS.error.from }}>•</span>
										<span>{error.field}: {error.message}</span>
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
								<AlertTriangle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.warning.from }} />
								<span className="font-medium text-sm" style={{ color: SEMANTIC_COLORS.warning.text }}>
									Warnings
								</span>
							</div>
							<ul className="space-y-1.5 text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>
								{validation.warnings.map((warning: any, i: number) => (
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
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 space-y-4">
							<div className="flex items-center gap-2">
								<AlertTriangle className="h-4 w-4 text-muted-foreground" />
								<span className="font-medium text-sm text-foreground">
									Conflicts Detected
								</span>
							</div>

							{validation.conflicts.map((conflict: any, i: number) => (
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
														onNameConflict: e.target.value as any,
													})
												}
												className="w-full rounded-lg border bg-card/50 backdrop-blur-sm px-3 py-2 text-sm text-foreground transition-all duration-200 focus:outline-none appearance-none cursor-pointer"
												style={{
													borderColor: focusedSelect ? themeGradient.from : "hsl(var(--border) / 0.5)",
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
					{compatibility && !compatibility.compatible && (
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
								{compatibility.issues.map((issue: any, i: number) => (
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
			{validation && validation.valid && (
				<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 space-y-4">
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
								onChange={(e) =>
									setOptions({ ...options, includeMetadata: e.target.checked })
								}
							/>
						</label>
					</div>
				</div>
			)}

			{/* Actions */}
			<div className="flex justify-end gap-3 pt-4 border-t border-border/30">
				{onClose && (
					<Button variant="outline" onClick={onClose} className="rounded-xl">
						Cancel
					</Button>
				)}
				<Button
					onClick={handleImport}
					disabled={!validation?.valid || importMutation.isPending}
					className="gap-2 rounded-xl font-medium"
					style={
						validation?.valid
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
