/**
 * Hook for managing expanded state of queue groups
 */

import { useState } from "react";

/**
 * Manages which queue groups are expanded to show their items
 */
export const useQueueExpansion = () => {
	const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

	const toggleRowExpansion = (rowKey: string) => {
		setExpandedRows((current) => {
			const next = new Set(current);
			if (next.has(rowKey)) {
				next.delete(rowKey);
			} else {
				next.add(rowKey);
			}
			return next;
		});
	};

	const isRowExpanded = (rowKey: string) => expandedRows.has(rowKey);

	return {
		expandedRows,
		toggleRowExpansion,
		isRowExpanded,
	};
};
