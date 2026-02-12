"use client";

import { useState, useCallback, useEffect } from "react";
import type { TemplateQualityItem } from "@arr/shared";
import { Button, Input } from "../../../components/ui";
import { FolderPlus, X, Check, Layers } from "lucide-react";

interface QualityGroupModalProps {
	/** Whether the modal is open */
	isOpen: boolean;
	/** Close the modal */
	onClose: () => void;
	/** Save the group (name + selected quality IDs) */
	onSave: (name: string, selectedIds: Set<string>) => void;
	/** Available ungrouped qualities to select from */
	ungroupedQualities: TemplateQualityItem[];
	/** If editing, the group ID; null for new group */
	editingGroupId: string | null;
	/** Pre-fill name when editing */
	editingGroupName?: string;
	/** Pre-fill selection when editing */
	editingGroupQualityIds?: Set<string>;
}

export const QualityGroupModal = ({
	isOpen,
	onClose,
	onSave,
	ungroupedQualities,
	editingGroupId,
	editingGroupName = "",
	editingGroupQualityIds,
}: QualityGroupModalProps) => {
	const [groupModalSelection, setGroupModalSelection] = useState<Set<string>>(
		() => editingGroupQualityIds ?? new Set(),
	);
	const [groupModalName, setGroupModalName] = useState(editingGroupName);

	// Sync props → state when the modal opens (useState initializers only run on mount)
	useEffect(() => {
		if (isOpen) {
			setGroupModalName(editingGroupName);
			setGroupModalSelection(editingGroupQualityIds ?? new Set());
		}
	}, [isOpen, editingGroupName, editingGroupQualityIds]);

	const toggleModalSelection = useCallback((id: string) => {
		setGroupModalSelection((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(id)) {
				newSet.delete(id);
			} else {
				newSet.add(id);
			}
			return newSet;
		});
	}, []);

	const handleClose = () => {
		setGroupModalSelection(new Set());
		setGroupModalName("");
		onClose();
	};

	const handleSave = () => {
		if (groupModalSelection.size < 2 || !groupModalName.trim()) return;
		onSave(groupModalName.trim(), groupModalSelection);
		handleClose();
	};

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center bg-black/50"
			role="dialog"
			aria-modal="true"
			aria-labelledby="group-modal-title"
		>
			<div className="w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl mx-4">
				{/* Modal Header */}
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-2">
						<FolderPlus className="h-5 w-5 text-primary" />
						<h3
							id="group-modal-title"
							className="text-lg font-medium text-foreground"
						>
							{editingGroupId
								? "Edit Quality Group"
								: "Create Quality Group"}
						</h3>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={handleClose}
						aria-label="Close group editor"
						className="text-muted-foreground hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</Button>
				</div>

				{/* Instructions */}
				<p className="text-sm text-muted-foreground mb-4">
					Select 2 or more qualities to group together. Grouped
					qualities are treated as equivalent - Radarr/Sonarr
					won&apos;t upgrade between them.
				</p>

				{/* Group Name Input */}
				<div className="mb-4">
					<label className="block text-sm font-medium text-foreground mb-1">
						Group Name
					</label>
					<Input
						type="text"
						value={groupModalName}
						onChange={(e) => setGroupModalName(e.target.value)}
						placeholder="e.g., WEB 1080p, HD Streaming"
						className="w-full"
					/>
				</div>

				{/* Quality Selection */}
				<div className="mb-4">
					<label className="block text-sm font-medium text-foreground mb-2">
						Select Qualities ({groupModalSelection.size} selected)
					</label>
					<div className="max-h-64 overflow-y-auto rounded-lg border border-border">
						{ungroupedQualities.length === 0 ? (
							<p className="p-4 text-sm text-muted-foreground text-center">
								No ungrouped qualities available. Ungroup
								existing groups first.
							</p>
						) : (
							ungroupedQualities.map((quality) => {
								const isSelected =
									groupModalSelection.has(quality.id);
								return (
									<label
										key={quality.id}
										className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${
											isSelected
												? "bg-primary/10"
												: "hover:bg-card"
										} border-b border-border last:border-b-0`}
									>
										<input
											type="checkbox"
											checked={isSelected}
											onChange={() =>
												toggleModalSelection(quality.id)
											}
											className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
										/>
										<div className="flex-1">
											<span className="text-sm font-medium text-foreground">
												{quality.name}
											</span>
											{quality.resolution && (
												<span className="ml-2 text-xs text-muted-foreground">
													({quality.resolution}p)
												</span>
											)}
										</div>
										{isSelected && (
											<Check className="h-4 w-4 text-primary" />
										)}
									</label>
								);
							})
						)}
					</div>
				</div>

				{/* Preview */}
				{groupModalSelection.size >= 2 && groupModalName.trim() && (
					<div className="mb-4 p-3 rounded-lg bg-primary/5 border border-primary/20">
						<div className="text-xs font-medium text-primary mb-1">
							Preview:
						</div>
						<div className="flex items-center gap-2">
							<Layers className="h-4 w-4 text-primary" />
							<span className="text-sm font-medium text-foreground">
								{groupModalName}
							</span>
							<span className="text-xs text-muted-foreground">
								({groupModalSelection.size} qualities)
							</span>
						</div>
					</div>
				)}

				{/* Actions */}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={handleClose}>
						Cancel
					</Button>
					<Button
						variant="primary"
						onClick={handleSave}
						disabled={
							groupModalSelection.size < 2 ||
							!groupModalName.trim()
						}
					>
						{editingGroupId ? "Update Group" : "Create Group"}
					</Button>
				</div>
			</div>
		</div>
	);
};
