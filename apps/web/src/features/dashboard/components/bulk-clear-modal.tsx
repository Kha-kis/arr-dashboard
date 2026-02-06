"use client";

/**
 * Bulk Clear Modal
 *
 * Modal for clearing multiple problematic queue items at once.
 * Shows detailed information for each item including the specific reason
 * it's problematic. Allows individual selection and per-item action configuration.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import {
	AlertTriangle,
	Trash2,
	Ban,
	Search,
	RefreshCw,
	ChevronDown,
	Check,
	Loader2,
	Filter,
	X,
	ChevronRight,
	Info,
} from "lucide-react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";
import type { QueueItem } from "@arr/shared";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import {
	analyzeQueueItem,
	collectStatusLines,
	type ProblematicIssueType,
	type ProblematicAnalysis,
	ISSUE_TYPE_LABELS,
} from "../lib/queue-utils";

/**
 * Actions available for bulk clear
 */
export type BulkClearAction =
	| "skip"           // Don't process this item
	| "remove"         // Remove from queue, keep in client
	| "remove_delete"  // Remove from queue and delete from client
	| "blocklist"      // Blocklist release
	| "blocklist_delete" // Blocklist and delete from client
	| "blocklist_search" // Blocklist, delete, and search again
	| "retry";         // Retry download

const ACTION_OPTIONS: { value: BulkClearAction; label: string; icon: typeof Trash2; description: string; shortLabel: string }[] = [
	{
		value: "skip",
		label: "Skip",
		shortLabel: "Skip",
		icon: RefreshCw,
		description: "Don't process this item",
	},
	{
		value: "remove",
		label: "Remove (keep download)",
		shortLabel: "Remove",
		icon: Trash2,
		description: "Remove from queue but keep in download client",
	},
	{
		value: "remove_delete",
		label: "Remove & delete",
		shortLabel: "Remove+Del",
		icon: Trash2,
		description: "Remove from queue and delete the download",
	},
	{
		value: "blocklist",
		label: "Blocklist",
		shortLabel: "Blocklist",
		icon: Ban,
		description: "Blocklist release and remove from queue",
	},
	{
		value: "blocklist_delete",
		label: "Blocklist & delete",
		shortLabel: "Block+Del",
		icon: Ban,
		description: "Blocklist release and delete download",
	},
	{
		value: "blocklist_search",
		label: "Blocklist, delete & search",
		shortLabel: "Block+Search",
		icon: Search,
		description: "Blocklist, delete, then search for alternative",
	},
	{
		value: "retry",
		label: "Retry",
		shortLabel: "Retry",
		icon: RefreshCw,
		description: "Retry the download",
	},
];

/**
 * Convert BulkClearAction to QueueActionOptions
 */
const actionToOptions = (action: BulkClearAction): QueueActionOptions | null => {
	switch (action) {
		case "skip":
			return null;
		case "remove":
			return { removeFromClient: false, blocklist: false, search: false };
		case "remove_delete":
			return { removeFromClient: true, blocklist: false, search: false };
		case "blocklist":
			return { removeFromClient: false, blocklist: true, search: false };
		case "blocklist_delete":
			return { removeFromClient: true, blocklist: true, search: false };
		case "blocklist_search":
			return { removeFromClient: true, blocklist: true, search: true };
		case "retry":
			return null; // Special case - handled separately
		default:
			return null;
	}
};

/**
 * Processed item with analysis and extracted reason
 */
interface ProcessedItem {
	item: QueueItem;
	analysis: ProblematicAnalysis;
	reason: string;
	title: string;
	protocol: "torrent" | "usenet" | "unknown";
	itemKey: string;
}

interface ActionSelectProps {
	value: BulkClearAction;
	onChange: (value: BulkClearAction) => void;
	disabled?: boolean;
	compact?: boolean;
}

