/**
 * Enhanced Template Import Modal
 *
 * Import templates with validation and conflict resolution
 */

"use client";

import { useState } from "react";
import { Button, Alert, AlertDescription, Select, SelectOption, Input } from "../../../components/ui";
import {
	Upload,
	AlertCircle,
	CheckCircle,
	Info,
	AlertTriangle,
} from "lucide-react";
import type {
	TemplateImportOptions,
	TemplateImportValidation,
	TemplateCompatibility,
} from "@arr/shared";

interface EnhancedTemplateImportModalProps {
	onImportComplete?: () => void;
	onClose?: () => void;
}

export function EnhancedTemplateImportModal({
	onImportComplete,
	onClose,
}: EnhancedTemplateImportModalProps) {
	const [jsonData, setJsonData] = useState("");
	const [validation, setValidation] = useState<TemplateImportValidation | null>(
		null,
	);
	const [compatibility, setCompatibility] = useState<TemplateCompatibility | null>(
		null,
	);
	const [isValidating, setIsValidating] = useState(false);
	const [isImporting, setIsImporting] = useState(false);
	const [options, setOptions] = useState<TemplateImportOptions>({
		onNameConflict: "rename",
		includeQualitySettings: true,
		includeCustomConditions: true,
		includeMetadata: true,
		strictValidation: false,
	});

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

	const handleImport = async () => {
		if (!jsonData || !validation?.valid) return;

		setIsImporting(true);

		try {
			const response = await fetch("/api/trash-guides/sharing/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonData,
					options,
				}),
			});

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Import failed");
			}

			onImportComplete?.();
			onClose?.();
		} catch (error) {
			console.error("Failed to import template:", error);
			alert(error instanceof Error ? error.message : "Failed to import template");
		} finally {
			setIsImporting(false);
		}
	};

	const hasErrors = validation?.errors && validation.errors.length > 0;
	const hasWarnings = validation?.warnings && validation.warnings.length > 0;
	const hasConflicts = validation?.conflicts && validation.conflicts.length > 0;

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-semibold text-fg">Import Template</h3>
				{onClose && (
					<Button size="sm" variant="ghost" onClick={onClose}>
						Close
					</Button>
				)}
			</div>

			<Alert>
				<Info className="h-4 w-4" />
				<AlertDescription className="text-xs">
					Import a template from JSON file. The template will be validated for
					compatibility and conflicts before import.
				</AlertDescription>
			</Alert>

			{/* File Upload */}
			<div className="space-y-2">
				<label className="block text-sm font-medium text-fg">
					Select Template File
				</label>
				<Input
					type="file"
					accept=".json"
					onChange={handleFileSelect}
					className="w-full"
				/>
			</div>

			{/* Validation Status */}
			{isValidating && (
				<div className="text-sm text-fg-muted">Validating template...</div>
			)}

			{/* Validation Results */}
			{validation && !isValidating && (
				<div className="space-y-3">
					{/* Overall Status */}
					{validation.valid ? (
						<Alert>
							<CheckCircle className="h-4 w-4 text-success" />
							<AlertDescription className="text-xs">
								Template is valid and ready to import
							</AlertDescription>
						</Alert>
					) : (
						<Alert variant="danger">
							<AlertCircle className="h-4 w-4" />
							<AlertDescription className="text-xs">
								Template has validation errors that must be fixed
							</AlertDescription>
						</Alert>
					)}

					{/* Errors */}
					{hasErrors && (
						<div className="rounded border border-destructive/30 p-3 bg-destructive/10 space-y-2">
							<div className="flex items-center gap-2">
								<AlertCircle className="h-4 w-4 text-destructive" />
								<span className="font-medium text-sm text-destructive">
									Validation Errors
								</span>
							</div>
							<ul className="list-disc list-inside space-y-1 text-xs text-destructive">
								{validation.errors.map((error: any, i: number) => (
									<li key={i}>
										{error.field}: {error.message}
									</li>
								))}
							</ul>
						</div>
					)}

					{/* Warnings */}
					{hasWarnings && (
						<div className="rounded border border-warning/30 p-3 bg-warning/10 space-y-2">
							<div className="flex items-center gap-2">
								<AlertTriangle className="h-4 w-4 text-warning" />
								<span className="font-medium text-sm text-warning">Warnings</span>
							</div>
							<ul className="list-disc list-inside space-y-1 text-xs text-warning">
								{validation.warnings.map((warning: any, i: number) => (
									<li key={i}>
										{warning.field}: {warning.message}
										{warning.suggestion && ` (${warning.suggestion})`}
									</li>
								))}
							</ul>
						</div>
					)}

					{/* Conflicts */}
					{hasConflicts && (
						<div className="rounded border border-border/30 p-3 bg-bg-subtle/40 space-y-3">
							<div className="flex items-center gap-2">
								<AlertTriangle className="h-4 w-4 text-fg-muted" />
								<span className="font-medium text-sm text-fg">
									Conflicts Detected
								</span>
							</div>

							{validation.conflicts.map((conflict: any, i: number) => (
								<div key={i} className="space-y-2">
									<div className="text-xs text-fg">{conflict.message}</div>

									{conflict.type === "name" && (
										<div className="space-y-2">
											<label className="block text-xs text-fg-muted">
												Resolution:
											</label>
											<Select
												value={options.onNameConflict}
												onChange={(e) =>
													setOptions({
														...options,
														onNameConflict: e.target.value as any,
													})
												}
												className="w-full"
											>
												<SelectOption value="rename">Rename (add number suffix)</SelectOption>
												<SelectOption value="replace">Replace existing template</SelectOption>
												<SelectOption value="cancel">Cancel import</SelectOption>
											</Select>
										</div>
									)}
								</div>
							))}
						</div>
					)}

					{/* Compatibility */}
					{compatibility && !compatibility.compatible && (
						<Alert variant="danger">
							<AlertCircle className="h-4 w-4" />
							<AlertDescription className="text-xs">
								Template may not be fully compatible with this system
								<ul className="list-disc list-inside mt-1 space-y-0.5">
									{compatibility.issues.map((issue: any, i: number) => (
										<li key={i}>{issue.message}</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					)}
				</div>
			)}

			{/* Import Options */}
			{validation && validation.valid && (
				<div className="space-y-3 rounded border border-border/30 p-4 bg-bg-subtle/40">
					<h4 className="text-sm font-medium text-fg">Import Options</h4>

					<div className="space-y-2">
						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={options.includeQualitySettings}
								onChange={(e) =>
									setOptions({ ...options, includeQualitySettings: e.target.checked })
								}
								className="h-4 w-4 rounded border-border bg-bg-hover text-primary focus:ring-primary"
							/>
							<span className="text-sm text-fg">Import Quality Settings</span>
						</label>

						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={options.includeCustomConditions}
								onChange={(e) =>
									setOptions({
										...options,
										includeCustomConditions: e.target.checked,
									})
								}
								className="h-4 w-4 rounded border-border bg-bg-hover text-primary focus:ring-primary"
							/>
							<span className="text-sm text-fg">Import Custom Conditions</span>
						</label>

						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={options.includeMetadata}
								onChange={(e) =>
									setOptions({ ...options, includeMetadata: e.target.checked })
								}
								className="h-4 w-4 rounded border-border bg-bg-hover text-primary focus:ring-primary"
							/>
							<span className="text-sm text-fg">Import Metadata</span>
						</label>
					</div>
				</div>
			)}

			{/* Actions */}
			<div className="flex justify-end gap-2 pt-2 border-t border-border/30">
				{onClose && (
					<Button variant="secondary" onClick={onClose}>
						Cancel
					</Button>
				)}
				<Button
					onClick={handleImport}
					disabled={!validation?.valid || isImporting}
					className="gap-2"
				>
					<Upload className="h-4 w-4" />
					{isImporting ? "Importing..." : "Import Template"}
				</Button>
			</div>
		</div>
	);
}
