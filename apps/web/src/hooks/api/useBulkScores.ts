"use client";

import { useQuery } from "@tanstack/react-query";
import type { BulkScoreFilters, CustomFormatScoreEntry } from "@arr/shared";

interface BulkScoresResponse {
	success: boolean;
	data: {
		scores: CustomFormatScoreEntry[];
	};
}

interface UseBulkScoresFilters {
	instanceId: string;
	search?: string;
	modifiedOnly?: boolean;
}

/**
 * Fetches bulk scores for an instance with optional filtering
 */
async function fetchBulkScores(filters: BulkScoreFilters): Promise<BulkScoresResponse> {
	const params = new URLSearchParams(
		Object.entries(filters).reduce((acc, [key, value]) => {
			if (value !== undefined) acc[key] = String(value);
			return acc;
		}, {} as Record<string, string>)
	);

	const response = await fetch(`/api/trash-guides/bulk-scores?${params}`, {
		headers: { "Content-Type": "application/json" },
	});

	if (!response.ok) {
		throw new Error("Failed to fetch scores");
	}

	return response.json();
}

/**
 * Hook to fetch bulk scores for custom formats across templates
 */
export function useBulkScores(filters: UseBulkScoresFilters) {
	return useQuery<BulkScoresResponse>({
		queryKey: ["bulk-scores", filters],
		queryFn: () =>
			fetchBulkScores({
				instanceId: filters.instanceId,
				search: filters.search,
				modifiedOnly: filters.modifiedOnly,
			}),
		enabled: !!filters.instanceId,
		staleTime: 30 * 1000, // 30 seconds
	});
}
