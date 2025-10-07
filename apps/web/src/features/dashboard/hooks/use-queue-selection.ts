/**
 * Hook for managing queue item selection state
 */

import { useState, useEffect, useMemo } from "react";
import type { QueueItem } from "@arr/shared";
import { buildKey } from "../lib/queue-utils";

/**
 * Manages selection state for queue items
 * Handles individual and bulk selection, automatic cleanup of stale selections
 */
export const useQueueSelection = (items: QueueItem[]) => {
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

	// Clean up selections when items change
	useEffect(() => {
		setSelectedKeys((current) => {
			if (current.size === 0) {
				return current;
			}
			const validKeys = new Set(items.map(buildKey));
			const next = new Set<string>();
			for (const key of current) {
				if (validKeys.has(key)) {
					next.add(key);
				}
			}
			return next.size === current.size ? current : next;
		});
	}, [items]);

	// Get selected items
	const selectedItems = useMemo(() => {
		if (selectedKeys.size === 0) {
			return [] as QueueItem[];
		}
		return items.filter((item) => selectedKeys.has(buildKey(item)));
	}, [items, selectedKeys]);

	// Check if all items are selected
	const allSelected = selectedKeys.size > 0 && selectedKeys.size === items.length;

	// Toggle selection for a single item
	const toggleSingleSelection = (item: QueueItem) => {
		setSelectedKeys((current) => {
			const next = new Set(current);
			const key = buildKey(item);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	// Toggle selection for multiple items (e.g., all items in a group)
	const toggleSelectionForItems = (rowItems: QueueItem[]) => {
		setSelectedKeys((current) => {
			const next = new Set(current);
			const keys = rowItems.map(buildKey);
			const everySelected = keys.every((key) => next.has(key));
			keys.forEach((key) => {
				if (everySelected) {
					next.delete(key);
				} else {
					next.add(key);
				}
			});
			return next;
		});
	};

	// Toggle select all items
	const toggleSelectAll = () => {
		if (selectedKeys.size === items.length) {
			setSelectedKeys(new Set());
		} else {
			setSelectedKeys(new Set(items.map(buildKey)));
		}
	};

	// Check if an item is selected
	const isItemSelected = (item: QueueItem) => selectedKeys.has(buildKey(item));

	// Check if all items in a group are selected
	const areAllItemsSelected = (groupItems: QueueItem[]) => {
		const keys = groupItems.map(buildKey);
		return keys.every((key) => selectedKeys.has(key));
	};

	return {
		selectedKeys,
		selectedItems,
		allSelected,
		toggleSingleSelection,
		toggleSelectionForItems,
		toggleSelectAll,
		isItemSelected,
		areAllItemsSelected,
	};
};
