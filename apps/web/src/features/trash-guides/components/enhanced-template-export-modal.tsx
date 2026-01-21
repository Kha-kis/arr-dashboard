/**
 * Enhanced Template Export Modal
 *
 * Premium export templates panel with validation and metadata options
 * - Theme-aware styling using THEME_GRADIENTS
 * - Premium toggle switches and form controls
 * - Consistent with EnhancedTemplateImportModal design
 */

"use client";

import { useState } from "react";
import { Button, Input } from "../../../components/ui";
import {
	Download,
	Info,
	FileJson,
	Settings2,
	User,
	Tag,
	Folder,
	FileText,
	Loader2,
	X,
} from "lucide-react";
import type { TemplateExportOptions } from "@arr/shared";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

interface EnhancedTemplateExportModalProps {
	templateId: string;
	templateName: string;
	onClose?: () => void;
}

const CATEGORIES = [
	{ value: "general", label: "General" },
	{ value: "anime", label: "Anime" },
	{ value: "movies", label: "Movies" },
	{ value: "tv", label: "TV Shows" },
	{ value: "remux", label: "Remux" },
	{ value: "web", label: "WEB" },
];

export function EnhancedTemplateExportModal({
	templateId,
	templateName,
	onClose,
}: EnhancedTemplateExportModalProps) {
	const { gradient: themeGradient } = useThemeGradient();

	const [options, setOptions] = useState<TemplateExportOptions>({
		includeQualitySettings: true,
		includeCustomConditions: true,
		includeMetadata: true,
		tags: [],
	});

	const [author, setAuthor] = useState("");
	const [category, setCategory] = useState<string>("");
	const [tags, setTags] = useState("");
	const [notes, setNotes] = useState("");
	const [isExporting, setIsExporting] = useState(false);
	const [focusedField, setFocusedField] = useState<string | null>(null);

	const handleExport = async () => {
		setIsExporting(true);

		try {
			// Prepare export options
			const exportOptions: TemplateExportOptions = {
				...options,
				author: author || undefined,
				category: (category as TemplateExportOptions["category"]) || undefined,
				tags: tags
					? tags.split(",").map((t) => t.trim()).filter(Boolean)
					: undefined,
				notes: notes || undefined,
			};

			// Call export API
			const response = await fetch("/api/trash-guides/sharing/export", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					templateId,
					options: exportOptions,
				}),
			});

			if (!response.ok) {
				throw new Error("Export failed");
			}

			// Download file
			const blob = await response.blob();
			const url = window.URL.createObjectURL(blob);
			const a = document.createElement("a");
			let appended = false;
			try {
				a.href = url;
				a.download = `${templateName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.json`;
				document.body.appendChild(a);
				appended = true;
				a.click();
				onClose?.();
			} finally {
				window.URL.revokeObjectURL(url);
				if (appended) {
					document.body.removeChild(a);
				}
			}
		} catch (error) {
			console.error("Failed to export template:", error);
			alert("Failed to export template");
		} finally {
			setIsExporting(false);
		}
	};

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
						<Download className="h-5 w-5" style={{ color: themeGradient.from }} />
					</div>
					<div>
						<h3 className="text-lg font-semibold text-foreground">Export Template</h3>
						<p className="text-xs text-muted-foreground">Create a shareable JSON file</p>
					</div>
				</div>
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						aria-label="Close export modal"
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
					Export &quot;{templateName}&quot; with metadata and filtering options for sharing
					or backup.
				</p>
			</div>

			{/* Export Options */}
			<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 space-y-4">
				<div className="flex items-center gap-2">
					<Settings2 className="h-4 w-4" style={{ color: themeGradient.from }} />
					<h4 className="text-sm font-semibold text-foreground">Export Options</h4>
				</div>

				<div className="space-y-3">
					{/* Quality Settings Toggle */}
					<label className="flex items-center justify-between cursor-pointer group">
						<div>
							<span className="text-sm text-foreground">Include Quality Settings</span>
							<p className="text-xs text-muted-foreground">
								Quality profile, cutoffs, and upgrade behavior
							</p>
						</div>
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
						<div>
							<span className="text-sm text-foreground">Include Custom Conditions</span>
							<p className="text-xs text-muted-foreground">
								Modified custom format specifications and patterns
							</p>
						</div>
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
						<div>
							<span className="text-sm text-foreground">Include Metadata</span>
							<p className="text-xs text-muted-foreground">
								Author, tags, and additional template information
							</p>
						</div>
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

			{/* Metadata */}
			{options.includeMetadata && (
				<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 space-y-4">
					<div className="flex items-center gap-2">
						<FileJson className="h-4 w-4" style={{ color: themeGradient.from }} />
						<h4 className="text-sm font-semibold text-foreground">Metadata</h4>
					</div>

					<div className="space-y-4">
						{/* Author */}
						<label className="block space-y-2">
							<span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
								<User className="h-3 w-3" />
								Author
							</span>
							<Input
								type="text"
								value={author}
								onChange={(e) => setAuthor(e.target.value)}
								onFocus={() => setFocusedField("author")}
								onBlur={() => setFocusedField(null)}
								placeholder="Your name or username"
								className="w-full rounded-xl"
								style={{
									borderColor: focusedField === "author" ? themeGradient.from : undefined,
									boxShadow: focusedField === "author" ? `0 0 0 1px ${themeGradient.from}` : undefined,
								}}
							/>
						</label>

						{/* Category */}
						<label className="block space-y-2">
							<span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
								<Folder className="h-3 w-3" />
								Category
							</span>
							<select
								value={category}
								onChange={(e) => setCategory(e.target.value)}
								onFocus={() => setFocusedField("category")}
								onBlur={() => setFocusedField(null)}
								className="w-full rounded-lg border bg-card/50 backdrop-blur-xs px-3 py-2 text-sm text-foreground transition-all duration-200 focus:outline-hidden appearance-none cursor-pointer"
								style={{
									borderColor: focusedField === "category" ? themeGradient.from : "hsl(var(--border) / 0.5)",
									boxShadow: focusedField === "category" ? `0 0 0 1px ${themeGradient.from}` : undefined,
								}}
							>
								<option value="">Select a category...</option>
								{CATEGORIES.map((cat) => (
									<option key={cat.value} value={cat.value}>
										{cat.label}
									</option>
								))}
							</select>
						</label>

						{/* Tags */}
						<label className="block space-y-2">
							<span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
								<Tag className="h-3 w-3" />
								Tags (comma-separated)
							</span>
							<Input
								type="text"
								value={tags}
								onChange={(e) => setTags(e.target.value)}
								onFocus={() => setFocusedField("tags")}
								onBlur={() => setFocusedField(null)}
								placeholder="4K, HDR, remux, anime"
								className="w-full rounded-xl"
								style={{
									borderColor: focusedField === "tags" ? themeGradient.from : undefined,
									boxShadow: focusedField === "tags" ? `0 0 0 1px ${themeGradient.from}` : undefined,
								}}
							/>
						</label>

						{/* Notes */}
						<label className="block space-y-2">
							<span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
								<FileText className="h-3 w-3" />
								Notes
							</span>
							<textarea
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
								onFocus={() => setFocusedField("notes")}
								onBlur={() => setFocusedField(null)}
								placeholder="Additional notes about this template..."
								rows={3}
								className="w-full rounded-xl border bg-card/50 backdrop-blur-xs px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 transition-all duration-200 focus:outline-hidden resize-none"
								style={{
									borderColor: focusedField === "notes" ? themeGradient.from : "hsl(var(--border) / 0.5)",
									boxShadow: focusedField === "notes" ? `0 0 0 1px ${themeGradient.from}` : undefined,
								}}
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
					onClick={handleExport}
					disabled={isExporting}
					className="gap-2 rounded-xl font-medium"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
					}}
				>
					{isExporting ? (
						<>
							<Loader2 className="h-4 w-4 animate-spin" />
							Exporting...
						</>
					) : (
						<>
							<Download className="h-4 w-4" />
							Export Template
						</>
					)}
				</Button>
			</div>
		</div>
	);
}
