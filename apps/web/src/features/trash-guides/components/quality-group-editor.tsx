"use client";

import { useState, useCallback, useMemo } from "react";
import type {
	TemplateQualityEntry,
	TemplateQualityItem,
	TemplateQualityGroup,
	CustomQualityConfig,
} from "@arr/shared";
import { Button } from "../../../components/ui";
import {
	GripVertical,
	Trash2,
	ChevronDown,
	ChevronRight,
	Check,
	Target,
	Layers,
	Ungroup,
	FolderPlus,
	HelpCircle,
	ArrowUp,
	Info,
	Edit3,
} from "lucide-react";
import { QualityGroupModal } from "./quality-group-modal";

interface QualityGroupEditorProps {
	/** Current quality configuration */
	config: CustomQualityConfig;
	/** Called when configuration changes */
	onChange: (config: CustomQualityConfig) => void;
	/** Whether to show the "Use Custom Qualities" toggle */
	showToggle?: boolean;
	/** Service type to filter instances (RADARR or SONARR) */
	serviceType?: "RADARR" | "SONARR";
}

// Generate unique IDs for quality items
const generateId = () => `q-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * QualityGroupEditor - Full quality group management for power users
 *
 * Supports:
 * - Enable/disable individual qualities and groups
 * - Create quality groups from multiple qualities via modal
 * - Edit existing groups
 * - Ungroup qualities back to individual items
 * - Reorder items (drag-and-drop or move up/down buttons)
 * - Set cutoff quality/group
 */
export const QualityGroupEditor = ({
	config,
	onChange,
	showToggle: _showToggle = true,
	serviceType: _serviceType,
}: QualityGroupEditorProps) => {
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
	const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
	const [showHelp, setShowHelp] = useState(false);

	// Group creation modal state
	const [showGroupModal, setShowGroupModal] = useState(false);
	const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
	const [editingGroupName, setEditingGroupName] = useState("");
	const [editingGroupQualityIds, setEditingGroupQualityIds] = useState<Set<string>>(new Set());

	// Get display items in REVERSE order (highest priority at TOP for intuitive display)
	const displayItems = useMemo(() => {
		return [...config.items].reverse();
	}, [config.items]);

	// Get all ungrouped qualities for the group creation modal
	const ungroupedQualities = useMemo(() => {
		return config.items
			.filter((e): e is { type: "quality"; item: TemplateQualityItem } => e.type === "quality")
			.map((e) => e.item);
	}, [config.items]);

	// Get priority number for an item (1 = highest priority)
	const getPriority = useCallback((id: string) => {
		const index = config.items.findIndex(
			(e) => (e.type === "quality" ? e.item.id : e.group.id) === id
		);
		// Higher index = higher priority, so invert for display
		return config.items.length - index;
	}, [config.items]);

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

	// Move item up in priority (which means moving DOWN in the internal array)
	const moveUpPriority = useCallback(
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

	// Move item down in priority (which means moving UP in the internal array)
	const moveDownPriority = useCallback(
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

	// Open group creation modal
	const openGroupModal = useCallback(() => {
		setEditingGroupId(null);
		setEditingGroupName("");
		setEditingGroupQualityIds(new Set());
		setShowGroupModal(true);
	}, []);

	// Open group edit modal
	const openEditGroupModal = useCallback((groupId: string) => {
		const groupEntry = config.items.find(
			(e) => e.type === "group" && e.group.id === groupId
		);
		if (!groupEntry || groupEntry.type !== "group") return;

		const group = groupEntry.group;
		// Pre-select the qualities that are in this group (by name matching)
		const selectedIds = new Set<string>();
		for (const q of ungroupedQualities) {
			if (group.qualities.some((gq) => gq.name === q.name)) {
				selectedIds.add(q.id);
			}
		}

		setEditingGroupId(groupId);
		setEditingGroupName(group.name);
		setEditingGroupQualityIds(selectedIds);
		setShowGroupModal(true);
	}, [config.items, ungroupedQualities]);

	// Create/update group from modal save
	const handleGroupSave = useCallback((name: string, selectedIds: Set<string>) => {
		if (selectedIds.size < 2 || !name) return;

		// Get selected qualities
		const selectedQualities: TemplateQualityItem[] = [];
		const remainingItems: TemplateQualityEntry[] = [];

		for (const entry of config.items) {
			if (entry.type === "quality" && selectedIds.has(entry.item.id)) {
				selectedQualities.push(entry.item);
			} else if (entry.type === "group" && entry.group.id === editingGroupId) {
				// Skip the group being edited (we'll replace it)
				continue;
			} else {
				remainingItems.push(entry);
			}
		}

		if (selectedQualities.length < 2) {
			return;
		}

		// Create new group
		const newGroup: TemplateQualityGroup = {
			id: editingGroupId || generateId(),
			name,
			allowed: selectedQualities.some((q) => q.allowed),
			qualities: selectedQualities.map((q) => ({
				name: q.name,
				source: q.source,
				resolution: q.resolution,
			})),
		};

		// Find position: if editing, use old position; otherwise use first selected item's position
		let insertIndex: number;
		if (editingGroupId) {
			const oldIndex = config.items.findIndex(
				(e) => e.type === "group" && e.group.id === editingGroupId
			);
			insertIndex = oldIndex >= 0 ? oldIndex : remainingItems.length;
		} else {
			const firstSelectedIndex = config.items.findIndex(
				(e) => e.type === "quality" && selectedIds.has(e.item.id)
			);
			insertIndex = firstSelectedIndex >= 0 ? firstSelectedIndex : remainingItems.length;
		}

		// Adjust insertIndex for remaining items
		let adjustedIndex = 0;
		for (let i = 0; i < insertIndex && adjustedIndex < remainingItems.length; i++) {
			const original = config.items[i];
			if (original) {
				const inRemaining = remainingItems.some((r) => {
					if (r.type === "quality" && original.type === "quality") {
						return r.item.id === original.item.id;
					}
					if (r.type === "group" && original.type === "group") {
						return r.group.id === original.group.id;
					}
					return false;
				});
				if (inRemaining) adjustedIndex++;
			}
		}

		// Build new items array
		const newItems: TemplateQualityEntry[] = [
			...remainingItems.slice(0, adjustedIndex),
			{ type: "group", group: newGroup },
			...remainingItems.slice(adjustedIndex),
		];

		// Update cutoff if needed
		let newCutoffId = config.cutoffId;
		if (editingGroupId && config.cutoffId === editingGroupId) {
			newCutoffId = newGroup.id;
		}

		onChange({
			...config,
			items: newItems,
			cutoffId: newCutoffId,
			customizedAt: new Date().toISOString(),
		});

		// Close modal
		setShowGroupModal(false);
		setEditingGroupId(null);
	}, [config, onChange, editingGroupId]);

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
					allowed: group.allowed,
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

	// Get cutoff item name for display
	const cutoffName = useMemo(() => {
		if (!config.cutoffId) return null;
		const item = config.items.find(
			(e) => (e.type === "quality" ? e.item.id : e.group.id) === config.cutoffId
		);
		if (!item) return null;
		return item.type === "quality" ? item.item.name : item.group.name;
	}, [config.cutoffId, config.items]);

	// Render a single quality item
	const renderQualityItem = (item: TemplateQualityItem, displayIndex: number) => {
		const isCutoff = config.cutoffId === item.id;
		const isDragging = draggedItemId === item.id;
		const priority = getPriority(item.id);
		const isFirst = displayIndex === 0;
		const isLast = displayIndex === displayItems.length - 1;

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
						: isCutoff
						? "border-primary bg-primary/5 ring-1 ring-primary/30"
						: "border-border bg-card/50 hover:border-border/80"
				}`}
			>
				{/* Priority number */}
				<div className="w-6 text-center text-xs font-medium text-muted-foreground">
					#{priority}
				</div>

				{/* Drag handle */}
				<div className="cursor-grab text-muted-foreground hover:text-foreground">
					<GripVertical className="h-4 w-4" />
				</div>

				{/* Enable/disable checkbox */}
				<input
					type="checkbox"
					checked={item.allowed}
					onChange={() => toggleEnabled(item.id)}
					className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
					title={item.allowed ? "Enabled - click to disable" : "Disabled - click to enable"}
				/>

				{/* Quality name */}
				<div className="flex-1">
					<span className={`text-sm font-medium ${item.allowed ? "text-foreground" : "text-muted-foreground line-through"}`}>
						{item.name}
					</span>
					{item.resolution && (
						<span className="ml-2 text-xs text-muted-foreground">({item.resolution}p)</span>
					)}
				</div>

				{/* Cutoff indicator */}
				{isCutoff && (
					<span className="flex items-center gap-1 rounded bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
						<Target className="h-3 w-3" />
						Cutoff
					</span>
				)}

				{/* Set as cutoff button (when not cutoff) */}
				{!isCutoff && item.allowed && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setCutoff(item.id)}
						title="Set as cutoff (upgrades stop here)"
						className="text-muted-foreground hover:text-primary"
					>
						<Target className="h-3 w-3" />
					</Button>
				)}

				{/* Move buttons */}
				<div className="flex gap-0.5">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => moveUpPriority(item.id)}
						disabled={isFirst}
						title="Increase priority"
						className="px-1"
					>
						<ArrowUp className="h-3 w-3" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => moveDownPriority(item.id)}
						disabled={isLast}
						title="Decrease priority"
						className="px-1"
					>
						<ArrowUp className="h-3 w-3 rotate-180" />
					</Button>
				</div>

				{/* Delete button */}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => deleteItem(item.id)}
					className="text-muted-foreground hover:text-danger px-1"
					title="Remove quality"
				>
					<Trash2 className="h-3 w-3" />
				</Button>
			</div>
		);
	};

	// Render a quality group
	const renderQualityGroup = (group: TemplateQualityGroup, displayIndex: number) => {
		const isExpanded = expandedGroups.has(group.id);
		const isCutoff = config.cutoffId === group.id;
		const isDragging = draggedItemId === group.id;
		const priority = getPriority(group.id);
		const isFirst = displayIndex === 0;
		const isLast = displayIndex === displayItems.length - 1;

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
						: isCutoff
						? "border-primary bg-primary/5 ring-1 ring-primary/30"
						: "border-border bg-card/50"
				}`}
			>
				{/* Group header */}
				<div className="flex items-center gap-2 p-3">
					{/* Priority number */}
					<div className="w-6 text-center text-xs font-medium text-muted-foreground">
						#{priority}
					</div>

					{/* Drag handle */}
					<div className="cursor-grab text-muted-foreground hover:text-foreground">
						<GripVertical className="h-4 w-4" />
					</div>

					{/* Expand/collapse */}
					<button
						type="button"
						onClick={() => toggleExpanded(group.id)}
						aria-expanded={isExpanded}
						aria-label={isExpanded ? "Collapse group" : "Expand group"}
						className="text-muted-foreground hover:text-foreground"
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
						className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
						title={group.allowed ? "Enabled - click to disable" : "Disabled - click to enable"}
					/>

					{/* Group icon and name */}
					<Layers className="h-4 w-4 text-primary" />
					<div className="flex-1">
						<span className={`text-sm font-medium ${group.allowed ? "text-foreground" : "text-muted-foreground line-through"}`}>
							{group.name}
						</span>
						<span className="ml-2 text-xs text-muted-foreground">
							({group.qualities.length} qualities)
						</span>
					</div>

					{/* Cutoff indicator */}
					{isCutoff && (
						<span className="flex items-center gap-1 rounded bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
							<Target className="h-3 w-3" />
							Cutoff
						</span>
					)}

					{/* Set as cutoff button (when not cutoff) */}
					{!isCutoff && group.allowed && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setCutoff(group.id)}
							title="Set as cutoff (upgrades stop here)"
							className="text-muted-foreground hover:text-primary"
						>
							<Target className="h-3 w-3" />
						</Button>
					)}

					{/* Move buttons */}
					<div className="flex gap-0.5">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => moveUpPriority(group.id)}
							disabled={isFirst}
							title="Increase priority"
							className="px-1"
						>
							<ArrowUp className="h-3 w-3" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => moveDownPriority(group.id)}
							disabled={isLast}
							title="Decrease priority"
							className="px-1"
						>
							<ArrowUp className="h-3 w-3 rotate-180" />
						</Button>
					</div>

					{/* Edit group button */}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => openEditGroupModal(group.id)}
						className="text-muted-foreground hover:text-primary px-1"
						title="Edit group"
					>
						<Edit3 className="h-3 w-3" />
					</Button>

					{/* Ungroup button */}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => ungroupQualities(group.id)}
						className="text-muted-foreground hover:text-foreground px-1"
						title="Ungroup qualities"
					>
						<Ungroup className="h-3 w-3" />
					</Button>

					{/* Delete button */}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => deleteItem(group.id)}
						className="text-muted-foreground hover:text-danger px-1"
						title="Remove group"
					>
						<Trash2 className="h-3 w-3" />
					</Button>
				</div>

				{/* Group contents (when expanded) */}
				{isExpanded && (
					<div className="border-t border-border bg-card/30 px-3 py-2">
						<div className="space-y-1 pl-8">
							{group.qualities.map((quality, qIndex) => (
								<div
									key={`${group.id}-${quality.name}-${qIndex}`}
									className="flex items-center gap-2 text-sm text-muted-foreground"
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
			{/* Header with Help Toggle */}
			<div className="flex items-center justify-between">
				<div className="text-sm font-medium text-foreground">Quality Priority Configuration</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setShowHelp(!showHelp)}
					className="gap-1 text-muted-foreground"
				>
					<HelpCircle className="h-4 w-4" />
					{showHelp ? "Hide Help" : "Help"}
				</Button>
			</div>

			{/* Help Section */}
			{showHelp && (
				<div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 space-y-3">
					<div className="flex items-start gap-2">
						<Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
						<div className="space-y-2 text-sm text-muted-foreground">
							<p><strong className="text-foreground">Priority Order:</strong> Items at the top have higher priority. Radarr/Sonarr will prefer higher priority qualities when downloading.</p>
							<p><strong className="text-foreground">Cutoff:</strong> The quality level where upgrades stop. Once you have a file at cutoff quality or higher, no more upgrades will be searched.</p>
							<p><strong className="text-foreground">Groups:</strong> Qualities in the same group are treated as equivalent. Use groups for qualities you consider interchangeable (e.g., &quot;WEB-DL 1080p&quot; and &quot;WEBRip 1080p&quot;). Click &quot;Create Group&quot; to make one.</p>
							<p><strong className="text-foreground">Scope:</strong> This configuration is saved with the template and applied to all instances that use this template.</p>
						</div>
					</div>
				</div>
			)}

			{/* Empty state message */}
			{config.items.length === 0 && (
				<div className="rounded-lg border border-dashed border-border p-6 text-center">
					<Layers className="mx-auto h-8 w-8 text-muted-foreground" />
					<p className="mt-2 text-sm font-medium text-foreground">No Quality Configuration</p>
					<p className="text-xs text-muted-foreground">
						Quality settings will be added when you select a TRaSH Guides profile
					</p>
				</div>
			)}

			{/* Quality Editor - When items exist */}
			{config.items.length > 0 && (
				<>
					{/* Cutoff Display */}
					<div className="flex items-center justify-between rounded-lg border border-border bg-card/50 p-3">
						<div className="flex items-center gap-2">
							<Target className="h-4 w-4 text-primary" />
							<span className="text-sm font-medium text-foreground">Cutoff:</span>
							{cutoffName ? (
								<span className="text-sm text-primary">{cutoffName}</span>
							) : (
								<span className="text-sm text-muted-foreground italic">Not set - click target icon on any quality</span>
							)}
						</div>
						<div className="text-xs text-muted-foreground">
							Upgrades stop at this quality
						</div>
					</div>

					{/* Toolbar */}
					<div className="flex items-center justify-between flex-wrap gap-2 border-b border-border pb-3">
						<div className="text-sm text-muted-foreground">
							{config.items.length} item{config.items.length !== 1 ? "s" : ""}
						</div>
						<div className="flex flex-wrap gap-2">
							{/* Create group button */}
							<Button
								variant="primary"
								size="sm"
								onClick={openGroupModal}
								disabled={ungroupedQualities.length < 2}
								className="gap-1"
								title={ungroupedQualities.length < 2 ? "Need at least 2 ungrouped qualities" : "Create a quality group"}
							>
								<FolderPlus className="h-4 w-4" />
								Create Group
							</Button>
						</div>
					</div>

					{/* Priority label */}
					<div className="flex items-center justify-between text-xs text-muted-foreground px-1">
						<span className="flex items-center gap-1">
							<ArrowUp className="h-3 w-3" />
							Higher Priority
						</span>
						<span>Lower Priority</span>
					</div>

					{/* Quality items list - displayed in reverse order (highest priority at top) */}
					<div className="space-y-2">
						{displayItems.map((entry, index) =>
							entry.type === "quality"
								? renderQualityItem(entry.item, index)
								: renderQualityGroup(entry.group, index)
						)}
					</div>

					{/* Legend */}
					<div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-2 border-t border-border">
						<div className="flex items-center gap-1">
							<div className="w-4 h-4 rounded border border-primary bg-primary/10" />
							<span>Cutoff quality</span>
						</div>
						<div className="flex items-center gap-1">
							<Layers className="h-3 w-3 text-primary" />
							<span>Quality group</span>
						</div>
						<div className="flex items-center gap-1">
							<GripVertical className="h-3 w-3" />
							<span>Drag to reorder</span>
						</div>
					</div>
				</>
			)}

			{/* Group Creation/Edit Modal */}
			<QualityGroupModal
				isOpen={showGroupModal}
				onClose={() => {
					setShowGroupModal(false);
					setEditingGroupId(null);
				}}
				onSave={handleGroupSave}
				ungroupedQualities={ungroupedQualities}
				editingGroupId={editingGroupId}
				editingGroupName={editingGroupName}
				editingGroupQualityIds={editingGroupQualityIds}
			/>
		</div>
	);
};
