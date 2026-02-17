"use client";

/**
 * Template Import Dialog
 *
 * Premium import dialog with:
 * - Glassmorphic container with backdrop blur
 * - Theme-aware styling using THEME_GRADIENTS
 * - Semantic color feedback for errors
 * - Animated entrance effects
 */

import { useState, useEffect, useRef } from "react";
import { useImportTemplate } from "../../../hooks/api/useTemplates";
import { Input, Button } from "../../../components/ui";
import { Upload, X, FileJson, AlertCircle, Info, Loader2 } from "lucide-react";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getErrorMessage } from "../../../lib/error-utils";

interface TemplateImportDialogProps {
	open: boolean;
	onClose: () => void;
}

export const TemplateImportDialog = ({ open, onClose }: TemplateImportDialogProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [jsonData, setJsonData] = useState("");
	const [parseError, setParseError] = useState<string | null>(null);
	const [isFocused, setIsFocused] = useState(false);
	const importMutation = useImportTemplate();
	const fileInputRef = useRef<HTMLInputElement>(null);

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
		} catch {
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
					// Reset file input to allow re-selecting the same file
					if (fileInputRef.current) {
						fileInputRef.current.value = "";
					}
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

	const hasError = importMutation.isError || parseError;
	const errorMessage = parseError ||
		(getErrorMessage(importMutation.error, "Failed to import template"));
	const canImport = jsonData.trim() && !importMutation.isPending;

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={(e) => e.target === e.currentTarget && onClose()}
			role="presentation"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

			{/* Modal */}
			<div
				className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${themeGradient.from}15`,
				}}
				role="dialog"
				aria-modal="true"
				aria-labelledby="import-template-title"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Close Button */}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close"
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
							<Upload className="h-6 w-6" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h2 id="import-template-title" className="text-xl font-bold text-foreground">
								Import Template
							</h2>
							<p className="text-sm text-muted-foreground">
								Upload a JSON file or paste template data
							</p>
						</div>
					</div>
				</div>

				{/* Content */}
				<div className="p-6 space-y-5">
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
							Import a template from a JSON file exported from TRaSH Guides or another arr-dashboard instance.
						</p>
					</div>

					{/* Error Display */}
					{hasError && (
						<div
							className="flex items-start gap-3 rounded-xl px-4 py-3 animate-in fade-in slide-in-from-bottom-2"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<AlertCircle
								className="h-4 w-4 mt-0.5 shrink-0"
								style={{ color: SEMANTIC_COLORS.error.from }}
							/>
							<p className="text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
								{errorMessage}
							</p>
						</div>
					)}

					{/* File Upload Section */}
					<div className="space-y-2">
						<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
							<FileJson className="h-3 w-3" />
							Upload JSON File
						</label>
						<Input
							ref={fileInputRef}
							type="file"
							accept=".json,application/json"
							onChange={handleFileUpload}
							className="w-full rounded-xl"
						/>
					</div>

					{/* Divider */}
					<div className="flex items-center gap-4">
						<div className="h-px flex-1 bg-border/50" />
						<span className="text-xs text-muted-foreground uppercase tracking-wider">or</span>
						<div className="h-px flex-1 bg-border/50" />
					</div>

					{/* Paste JSON Section */}
					<div className="space-y-2">
						<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
							<FileJson className="h-3 w-3" />
							Paste JSON Data
						</label>
						<textarea
							value={jsonData}
							onChange={(e) => {
								setJsonData(e.target.value);
								setParseError(null);
							}}
							onFocus={() => setIsFocused(true)}
							onBlur={() => setIsFocused(false)}
							placeholder='{"version": "1.0", "template": {...}}'
							rows={10}
							className="w-full rounded-xl border bg-card/50 backdrop-blur-xs px-4 py-3 font-mono text-sm text-foreground placeholder:text-muted-foreground/60 transition-all duration-200 focus:outline-hidden resize-none"
							style={{
								borderColor: isFocused ? themeGradient.from : "hsl(var(--border) / 0.5)",
								boxShadow: isFocused ? `0 0 0 1px ${themeGradient.from}` : undefined,
							}}
						/>
					</div>
				</div>

				{/* Footer */}
				<div className="flex justify-end gap-3 p-6 pt-0">
					<Button variant="outline" onClick={onClose} className="rounded-xl">
						Cancel
					</Button>
					<Button
						onClick={handleImport}
						disabled={!canImport}
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
		</div>
	);
};
