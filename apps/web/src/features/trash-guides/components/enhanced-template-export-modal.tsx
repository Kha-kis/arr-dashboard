/**
 * Enhanced Template Export Modal
 *
 * Export templates with metadata and filtering options
 */

"use client";

import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Download, Info } from "lucide-react";
import type { TemplateExportOptions } from "@arr/shared";

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
			a.href = url;
			a.download = `${templateName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.json`;
			document.body.appendChild(a);
			a.click();
			window.URL.revokeObjectURL(url);
			document.body.removeChild(a);

			onClose?.();
		} catch (error) {
			console.error("Failed to export template:", error);
			alert("Failed to export template");
		} finally {
			setIsExporting(false);
		}
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-semibold text-fg">Export Template</h3>
				{onClose && (
					<Button size="sm" variant="ghost" onClick={onClose}>
						Close
					</Button>
				)}
			</div>

			<Alert>
				<Info className="h-4 w-4" />
				<AlertDescription className="text-xs">
					Export "{templateName}" with metadata and filtering options for sharing
					or backup.
				</AlertDescription>
			</Alert>

			{/* Export Options */}
			<div className="space-y-3 rounded border border-border/30 p-4 bg-bg-subtle/40">
				<h4 className="text-sm font-medium text-fg">Export Options</h4>

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
						<span className="text-sm text-fg">Include Quality Settings</span>
					</label>
					<p className="text-xs text-fg-muted ml-6">
						Quality profile, cutoffs, and upgrade behavior
					</p>

					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={options.includeCustomConditions}
							onChange={(e) =>
								setOptions({ ...options, includeCustomConditions: e.target.checked })
							}
							className="h-4 w-4 rounded border-border bg-bg-hover text-primary focus:ring-primary"
						/>
						<span className="text-sm text-fg">Include Custom Conditions</span>
					</label>
					<p className="text-xs text-fg-muted ml-6">
						Modified custom format specifications and patterns
					</p>

					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={options.includeMetadata}
							onChange={(e) =>
								setOptions({ ...options, includeMetadata: e.target.checked })
							}
							className="h-4 w-4 rounded border-border bg-bg-hover text-primary focus:ring-primary"
						/>
						<span className="text-sm text-fg">Include Metadata</span>
					</label>
					<p className="text-xs text-fg-muted ml-6">
						Author, tags, and additional template information
					</p>
				</div>
			</div>

			{/* Metadata */}
			{options.includeMetadata && (
				<div className="space-y-3 rounded border border-border/30 p-4 bg-bg-subtle/40">
					<h4 className="text-sm font-medium text-fg">Metadata</h4>

					<div className="space-y-3">
						<div>
							<label className="block text-xs font-medium text-fg-muted mb-1">
								Author
							</label>
							<input
								type="text"
								value={author}
								onChange={(e) => setAuthor(e.target.value)}
								placeholder="Your name or username"
								className="w-full rounded border border-border bg-bg-hover px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary/50"
							/>
						</div>

						<div>
							<label className="block text-xs font-medium text-fg-muted mb-1">
								Category
							</label>
							<select
								value={category}
								onChange={(e) => setCategory(e.target.value)}
								className="w-full rounded border border-border bg-bg-hover px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary/50"
							>
								<option value="">Select a category...</option>
								{CATEGORIES.map((cat) => (
									<option key={cat.value} value={cat.value}>
										{cat.label}
									</option>
								))}
							</select>
						</div>

						<div>
							<label className="block text-xs font-medium text-fg-muted mb-1">
								Tags (comma-separated)
							</label>
							<input
								type="text"
								value={tags}
								onChange={(e) => setTags(e.target.value)}
								placeholder="4K, HDR, remux, anime"
								className="w-full rounded border border-border bg-bg-hover px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary/50"
							/>
						</div>

						<div>
							<label className="block text-xs font-medium text-fg-muted mb-1">
								Notes
							</label>
							<textarea
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
								placeholder="Additional notes about this template..."
								rows={3}
								className="w-full rounded border border-border bg-bg-hover px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary/50"
							/>
						</div>
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
					onClick={handleExport}
					disabled={isExporting}
					className="gap-2"
				>
					<Download className="h-4 w-4" />
					{isExporting ? "Exporting..." : "Export Template"}
				</Button>
			</div>
		</div>
	);
}
