"use client";

import { useState, useCallback, useMemo } from "react";
import type {
	TemplateQualityEntry,
	TemplateQualityItem,
	TemplateQualityGroup,
	CustomQualityConfig,
} from "@arr/shared";
import { Button, Input } from "../../../components/ui";
import {
	GripVertical,
	Plus,
	Trash2,
	ChevronDown,
	ChevronRight,
	Check,
	Target,
	Layers,
	Ungroup,
	FolderPlus,
} from "lucide-react";

interface QualityGroupEditorProps {
	/** Current quality configuration */
	config: CustomQualityConfig;
	/** Called when configuration changes */
	onChange: (config: CustomQualityConfig) => void;
	/** Whether to show the "Use Custom Qualities" toggle */
	showToggle?: boolean;
}

// Generate unique IDs for quality items
const generateId = () => `q-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * QualityGroupEditor - Full quality group management for power users
 *
 * Supports:
 * - Enable/disable individual qualities and groups
 * - Create quality groups from multiple qualities
 * - Ungroup qualities back to individual items
 * - Reorder items (drag-and-drop or move up/down buttons)
 * - Set cutoff quality/group
 */
export const QualityGroupEditor = ({
	config,
	onChange,
	showToggle = true,
}: QualityGroupEditorProps) => {
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
	const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
	const [newGroupName, setNewGroupName] = useState("");
	const [showGroupDialog, setShowGroupDialog] = useState(false);
	const [draggedItemId, setDraggedItemId] = useState<string | null>(null);

	// Toggle expanded state for a group
	const toggleExpanded = (id: string) => {
		const newExpanded = new Set(expandedGroups);
		if (newExpanded.has(id)) {
			newExpanded.delete(id);
		} else {
			newExpanded.add(id);
		}
		setExpandedGroups(newExpanded);
	};

	// Toggle selection for grouping
	const toggleSelection = (id: string) => {
		const newSelected = new Set(selectedItems);
		if (newSelected.has(id)) {
			newSelected.delete(id);
		} else {
			newSelected.add(id);
		}
		setSelectedItems(newSelected);
	};

	// Toggle enabled state for an item
	const toggleEnabled = useCallback(
		(id: string) => {
			const newItems = config.items.map((entry) => {
				if (entry.type === "quality" && entry.item.id === id) {
					return {
						...entry,
						item: { ...entry.item, allowed: !entry.item.allowed },
					};
				}
				if (entry.type === "group" && entry.group.id === id) {
					return {
						...entry,
						group: { ...entry.group, allowed: !entry.group.allowed },
					};
				}
				return entry;
			});

			onChange({
				...config,
				items: newItems as TemplateQualityEntry[],
				customizedAt: new Date().toISOString(),
			});
		},
		[config, onChange]
	);

	// Set cutoff quality/group
	const setCutoff = useCallback(
		(id: string) => {
			onChange({
				...config,
				cutoffId: id,
				customizedAt: new Date().toISOString(),
			});
		},
		[config, onChange]
	);

	// Move item up in the list
	const moveUp = useCallback(
		(id: string) => {
			const index = config.items.findIndex(
				(e) => (e.type === "quality" ? e.item.id : e.group.id) === id
			);
			if (index <= 0) return;

			const newItems = [...config.items];
			const temp = newItems[index - 1]!;
			newItems[index - 1] = newItems[index]!;
			newItems[index] = temp;

			onChange({
				...config,
				items: newItems,
				customizedAt: new Date().toISOString(),
			});
		},
		[config, onChange]
	);

	// Move item down in the list
	const moveDown = useCallback(
		(id: string) => {
			const index = config.items.findIndex(
				(e) => (e.type === "quality" ? e.item.id : e.group.id) === id
			);
			if (index === -1 || index >= config.items.length - 1) return;

			const newItems = [...config.items];
			const temp = newItems[index]!;
			newItems[index] = newItems[index + 1]!;
			newItems[index + 1] = temp;

			onChange({
				...config,
				items: newItems,
				customizedAt: new Date().toISOString(),
			});
		},
		[config, onChange]
	);

	// Create a group from selected qualities
	const createGroup = useCallback(() => {
		if (selectedItems.size < 2 || !newGroupName.trim()) return;

		// Get selected qualities (only singles, not groups)
		const selectedQualities: TemplateQualityItem[] = [];
		const remainingItems: TemplateQualityEntry[] = [];

		for (const entry of config.items) {
			if (entry.type === "quality" && selectedItems.has(entry.item.id)) {
				selectedQualities.push(entry.item);
			} else if (entry.type === "group" && selectedItems.has(entry.group.id)) {
				// Can't add groups to groups - keep them
				remainingItems.push(entry);
			} else {
				remainingItems.push(entry);
			}
		}

		if (selectedQualities.length < 2) {
			return; // Need at least 2 qualities to make a group
		}

		// Create new group
		const newGroup: TemplateQualityGroup = {
			id: generateId(),
			name: newGroupName.trim(),
			allowed: selectedQualities.some((q) => q.allowed), // Enabled if any selected was enabled
			qualities: selectedQualities.map((q) => ({
				name: q.name,
				source: q.source,
				resolution: q.resolution,
			})),
		};

		// Insert group where first selected item was
		const firstSelectedIndex = config.items.findIndex(
			(e) => e.type === "quality" && selectedItems.has(e.item.id)
		);
		const insertIndex = firstSelectedIndex >= 0 ? firstSelectedIndex : remainingItems.length;

		// Build new items array
		const newItems: TemplateQualityEntry[] = [
			...remainingItems.slice(0, insertIndex),
			{ type: "group", group: newGroup },
			...remainingItems.slice(insertIndex),
		];

		onChange({
			...config,
			items: newItems,
			customizedAt: new Date().toISOString(),
		});

		// Reset state
		setSelectedItems(new Set());
		setNewGroupName("");
		setShowGroupDialog(false);
	}, [config, onChange, selectedItems, newGroupName]);

	// Ungroup a quality group back to individual qualities
	const ungroupQualities = useCallback(
		(groupId: string) => {
			const groupEntry = config.items.find(
				(e) => e.type === "group" && e.group.id === groupId
			);
			if (!groupEntry || groupEntry.type !== "group") return;

			const group = groupEntry.group;
			const groupIndex = config.items.indexOf(groupEntry);

			// Convert group qualities back to individual items
			const individualItems: TemplateQualityEntry[] = group.qualities.map((q) => ({
				type: "quality" as const,
				item: {
					id: generateId(),
					name: q.name,
					allowed: group.allowed, // Inherit group's allowed state
					source: q.source,
					resolution: q.resolution,
				},
			}));

			// Replace group with individual items
			const newItems = [
				...config.items.slice(0, groupIndex),
				...individualItems,
				...config.items.slice(groupIndex + 1),
			];

			// Update cutoff if it was this group
			let newCutoffId = config.cutoffId;
			if (config.cutoffId === groupId && individualItems.length > 0) {
				// Set cutoff to first item in the ungrouped list
				const firstItem = individualItems[0];
				if (firstItem && firstItem.type === "quality") {
					newCutoffId = firstItem.item.id;
				}
			}

			onChange({
				...config,
				items: newItems,
				cutoffId: newCutoffId,
				customizedAt: new Date().toISOString(),
			});
		},
		[config, onChange]
	);

	// Delete a quality or group
	const deleteItem = useCallback(
		(id: string) => {
			const newItems = config.items.filter(
				(e) => (e.type === "quality" ? e.item.id : e.group.id) !== id
			);

			// Update cutoff if deleted
			let newCutoffId = config.cutoffId;
			if (config.cutoffId === id) {
				newCutoffId = undefined;
			}

			onChange({
				...config,
				items: newItems,
				cutoffId: newCutoffId,
				customizedAt: new Date().toISOString(),
			});
		},
		[config, onChange]
	);

	// Handle drag start
	const handleDragStart = (id: string) => {
		setDraggedItemId(id);
	};

	// Handle drag over
	const handleDragOver = (e: React.DragEvent, targetId: string) => {
		e.preventDefault();
		if (!draggedItemId || draggedItemId === targetId) return;

		const draggedIndex = config.items.findIndex(
			(e) => (e.type === "quality" ? e.item.id : e.group.id) === draggedItemId
		);
		const targetIndex = config.items.findIndex(
			(e) => (e.type === "quality" ? e.item.id : e.group.id) === targetId
		);

		if (draggedIndex === -1 || targetIndex === -1) return;

		const newItems = [...config.items];
		const draggedItem = newItems.splice(draggedIndex, 1)[0];
		if (!draggedItem) return;
		newItems.splice(targetIndex, 0, draggedItem);

		onChange({
			...config,
			items: newItems,
		});
	};

	// Handle drag end
	const handleDragEnd = () => {
		if (draggedItemId) {
			onChange({
				...config,
				customizedAt: new Date().toISOString(),
			});
		}
		setDraggedItemId(null);
	};

	// Count selected single qualities (for group creation)
	const selectedSingleCount = useMemo(() => {
		let count = 0;
		for (const entry of config.items) {
			if (entry.type === "quality" && selectedItems.has(entry.item.id)) {
				count++;
			}
		}
		return count;
	}, [config.items, selectedItems]);

	// Render a single quality item
	const renderQualityItem = (item: TemplateQualityItem, index: number) => {
		const isSelected = selectedItems.has(item.id);
		const isCutoff = config.cutoffId === item.id;
		const isDragging = draggedItemId === item.id;

		return (
			<div
				key={item.id}
				draggable
				onDragStart={() => handleDragStart(item.id)}
				onDragOver={(e) => handleDragOver(e, item.id)}
				onDragEnd={handleDragEnd}
				className={`flex items-center gap-2 rounded-lg border p-3 transition-all ${
					isDragging
						? "border-primary bg-primary/10 opacity-50"
						: isSelected
						? "border-blue-500 bg-blue-500/10"
						: "border-border bg-bg-subtle/50 hover:border-border/80"
				}`}
			>
				{/* Drag handle */}
				<div className="cursor-grab text-fg-muted hover:text-fg">
					<GripVertical className="h-4 w-4" />
				</div>

				{/* Selection checkbox */}
				<input
					type="checkbox"
					checked={isSelected}
					onChange={() => toggleSelection(item.id)}
					className="h-4 w-4 rounded border-border bg-bg-subtle text-blue-500 focus:ring-blue-500"
					title="Select for grouping"
				/>

				{/* Enable/disable checkbox */}
				<input
					type="checkbox"
					checked={item.allowed}
					onChange={() => toggleEnabled(item.id)}
					className="h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-primary"
					title={item.allowed ? "Enabled - click to disable" : "Disabled - click to enable"}
				/>

				{/* Quality name */}
				<div className="flex-1">
					<span className={`text-sm font-medium ${item.allowed ? "text-fg" : "text-fg-muted line-through"}`}>
						{item.name}
					</span>
					{item.resolution && (
						<span className="ml-2 text-xs text-fg-muted">({item.resolution}p)</span>
					)}
				</div>

				{/* Cutoff indicator/button */}
				<Button
					variant={isCutoff ? "primary" : "ghost"}
					size="sm"
					onClick={() => setCutoff(item.id)}
					title={isCutoff ? "Current cutoff" : "Set as cutoff"}
					className="gap-1"
				>
					<Target className="h-3 w-3" />
					{isCutoff && <span className="text-xs">Cutoff</span>}
				</Button>

				{/* Move buttons */}
				<div className="flex gap-1">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => moveUp(item.id)}
						disabled={index === 0}
						title="Move up (higher priority)"
					>
						<ChevronRight className="h-3 w-3 -rotate-90" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => moveDown(item.id)}
						disabled={index === config.items.length - 1}
						title="Move down (lower priority)"
					>
						<ChevronRight className="h-3 w-3 rotate-90" />
					</Button>
				</div>

				{/* Delete button */}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => deleteItem(item.id)}
					className="text-fg-muted hover:text-danger"
					title="Remove quality"
				>
					<Trash2 className="h-3 w-3" />
				</Button>
			</div>
		);
	};

	// Render a quality group
	const renderQualityGroup = (group: TemplateQualityGroup, index: number) => {
		const isExpanded = expandedGroups.has(group.id);
		const isSelected = selectedItems.has(group.id);
		const isCutoff = config.cutoffId === group.id;
		const isDragging = draggedItemId === group.id;

		return (
			<div
				key={group.id}
				draggable
				onDragStart={() => handleDragStart(group.id)}
				onDragOver={(e) => handleDragOver(e, group.id)}
				onDragEnd={handleDragEnd}
				className={`rounded-lg border transition-all ${
					isDragging
						? "border-primary bg-primary/10 opacity-50"
						: isSelected
						? "border-blue-500 bg-blue-500/10"
						: "border-border bg-bg-subtle/50"
				}`}
			>
				{/* Group header */}
				<div className="flex items-center gap-2 p-3">
					{/* Drag handle */}
					<div className="cursor-grab text-fg-muted hover:text-fg">
						<GripVertical className="h-4 w-4" />
					</div>

					{/* Expand/collapse */}
					<button
						type="button"
						onClick={() => toggleExpanded(group.id)}
						className="text-fg-muted hover:text-fg"
					>
						{isExpanded ? (
							<ChevronDown className="h-4 w-4" />
						) : (
							<ChevronRight className="h-4 w-4" />
						)}
					</button>

					{/* Enable/disable checkbox */}
					<input
						type="checkbox"
						checked={group.allowed}
						onChange={() => toggleEnabled(group.id)}
						className="h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-primary"
						title={group.allowed ? "Enabled - click to disable" : "Disabled - click to enable"}
					/>

					{/* Group icon and name */}
					<Layers className="h-4 w-4 text-primary" />
					<div className="flex-1">
						<span className={`text-sm font-medium ${group.allowed ? "text-fg" : "text-fg-muted line-through"}`}>
							{group.name}
						</span>
						<span className="ml-2 text-xs text-fg-muted">
							({group.qualities.length} qualities)
						</span>
					</div>

					{/* Cutoff indicator/button */}
					<Button
						variant={isCutoff ? "primary" : "ghost"}
						size="sm"
						onClick={() => setCutoff(group.id)}
						title={isCutoff ? "Current cutoff" : "Set as cutoff"}
						className="gap-1"
					>
						<Target className="h-3 w-3" />
						{isCutoff && <span className="text-xs">Cutoff</span>}
					</Button>

					{/* Move buttons */}
					<div className="flex gap-1">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => moveUp(group.id)}
							disabled={index === 0}
							title="Move up (higher priority)"
						>
							<ChevronRight className="h-3 w-3 -rotate-90" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => moveDown(group.id)}
							disabled={index === config.items.length - 1}
							title="Move down (lower priority)"
						>
							<ChevronRight className="h-3 w-3 rotate-90" />
						</Button>
					</div>

					{/* Ungroup button */}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => ungroupQualities(group.id)}
						className="text-fg-muted hover:text-fg"
						title="Ungroup qualities"
					>
						<Ungroup className="h-3 w-3" />
					</Button>

					{/* Delete button */}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => deleteItem(group.id)}
						className="text-fg-muted hover:text-danger"
						title="Remove group"
					>
						<Trash2 className="h-3 w-3" />
					</Button>
				</div>

				{/* Group contents (when expanded) */}
				{isExpanded && (
					<div className="border-t border-border bg-bg-subtle/30 px-3 py-2">
						<div className="space-y-1 pl-8">
							{group.qualities.map((quality, qIndex) => (
								<div
									key={`${group.id}-${quality.name}-${qIndex}`}
									className="flex items-center gap-2 text-sm text-fg-muted"
								>
									<Check className="h-3 w-3 text-green-500" />
									<span>{quality.name}</span>
									{quality.resolution && (
										<span className="text-xs">({quality.resolution}p)</span>
									)}
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="space-y-4">
			{/* Toggle for using custom qualities */}
			{showToggle && (
				<div className="flex items-center gap-3 rounded-lg border border-border bg-bg-subtle/50 p-4">
					<input
						type="checkbox"
						id="useCustomQualities"
						checked={config.useCustomQualities}
						onChange={(e) =>
							onChange({
								...config,
								useCustomQualities: e.target.checked,
								customizedAt: new Date().toISOString(),
							})
						}
						className="h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-primary"
					/>
					<label htmlFor="useCustomQualities" className="flex-1 cursor-pointer">
						<div className="text-sm font-medium text-fg">Customize Quality Configuration</div>
						<div className="text-xs text-fg-muted">
							Override the default quality settings from TRaSH Guides or your instance
						</div>
					</label>
				</div>
			)}

			{/* Quality editor (only shown when custom qualities enabled) */}
			{config.useCustomQualities && (
				<>
					{/* Toolbar */}
					<div className="flex items-center justify-between">
						<div className="text-sm text-fg-muted">
							{config.items.length} item{config.items.length !== 1 ? "s" : ""} |{" "}
							{selectedItems.size} selected
						</div>
						<div className="flex gap-2">
							{/* Create group button */}
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setShowGroupDialog(true)}
								disabled={selectedSingleCount < 2}
								className="gap-1"
								title="Create group from selected qualities"
							>
								<FolderPlus className="h-4 w-4" />
								Create Group
							</Button>
							{/* Clear selection */}
							{selectedItems.size > 0 && (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setSelectedItems(new Set())}
								>
									Clear Selection
								</Button>
							)}
						</div>
					</div>

					{/* Group creation dialog */}
					{showGroupDialog && (
						<div className="rounded-lg border border-primary bg-primary/5 p-4 space-y-3">
							<div className="text-sm font-medium text-fg">Create Quality Group</div>
							<Input
								type="text"
								value={newGroupName}
								onChange={(e) => setNewGroupName(e.target.value)}
								placeholder="Group name (e.g., 'WEB 1080p')"
								className="w-full"
							/>
							<div className="flex gap-2">
								<Button
									variant="primary"
									size="sm"
									onClick={createGroup}
									disabled={!newGroupName.trim() || selectedSingleCount < 2}
								>
									Create Group
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setShowGroupDialog(false);
										setNewGroupName("");
									}}
								>
									Cancel
								</Button>
							</div>
							<div className="text-xs text-fg-muted">
								{selectedSingleCount} qualities selected for grouping
							</div>
						</div>
					)}

					{/* Quality items list */}
					<div className="space-y-2">
						{config.items.length === 0 ? (
							<div className="rounded-lg border border-dashed border-border p-8 text-center">
								<Layers className="mx-auto h-8 w-8 text-fg-muted" />
								<p className="mt-2 text-sm text-fg-muted">
									No quality items configured. Add qualities from the profile settings.
								</p>
							</div>
						) : (
							<>
								<div className="text-xs text-fg-muted mb-2">
									Drag items to reorder. Items at the bottom have higher priority.
								</div>
								{config.items.map((entry, index) =>
									entry.type === "quality"
										? renderQualityItem(entry.item, index)
										: renderQualityGroup(entry.group, index)
								)}
							</>
						)}
					</div>

					{/* Legend */}
					<div className="flex flex-wrap gap-4 text-xs text-fg-muted pt-2 border-t border-border">
						<div className="flex items-center gap-1">
							<Target className="h-3 w-3 text-primary" />
							<span>Cutoff - upgrades stop here</span>
						</div>
						<div className="flex items-center gap-1">
							<Layers className="h-3 w-3 text-primary" />
							<span>Group - qualities treated as equivalent</span>
						</div>
						<div className="flex items-center gap-1">
							<GripVertical className="h-3 w-3" />
							<span>Drag to reorder</span>
						</div>
					</div>
				</>
			)}
		</div>
	);
};
