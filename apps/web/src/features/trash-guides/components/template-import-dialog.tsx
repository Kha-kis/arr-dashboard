"use client";

import { useState, useEffect } from "react";
import { useImportTemplate } from "../../../hooks/api/useTemplates";
import { Alert, AlertDescription, Input } from "../../../components/ui";
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

		const reader = new FileReader();
		reader.onload = (e) => {
			const text = e.target?.result as string;
			setJsonData(text);
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
						<button
							type="button"
							onClick={onClose}
							className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleImport}
							disabled={!jsonData.trim() || importMutation.isPending}
							className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
						>
							<Upload className="h-4 w-4" />
							{importMutation.isPending ? "Importing..." : "Import Template"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
};
