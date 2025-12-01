"use client";

import { useState, useEffect } from "react";
import { useImportTemplate } from "../../../hooks/api/useTemplates";
import { Alert, AlertDescription, Input, Button } from "../../../components/ui";
import { Upload, X } from "lucide-react";

interface TemplateImportDialogProps {
	open: boolean;
	onClose: () => void;
}

export const TemplateImportDialog = ({ open, onClose }: TemplateImportDialogProps) => {
	const [jsonData, setJsonData] = useState("");
	const [parseError, setParseError] = useState<string | null>(null);
	const importMutation = useImportTemplate();

	const handleImport = async () => {
		if (!jsonData.trim()) {
			return;
		}

		// Validate JSON before sending to API
		setParseError(null);
		try {
			JSON.parse(jsonData.trim());
		} catch {
			setParseError("Invalid JSON format. Please check your input.");
			return;
		}

		try {
			await importMutation.mutateAsync(jsonData);
			setJsonData("");
			onClose();
		} catch (error) {
			// Error will be displayed through mutation state
		}
	};

	const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) return;

		// Clear any previous errors when starting a new file read
		setParseError(null);

		// File size validation - limit to 10MB to prevent browser freeze
		const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
		if (file.size > MAX_FILE_SIZE) {
			setParseError(
				`File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum allowed size is 10MB.`
			);
			// Reset the input to allow re-selecting
			event.target.value = "";
			return;
		}

		const reader = new FileReader();

		reader.onload = (e) => {
			const result = e.target?.result;
			if (typeof result === "string") {
				// Validate that the result is non-empty before setting
				if (result.trim()) {
					setJsonData(result);
				} else {
					setParseError("File is empty. Please select a valid JSON file.");
					setJsonData("");
				}
			} else {
				setParseError("Failed to read file. Please try again or paste the JSON directly.");
				setJsonData("");
			}
		};

		reader.onerror = () => {
			// Abort any ongoing read operation
			reader.abort();
			setParseError("Failed to read file. Please try again or paste the JSON directly.");
			setJsonData("");
		};

		reader.onabort = () => {
			setParseError("File reading was cancelled. Please try again.");
			setJsonData("");
		};

		reader.readAsText(file);
	};

	// Handle Escape key at document level
	useEffect(() => {
		if (!open) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
			onClick={(e) => e.target === e.currentTarget && onClose()}
			role="presentation"
		>
			<div
				className="relative w-full max-w-2xl rounded-xl border border-white/10 bg-slate-900 p-6 shadow-xl"
				role="dialog"
				aria-modal="true"
				aria-labelledby="import-template-title"
			>
				{/* Header */}
				<div className="mb-4 flex items-center justify-between">
					<h2 id="import-template-title" className="text-xl font-semibold text-white">Import Template</h2>
					<button
						type="button"
						onClick={onClose}
						className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				{/* Content */}
				<div className="space-y-4">
					{(importMutation.isError || parseError) && (
						<Alert variant="danger">
							<AlertDescription>
								{parseError ||
									(importMutation.error instanceof Error
										? importMutation.error.message
										: "Failed to import template")}
							</AlertDescription>
						</Alert>
					)}

					{/* File Upload */}
					<div>
						<label className="mb-2 block text-sm font-medium text-white">
							Upload JSON File
						</label>
						<Input
							type="file"
							accept=".json,application/json"
							onChange={handleFileUpload}
							className="w-full"
						/>
					</div>

					<div className="flex items-center gap-4">
						<div className="h-px flex-1 bg-white/10" />
						<span className="text-sm text-white/60">or</span>
						<div className="h-px flex-1 bg-white/10" />
					</div>

					{/* Paste JSON */}
					<div>
						<label className="mb-2 block text-sm font-medium text-white">
							Paste JSON Data
						</label>
						<textarea
							value={jsonData}
							onChange={(e) => {
								setJsonData(e.target.value);
								setParseError(null);
							}}
							placeholder='{"version": "1.0", "template": {...}}'
							rows={12}
							className="w-full rounded-xl border border-border bg-bg-subtle px-4 py-3 font-mono text-sm text-fg placeholder:text-fg-muted/60 transition-all duration-200 hover:border-border/80 hover:bg-bg-subtle/80 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-bg-subtle/80"
						/>
					</div>

					{/* Actions */}
					<div className="flex justify-end gap-2">
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							variant="primary"
							onClick={handleImport}
							disabled={!jsonData.trim() || importMutation.isPending}
							className="gap-2"
						>
							<Upload className="h-4 w-4" />
							{importMutation.isPending ? "Importing..." : "Import Template"}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
};
