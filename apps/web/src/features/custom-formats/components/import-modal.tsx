/**
 * Import Custom Format Modal
 * Allows importing via JSON paste or file upload
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

interface ImportModalProps {
	isOpen: boolean;
	onClose: () => void;
	onImport: (customFormat: any) => Promise<void>;
	instanceLabel: string;
}

export function ImportModal({
	isOpen,
	onClose,
	onImport,
	instanceLabel,
}: ImportModalProps) {
	const [jsonInput, setJsonInput] = useState("");
	const [isImporting, setIsImporting] = useState(false);

	const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		try {
			const content = await file.text();
			setJsonInput(content);
			toast.success("File loaded successfully");
		} catch (error) {
			toast.error("Failed to read file");
		}
	};

	const handleImport = async () => {
		if (!jsonInput.trim()) {
			toast.error("Please paste JSON or select a file");
			return;
		}

		try {
			setIsImporting(true);
			const customFormat = JSON.parse(jsonInput);

			// Validate that it has a name at minimum
			if (!customFormat.name) {
				toast.error("Invalid custom format: missing name field");
				return;
			}

			await onImport(customFormat);
			toast.success(`Custom format "${customFormat.name}" imported successfully`);
			setJsonInput("");
			onClose();
		} catch (error) {
			if (error instanceof SyntaxError) {
				toast.error("Invalid JSON format");
			} else {
				toast.error(
					error instanceof Error ? error.message : "Failed to import custom format",
				);
			}
		} finally {
			setIsImporting(false);
		}
	};

	const handleClose = () => {
		setJsonInput("");
		onClose();
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleClose}>
			<DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>Import Custom Format</DialogTitle>
					<DialogDescription>
						Import to {instanceLabel} by pasting JSON or uploading a file
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 overflow-hidden flex flex-col min-h-0 space-y-4">
					{/* File upload button */}
					<div className="flex gap-2">
						<label className="flex-1">
							<input
								type="file"
								accept=".json"
								onChange={handleFileSelect}
								className="hidden"
							/>
							<Button
								type="button"
								variant="secondary"
								className="w-full"
								onClick={(e) => {
									const input = e.currentTarget.previousElementSibling as HTMLInputElement;
									input?.click();
								}}
							>
								Select File
							</Button>
						</label>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setJsonInput("")}
							disabled={!jsonInput}
						>
							Clear
						</Button>
					</div>

					{/* JSON textarea */}
					<div className="flex-1 overflow-hidden flex flex-col min-h-0">
						<label className="text-sm font-medium text-fg mb-2">
							Custom Format JSON
						</label>
						<textarea
							value={jsonInput}
							onChange={(e) => setJsonInput(e.target.value)}
							placeholder='Paste custom format JSON here...\n\nExample:\n{\n  "name": "DV HDR10+",\n  "includeCustomFormatWhenRenaming": false,\n  "specifications": [...]\n}'
							className="flex-1 w-full rounded-lg border border-border bg-bg-subtle px-4 py-3 text-sm text-fg font-mono focus:ring-2 focus:ring-primary focus:ring-offset-2 resize-none"
							spellCheck={false}
						/>
						{jsonInput && (
							<div className="mt-2 text-xs text-fg-muted">
								{jsonInput.split("\n").length} lines
							</div>
						)}
					</div>
				</div>

				<DialogFooter className="flex gap-2">
					<Button variant="ghost" onClick={handleClose} disabled={isImporting}>
						Cancel
					</Button>
					<Button onClick={handleImport} disabled={isImporting || !jsonInput.trim()}>
						{isImporting ? "Importing..." : "Import"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