const ActionSelect = ({ value, onChange, disabled, compact }: ActionSelectProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const selectedOption = ACTION_OPTIONS.find(opt => opt.value === value);

	return (
		<SelectPrimitive.Root value={value} onValueChange={(v) => onChange(v as BulkClearAction)} disabled={disabled}>
			<SelectPrimitive.Trigger
				className={cn(
					"flex items-center justify-between gap-1 rounded-md border text-xs",
					"bg-card/60 backdrop-blur-xs text-foreground",
					"border-border/50 hover:border-border transition-colors",
					"focus:outline-hidden focus:ring-1 focus:ring-offset-0",
					"disabled:cursor-not-allowed disabled:opacity-50",
					compact ? "h-7 px-2 min-w-[90px]" : "h-8 px-2.5 min-w-[120px]"
				)}
			>
				<span className="flex items-center gap-1.5 truncate">
					{selectedOption && <selectedOption.icon className="h-3 w-3 shrink-0" />}
					<SelectPrimitive.Value>
						{compact ? selectedOption?.shortLabel : selectedOption?.label}
					</SelectPrimitive.Value>
				</span>
				<SelectPrimitive.Icon asChild>
					<ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
				</SelectPrimitive.Icon>
			</SelectPrimitive.Trigger>

			<SelectPrimitive.Portal>
				<SelectPrimitive.Content
					className={cn(
						"relative z-modal max-h-[300px] min-w-[200px] overflow-hidden",
						"rounded-lg border border-border/50 bg-card/95 backdrop-blur-xl",
						"shadow-xl shadow-black/20",
						"data-[state=open]:animate-in data-[state=closed]:animate-out",
						"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
						"data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
					)}
					position="popper"
					sideOffset={4}
				>
					<SelectPrimitive.Viewport className="p-1">
						{ACTION_OPTIONS.map((option) => (
							<SelectPrimitive.Item
								key={option.value}
								value={option.value}
								className={cn(
									"relative flex w-full cursor-pointer select-none items-center rounded-md py-1.5 pl-7 pr-2 text-xs outline-hidden",
									"text-foreground/80 hover:bg-muted/50 focus:bg-muted/50",
									"data-disabled:pointer-events-none data-disabled:opacity-50"
								)}
							>
								<span className="absolute left-1.5 flex h-4 w-4 items-center justify-center">
									<SelectPrimitive.ItemIndicator>
										<Check className="h-3 w-3" style={{ color: themeGradient.from }} />
									</SelectPrimitive.ItemIndicator>
								</span>
								<div className="flex flex-col gap-0">
									<span className="flex items-center gap-1.5">
										<option.icon className="h-3 w-3" />
										<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
									</span>
									<span className="text-[10px] text-muted-foreground ml-4">{option.description}</span>
								</div>
							</SelectPrimitive.Item>
						))}
					</SelectPrimitive.Viewport>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
};

/**
 * Checkbox component
 */
const ItemCheckbox = ({
	checked,
	onCheckedChange,
	disabled,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<CheckboxPrimitive.Root
			checked={checked}
			onCheckedChange={onCheckedChange}
			disabled={disabled}
			className={cn(
				"flex h-4 w-4 shrink-0 items-center justify-center rounded border",
				"border-border/60 bg-card/40 transition-colors",
				"hover:border-border focus:outline-hidden focus:ring-2 focus:ring-offset-0",
				"disabled:cursor-not-allowed disabled:opacity-50",
				checked && "border-transparent"
			)}
			style={checked ? { backgroundColor: themeGradient.from } : undefined}
		>
			<CheckboxPrimitive.Indicator>
				<Check className="h-3 w-3 text-white" />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
};

/**
 * Issue type filter dropdown
 */
const IssueTypeFilter = ({
	value,
	onChange,
	issueTypes,
}: {
	value: ProblematicIssueType | "all";
	onChange: (value: ProblematicIssueType | "all") => void;
	issueTypes: ProblematicIssueType[];
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<SelectPrimitive.Root value={value} onValueChange={(v) => onChange(v as ProblematicIssueType | "all")}>
			<SelectPrimitive.Trigger
				className={cn(
					"flex h-8 items-center justify-between gap-2 rounded-lg border px-3 text-xs",
					"bg-card/60 backdrop-blur-xs text-foreground min-w-[140px]",
					"border-border/50 hover:border-border transition-colors",
					"focus:outline-hidden focus:ring-1"
				)}
			>
				<span className="flex items-center gap-2 truncate">
					<Filter className="h-3.5 w-3.5 text-muted-foreground" />
					<SelectPrimitive.Value />
				</span>
				<SelectPrimitive.Icon asChild>
					<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
				</SelectPrimitive.Icon>
			</SelectPrimitive.Trigger>

			<SelectPrimitive.Portal>
				<SelectPrimitive.Content
					className={cn(
						"relative z-modal overflow-hidden rounded-lg border border-border/50 bg-card/95 backdrop-blur-xl shadow-xl",
						"data-[state=open]:animate-in data-[state=closed]:animate-out",
						"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
					)}
					position="popper"
					sideOffset={4}
				>
					<SelectPrimitive.Viewport className="p-1">
						<SelectPrimitive.Item
							value="all"
							className="relative flex cursor-pointer items-center rounded-md py-1.5 pl-7 pr-3 text-xs outline-hidden hover:bg-muted/50"
						>
							<span className="absolute left-1.5 flex h-4 w-4 items-center justify-center">
								<SelectPrimitive.ItemIndicator>
									<Check className="h-3 w-3" style={{ color: themeGradient.from }} />
								</SelectPrimitive.ItemIndicator>
							</span>
							<SelectPrimitive.ItemText>All Issue Types</SelectPrimitive.ItemText>
						</SelectPrimitive.Item>
						{issueTypes.map((type) => (
							<SelectPrimitive.Item
								key={type}
								value={type}
								className="relative flex cursor-pointer items-center rounded-md py-1.5 pl-7 pr-3 text-xs outline-hidden hover:bg-muted/50"
							>
								<span className="absolute left-1.5 flex h-4 w-4 items-center justify-center">
									<SelectPrimitive.ItemIndicator>
										<Check className="h-3 w-3" style={{ color: themeGradient.from }} />
									</SelectPrimitive.ItemIndicator>
								</span>
								<SelectPrimitive.ItemText>{ISSUE_TYPE_LABELS[type]}</SelectPrimitive.ItemText>
							</SelectPrimitive.Item>
						))}
					</SelectPrimitive.Viewport>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
};

interface BulkClearModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	items: QueueItem[];
	onExecute: (
		itemsToRemove: { item: QueueItem; options: QueueActionOptions }[],
		itemsToRetry: QueueItem[]
	) => Promise<void>;
}

export const BulkClearModal = ({
	open,
	onOpenChange,
	items,
}: BulkClearModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [isExecuting, setIsExecuting] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [issueTypeFilter, setIssueTypeFilter] = useState<ProblematicIssueType | "all">("all");
	const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
	const [itemActions, setItemActions] = useState<Record<string, BulkClearAction>>({});
	const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

	// Process all items with analysis and reason extraction
	const processedItems = useMemo(() => {
		const result: ProcessedItem[] = [];

		for (const item of items) {
			const analysis = analyzeQueueItem(item);
			if (!analysis.isProblematic) continue;

			// Extract the reason from status messages
			const statusLines = collectStatusLines(item);
			const errorLine = statusLines.find(l => l.tone === "error");
			const warningLine = statusLines.find(l => l.tone === "warning");
			const reason = errorLine?.text || warningLine?.text || statusLines[0]?.text || "Unknown issue";

			// Get title
			const title = item.series?.title || item.movie?.title || item.title || "Unknown";

			// Determine protocol
			const protocolStr = (item.protocol ?? item.downloadProtocol ?? "").toLowerCase();
			let protocol: "torrent" | "usenet" | "unknown" = "unknown";
			if (protocolStr.includes("usenet") || protocolStr.includes("nzb")) {
				protocol = "usenet";
			} else if (protocolStr.includes("torrent") || protocolStr.includes("magnet")) {
				protocol = "torrent";
			}

			const itemKey = `${item.service}:${item.instanceId}:${item.id}`;

			result.push({
				item,
				analysis,
				reason,
				title,
				protocol,
				itemKey,
			});
		}

		return result;
	}, [items]);

	// Get unique issue types for filter
	const uniqueIssueTypes = useMemo(() => {
		const types = new Set<ProblematicIssueType>();
		for (const pi of processedItems) {
			if (pi.analysis.primaryIssue) {
				types.add(pi.analysis.primaryIssue);
			}
		}
		return Array.from(types);
	}, [processedItems]);

	// Filter items based on search and issue type
	const filteredItems = useMemo(() => {
		return processedItems.filter((pi) => {
			// Filter by issue type
			if (issueTypeFilter !== "all" && pi.analysis.primaryIssue !== issueTypeFilter) {
				return false;
			}
			// Filter by search query
			if (searchQuery) {
				const query = searchQuery.toLowerCase();
				if (
					!pi.title.toLowerCase().includes(query) &&
					!pi.reason.toLowerCase().includes(query) &&
					!(pi.analysis.primaryIssue && ISSUE_TYPE_LABELS[pi.analysis.primaryIssue].toLowerCase().includes(query))
				) {
					return false;
				}
			}
			return true;
		});
	}, [processedItems, issueTypeFilter, searchQuery]);

	// Initialize actions when items change
	useEffect(() => {
		const newActions: Record<string, BulkClearAction> = {};
		for (const pi of processedItems) {
			if (!(pi.itemKey in itemActions)) {
				newActions[pi.itemKey] = "skip";
			} else {
				newActions[pi.itemKey] = itemActions[pi.itemKey] ?? "skip";
			}
		}
		setItemActions(newActions);
	}, [processedItems]);

	// Selection handlers
	const handleSelectAll = useCallback(() => {
		const allKeys = new Set(filteredItems.map(pi => pi.itemKey));
		setSelectedItems(allKeys);
	}, [filteredItems]);

	const handleDeselectAll = useCallback(() => {
		setSelectedItems(new Set());
	}, []);

	const handleToggleItem = useCallback((key: string) => {
		setSelectedItems(prev => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	const handleToggleExpand = useCallback((key: string) => {
		setExpandedItems(prev => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	// Action handlers
	const handleItemActionChange = useCallback((key: string, action: BulkClearAction) => {
		setItemActions(prev => ({ ...prev, [key]: action }));
	}, []);

	const handleBulkActionChange = useCallback((action: BulkClearAction) => {
		if (selectedItems.size === 0) return;
		setItemActions(prev => {
			const next = { ...prev };
			for (const key of selectedItems) {
				next[key] = action;
			}
			return next;
		});
	}, [selectedItems]);

	// Calculate totals
	const totals = useMemo(() => {
		let toRemove = 0;
		let toRetry = 0;
		let toSkip = 0;

		for (const pi of processedItems) {
			const action = itemActions[pi.itemKey] ?? "skip";
			if (action === "skip") {
				toSkip++;
			} else if (action === "retry") {
				toRetry++;
			} else {
				toRemove++;
			}
		}

		return { toRemove, toRetry, toSkip, total: processedItems.length };
	}, [processedItems, itemActions]);

	const handleExecute = async () => {
		setIsExecuting(true);

		const itemsToRemove: { item: QueueItem; options: QueueActionOptions }[] = [];
		const itemsToRetry: QueueItem[] = [];

		for (const pi of processedItems) {
			const action = itemActions[pi.itemKey] ?? "skip";
			if (action === "skip") continue;

			if (action === "retry") {
				itemsToRetry.push(pi.item);
			} else {
				const options = actionToOptions(action);
				if (options) {
					itemsToRemove.push({ item: pi.item, options });
				}
			}
		}

		try {
			// TODO: Call the execute handler
			console.log("Execute:", { itemsToRemove, itemsToRetry });
			// await onExecute(itemsToRemove, itemsToRetry);
			onOpenChange(false);
		} finally {
			setIsExecuting(false);
		}
	};

	const hasActions = totals.toRemove > 0 || totals.toRetry > 0;
	const _allSelected = filteredItems.length > 0 && selectedItems.size === filteredItems.length;
	const _someSelected = selectedItems.size > 0 && selectedItems.size < filteredItems.length;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-0">
				<DialogHeader className="px-6 pt-6 pb-4 border-b border-border/30">
					<DialogTitle className="flex items-center gap-2">
						<div
							className="flex h-8 w-8 items-center justify-center rounded-lg"
							style={{
								background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}20, ${SEMANTIC_COLORS.warning.to}20)`,
							}}
						>
							<AlertTriangle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.warning.from }} />
						</div>
						Clear Problematic Items
						<span className="ml-2 text-sm font-normal text-muted-foreground">
							({processedItems.length} items)
						</span>
					</DialogTitle>
					<DialogDescription>
						Review each item&apos;s issue and select what action to take. Select items to apply bulk actions.
					</DialogDescription>
				</DialogHeader>

				{/* Filter bar */}
				<div className="px-6 py-3 border-b border-border/30 bg-muted/20">
					<div className="flex items-center gap-3 flex-wrap">
						{/* Search */}
						<div className="relative flex-1 min-w-[200px] max-w-[300px]">
							<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
							<input
								type="text"
								placeholder="Search by title or reason..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className={cn(
									"w-full h-8 pl-8 pr-8 rounded-lg border text-xs",
									"bg-card/60 border-border/50 placeholder:text-muted-foreground/60",
									"focus:outline-hidden focus:ring-1 focus:border-border"
								)}
							/>
							{searchQuery && (
								<button
									onClick={() => setSearchQuery("")}
									className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
								>
									<X className="h-3.5 w-3.5" />
								</button>
							)}
						</div>

						{/* Issue type filter */}
						<IssueTypeFilter
							value={issueTypeFilter}
							onChange={setIssueTypeFilter}
							issueTypes={uniqueIssueTypes}
						/>

						{/* Selection controls */}
						<div className="flex items-center gap-2 ml-auto">
							<Button
								variant="ghost"
								size="sm"
								className="h-7 text-xs"
								onClick={handleSelectAll}
								disabled={filteredItems.length === 0}
							>
								Select All
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 text-xs"
								onClick={handleDeselectAll}
								disabled={selectedItems.size === 0}
							>
								Deselect All
							</Button>

							{/* Bulk action for selected */}
							{selectedItems.size > 0 && (
								<div className="flex items-center gap-2 pl-2 border-l border-border/50">
									<span className="text-xs text-muted-foreground">
										{selectedItems.size} selected:
									</span>
									<ActionSelect
										value="skip"
										onChange={handleBulkActionChange}
										disabled={isExecuting}
										compact
									/>
								</div>
							)}
						</div>
					</div>
				</div>

				{/* Items list */}
				<div className="flex-1 overflow-y-auto">
					{filteredItems.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-12 text-center">
							<div
								className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
								style={{
									background: `linear-gradient(135deg, ${SEMANTIC_COLORS.success.from}10, ${SEMANTIC_COLORS.success.to}10)`,
								}}
							>
								<Check className="h-8 w-8" style={{ color: SEMANTIC_COLORS.success.from }} />
							</div>
							<h3 className="text-lg font-medium mb-1">
								{searchQuery || issueTypeFilter !== "all" ? "No matching items" : "No problematic items"}
							</h3>
							<p className="text-sm text-muted-foreground">
								{searchQuery || issueTypeFilter !== "all"
									? "Try adjusting your filters"
									: "All queue items are healthy!"}
							</p>
						</div>
					) : (
						<div className="divide-y divide-border/30">
							{filteredItems.map((pi) => {
								const isSelected = selectedItems.has(pi.itemKey);
								const isExpanded = expandedItems.has(pi.itemKey);
								const action = itemActions[pi.itemKey] ?? "skip";
								const serviceGradient = SERVICE_GRADIENTS[pi.item.service as keyof typeof SERVICE_GRADIENTS];

								return (
									<div
										key={pi.itemKey}
										className={cn(
											"group transition-colors",
											isSelected && "bg-muted/30"
										)}
									>
										{/* Main row */}
										<div className="flex items-center gap-3 px-6 py-3">
											{/* Checkbox */}
											<ItemCheckbox
												checked={isSelected}
												onCheckedChange={() => handleToggleItem(pi.itemKey)}
												disabled={isExecuting}
											/>

											{/* Expand toggle */}
											<button
												onClick={() => handleToggleExpand(pi.itemKey)}
												className="p-1 rounded hover:bg-muted/50 transition-colors"
											>
												<ChevronRight
													className={cn(
														"h-4 w-4 text-muted-foreground transition-transform",
														isExpanded && "rotate-90"
													)}
												/>
											</button>

											{/* Title and service */}
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2">
													<span className="font-medium text-sm truncate">
														{pi.title}
													</span>
													<span
														className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
														style={{
															backgroundColor: serviceGradient ? `${serviceGradient.from}20` : "var(--muted)",
															color: serviceGradient?.from ?? "var(--muted-foreground)",
														}}
													>
														{pi.item.service}
													</span>
													<span className="text-[10px] text-muted-foreground">
														{pi.item.instanceName}
													</span>
												</div>
												{/* Reason preview */}
												<div className="flex items-start gap-1.5 mt-1">
													<Info className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
													<p className="text-xs text-muted-foreground line-clamp-1">
														{pi.reason}
													</p>
												</div>
											</div>

											{/* Issue type badge */}
											<div className="shrink-0">
												<span
													className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
													style={{
														backgroundColor:
															pi.analysis.severity === "error"
																? SEMANTIC_COLORS.error.from + "15"
																: SEMANTIC_COLORS.warning.from + "15",
														color:
															pi.analysis.severity === "error"
																? SEMANTIC_COLORS.error.from
																: SEMANTIC_COLORS.warning.from,
													}}
												>
													<AlertTriangle className="h-2.5 w-2.5" />
													{pi.analysis.primaryIssue
														? ISSUE_TYPE_LABELS[pi.analysis.primaryIssue]
														: "Issue"}
												</span>
											</div>

											{/* Protocol */}
											<div className="shrink-0 w-16 text-center">
												<span className="text-[10px] text-muted-foreground uppercase">
													{pi.protocol}
												</span>
											</div>

											{/* Action dropdown */}
											<div className="shrink-0">
												<ActionSelect
													value={action}
													onChange={(a) => handleItemActionChange(pi.itemKey, a)}
													disabled={isExecuting}
													compact
												/>
											</div>
										</div>

										{/* Expanded details */}
										{isExpanded && (
											<div className="px-6 pb-3 pl-[4.5rem]">
												<div className="rounded-lg border border-border/30 bg-muted/20 p-3">
													<h5 className="text-xs font-medium text-foreground mb-2">Full Reason</h5>
													<p className="text-xs text-muted-foreground whitespace-pre-wrap">
														{pi.reason}
													</p>

													{/* Additional status messages */}
													{pi.item.statusMessages && pi.item.statusMessages.length > 0 && (
														<div className="mt-3 pt-3 border-t border-border/30">
															<h5 className="text-xs font-medium text-foreground mb-2">All Status Messages</h5>
															<div className="space-y-1">
																{collectStatusLines(pi.item).map((line, _idx) => (
																	<div
																		key={line.key}
																		className={cn(
																			"text-xs px-2 py-1 rounded",
																			line.tone === "error" && "bg-red-500/10 text-red-200",
																			line.tone === "warning" && "bg-amber-500/10 text-amber-200",
																			line.tone === "info" && "bg-muted/50 text-muted-foreground"
																		)}
																	>
																		{line.text}
																	</div>
																))}
															</div>
														</div>
													)}

													{/* Download details */}
													<div className="mt-3 pt-3 border-t border-border/30 grid grid-cols-2 gap-2 text-xs">
														<div>
															<span className="text-muted-foreground">Download Client:</span>{" "}
															<span className="text-foreground">{pi.item.downloadClient ?? "Unknown"}</span>
														</div>
														<div>
															<span className="text-muted-foreground">Protocol:</span>{" "}
															<span className="text-foreground">{pi.protocol}</span>
														</div>
														{pi.item.size && (
															<div>
																<span className="text-muted-foreground">Size:</span>{" "}
																<span className="text-foreground">
																	{(pi.item.size / 1024 ** 3).toFixed(2)} GB
																</span>
															</div>
														)}
														{pi.item.indexer && (
															<div>
																<span className="text-muted-foreground">Indexer:</span>{" "}
																<span className="text-foreground">{pi.item.indexer}</span>
															</div>
														)}
													</div>
												</div>
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* Summary footer */}
				<div className="border-t border-border/50 px-6 py-4 bg-card/50">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-4 text-sm">
							<span className="text-muted-foreground">Summary:</span>
							<div className="flex items-center gap-3">
								{totals.toRemove > 0 && (
									<span className="flex items-center gap-1.5">
										<Trash2 className="h-3.5 w-3.5" style={{ color: SEMANTIC_COLORS.error.from }} />
										<span className="font-medium">{totals.toRemove}</span>
										<span className="text-muted-foreground">to remove</span>
									</span>
								)}
								{totals.toRetry > 0 && (
									<span className="flex items-center gap-1.5">
										<RefreshCw className="h-3.5 w-3.5" style={{ color: themeGradient.from }} />
										<span className="font-medium">{totals.toRetry}</span>
										<span className="text-muted-foreground">to retry</span>
									</span>
								)}
								{totals.toSkip > 0 && (
									<span className="text-muted-foreground">
										{totals.toSkip} skipped
									</span>
								)}
							</div>
						</div>

						<div className="flex items-center gap-2">
							<Button
								variant="secondary"
								onClick={() => onOpenChange(false)}
								disabled={isExecuting}
							>
								Cancel
							</Button>
							<Button
								onClick={handleExecute}
								disabled={isExecuting || !hasActions}
								className="gap-2 min-w-[140px]"
								style={{
									background: hasActions
										? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
										: undefined,
									boxShadow: hasActions ? `0 4px 12px -2px ${themeGradient.glow}` : undefined,
								}}
							>
								{isExecuting ? (
									<>
										<Loader2 className="h-4 w-4 animate-spin" />
										Processing...
									</>
								) : (
									<>
										Execute ({totals.toRemove + totals.toRetry} items)
									</>
								)}
							</Button>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
