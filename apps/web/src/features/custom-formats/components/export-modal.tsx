/**
 * Export Custom Format Modal
 * Shows JSON with copy and download options (like Sonarr/Radarr)
 */

"use client";

import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	Button,
	toast,
} from "../../../components/ui";

interface ExportModalProps {
	isOpen: boolean;
	onClose: () => void;
	customFormat: any | null;
	formatName: string;
}

export function ExportModal({
	isOpen,
	onClose,
	customFormat,
	formatName,
}: ExportModalProps) {
	const [isCopied, setIsCopied] = useState(false);

	const jsonString = customFormat ? JSON.stringify(customFormat, null, 2) : "";

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(jsonString);
			setIsCopied(true);
			toast.success("Custom format copied to clipboard");
			setTimeout(() => setIsCopied(false), 2000);
		} catch (error) {
			toast.error("Failed to copy to clipboard");
		}
	};

	const handleDownload = () => {
		try {
			const blob = new Blob([jsonString], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${formatName.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.json`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
			toast.success("Custom format downloaded");
		} catch (error) {
			toast.error("Failed to download custom format");
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>Export Custom Format</DialogTitle>
					<DialogDescription>
						Copy the JSON below or download it as a file
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 overflow-hidden flex flex-col min-h-0">
					<div className="flex items-center justify-between mb-2">
						<span className="text-sm font-medium text-fg">{formatName}</span>
						<span className="text-xs text-fg-muted">
							{jsonString.split("\n").length} lines
						</span>
					</div>

					<div className="flex-1 overflow-y-auto rounded-lg border border-border bg-bg-muted">
						<pre className="p-4 text-xs text-fg font-mono leading-relaxed">
							{jsonString}
						</pre>
					</div>
				</div>

				<DialogFooter className="flex gap-2">
					<Button variant="ghost" onClick={onClose}>
						Close
					</Button>
					<Button variant="secondary" onClick={handleCopy}>
						{isCopied ? "✓ Copied" : "Copy to Clipboard"}
					</Button>
					<Button onClick={handleDownload}>Download JSON</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
