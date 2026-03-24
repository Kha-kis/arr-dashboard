"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "arr-insight-dismissed";

/**
 * Hook for managing dismissed Library Insight items.
 * Uses localStorage for lightweight persistence.
 *
 * Key format: "instanceId:arrItemId" — unique per library item.
 */
export function useInsightDismissals() {
	const [dismissed, setDismissed] = useState<Set<string>>(new Set());

	// Load from localStorage on mount
	useEffect(() => {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				if (Array.isArray(parsed)) {
					setDismissed(new Set(parsed));
				}
			}
		} catch {
			// Ignore parse errors
		}
	}, []);

	const dismiss = useCallback((instanceId: string, arrItemId: number) => {
		const key = `${instanceId}:${arrItemId}`;
		setDismissed((prev) => {
			const next = new Set(prev);
			next.add(key);
			localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
			return next;
		});
	}, []);

	const isDismissed = useCallback(
		(instanceId: string, arrItemId: number) => {
			return dismissed.has(`${instanceId}:${arrItemId}`);
		},
		[dismissed],
	);

	return { dismissed, dismiss, isDismissed };
}
