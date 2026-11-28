"use client";

import type { MultiInstanceQueueResponse, QueueItem } from "@arr/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { performQueueAction, performQueueBulkAction } from "../../lib/api-client/dashboard";
import { getErrorMessage } from "../../lib/error-utils";
import { QUEUE_QUERY_KEY } from "../../lib/query-keys";

type QueueActionType = "retry" | "delete";

const assertQueueAction = (action: unknown): void => {
	if (action !== "retry" && action !== "delete") {
		throw new Error("Use Manual Import review to submit and track imports.");
	}
};

export type QueueActionOptions = {
	removeFromClient?: boolean;
	blocklist?: boolean;
	changeCategory?: boolean;
	search?: boolean;
};

type QueueActionVariables = {
	action: QueueActionType;
	items: QueueItem[];
	options?: QueueActionOptions;
};

const getItemKey = (item: Pick<QueueItem, "service" | "instanceId" | "id">): string | null => {
	if (item.id === undefined || item.id === null) {
		return null;
	}
	return JSON.stringify([item.service, item.instanceId, String(item.id)]);
};

const buildGroupKey = (item: QueueItem) => `${item.instanceId}:${item.service}`;

const defaultOptions: Required<QueueActionOptions> = {
	removeFromClient: true,
	blocklist: false,
	changeCategory: false,
	search: false,
};

type QueueSearchPayload = {
	seriesId?: number;
	episodeIds?: number[];
	movieId?: number;
	albumId?: number;
	artistId?: number;
	bookId?: number;
	authorId?: number;
};

const buildSearchPayload = (item: QueueItem): QueueSearchPayload | undefined => {
	if (item.service === "sonarr") {
		const payload: QueueSearchPayload = {};
		if (typeof item.seriesId === "number") {
			payload.seriesId = item.seriesId;
		}
		if (typeof item.episodeId === "number") {
			payload.episodeIds = [item.episodeId];
		}
		if (payload.seriesId !== undefined || payload.episodeIds) {
			return payload;
		}
		return undefined;
	}

	if (item.service === "radarr" && typeof item.movieId === "number") {
		return { movieId: item.movieId };
	}
	if (item.service === "lidarr") {
		if (typeof item.albumId === "number") return { albumId: item.albumId };
		if (typeof item.artistId === "number") return { artistId: item.artistId };
	}
	if (item.service === "readarr") {
		if (typeof item.bookId === "number") return { bookId: item.bookId };
		if (typeof item.authorId === "number") return { authorId: item.authorId };
	}

	return undefined;
};

export type QueueSearchWarning = "unconfirmed" | "unverified";
type QueueActionOutcome = { completedKeys: string[]; warning: QueueSearchWarning | null };
class QueueActionBatchError extends Error {
	constructor(
		readonly outcome: QueueActionOutcome,
		message = "Some queue removals could not be completed. Refresh the queue and review the remaining items.",
	) {
		super(message);
	}
}

const performActionRequests = async ({
	action,
	items,
	options,
}: QueueActionVariables): Promise<QueueActionOutcome | undefined> => {
	assertQueueAction(action);
	const mergedOptions = { ...defaultOptions, ...options };

	const relevantItems =
		action === "delete"
			? items
			: items.filter((item) => !item.actions || Boolean(item.actions.canRetry));

	if (relevantItems.length === 0) {
		return;
	}

	if (action === "delete" && mergedOptions.search) {
		const results = await Promise.allSettled(
			relevantItems.map((item) => {
				const itemId = item.id;
				if (itemId === undefined || itemId === null) {
					return Promise.resolve();
				}
				const payload = buildSearchPayload(item);
				return performQueueAction({
					instanceId: item.instanceId,
					service: item.service,
					itemId: itemId as string | number,
					action,
					removeFromClient: mergedOptions.removeFromClient,
					blocklist: mergedOptions.blocklist,
					changeCategory: mergedOptions.changeCategory,
					search: true,
					...(payload ? { searchPayload: payload } : {}),
				});
			}),
		);

		const outcome: QueueActionOutcome = { completedKeys: [], warning: null };
		let failed = false;
		for (let index = 0; index < results.length; index++) {
			const result = results[index]!;
			if (result.status === "rejected") {
				failed = true;
				continue;
			}
			const value = result.value;
			if (value?.removal === "completed") {
				const key = getItemKey(relevantItems[index]!);
				if (key) outcome.completedKeys.push(key);
			}
			if (!value || value.removal === "unverified") outcome.warning = "unverified";
			else if (value.search === "unconfirmed" && outcome.warning !== "unverified")
				outcome.warning = "unconfirmed";
		}
		if (failed) throw new QueueActionBatchError(outcome);
		return outcome;
	}

	const groups = new Map<
		string,
		{
			instanceId: string;
			service: QueueItem["service"];
			ids: Array<string | number>;
		}
	>();

	for (const item of relevantItems) {
		const itemId = item.id;
		if (itemId === undefined || itemId === null) {
			continue;
		}
		const safeId = itemId as string | number;
		const key = buildGroupKey(item);
		const existing = groups.get(key);
		if (existing) {
			existing.ids.push(safeId);
		} else {
			groups.set(key, {
				instanceId: item.instanceId,
				service: item.service,
				ids: [safeId],
			});
		}
	}

	const requests: Array<{ response: Promise<unknown>; completedKeys: string[] }> = [];

	for (const group of groups.values()) {
		let response: Promise<unknown>;
		if (group.ids.length === 1) {
			const [firstId] = group.ids;
			if (firstId === undefined) {
				continue;
			}
			response = performQueueAction({
				instanceId: group.instanceId,
				service: group.service,
				itemId: firstId,
				action,
				removeFromClient: mergedOptions.removeFromClient,
				blocklist: mergedOptions.blocklist,
				changeCategory: mergedOptions.changeCategory,
				search: mergedOptions.search,
			});
		} else {
			response = performQueueBulkAction({
				instanceId: group.instanceId,
				service: group.service,
				ids: group.ids,
				action,
				removeFromClient: mergedOptions.removeFromClient,
				blocklist: mergedOptions.blocklist,
				changeCategory: mergedOptions.changeCategory,
				search: mergedOptions.search,
			});
		}
		requests.push({
			response,
			completedKeys:
				action === "delete"
					? group.ids
							.map(
								(id) => getItemKey({ service: group.service, instanceId: group.instanceId, id })!,
							)
							.filter(Boolean)
					: [],
		});
	}

	const results = await Promise.allSettled(requests.map((request) => request.response));
	const outcome: QueueActionOutcome = { completedKeys: [], warning: null };
	let failure: string | undefined;
	for (let index = 0; index < results.length; index++) {
		const result = results[index]!;
		if (result.status === "fulfilled")
			outcome.completedKeys.push(...requests[index]!.completedKeys);
		else
			failure ??=
				getErrorMessage(result.reason, "Failed to process queue action.") ||
				"Failed to process queue action.";
	}
	if (failure !== undefined) throw new QueueActionBatchError(outcome, failure);
	return outcome;
};

export const useQueueActions = () => {
	const queryClient = useQueryClient();
	const [searchWarning, setSearchWarning] = useState<QueueSearchWarning | null>(null);
	const retainActionOutcome = (outcome: QueueActionOutcome) => {
		if (outcome.warning)
			setSearchWarning((current) => (current === "unverified" ? current : outcome.warning));
		if (outcome.completedKeys.length === 0) return;
		const completed = new Set(outcome.completedKeys);
		const keep = (item: QueueItem) => !completed.has(getItemKey(item) ?? "");
		queryClient.setQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY, (current) => {
			if (!current) return current;
			const aggregated = current.aggregated.filter(keep);
			return {
				...current,
				instances: current.instances.map((instance) => ({
					...instance,
					data: instance.data.filter(keep),
				})),
				aggregated,
				totalCount: aggregated.length,
			};
		});
	};

	const mutation = useMutation<QueueActionOutcome | undefined, Error, QueueActionVariables>({
		mutationFn: performActionRequests,
		onError: (error) => {
			if (error instanceof QueueActionBatchError) retainActionOutcome(error.outcome);
		},
		onSuccess: (outcome) => {
			if (outcome) retainActionOutcome(outcome);
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});

	const executeAsync = useCallback(
		(action: QueueActionType, items: QueueItem[], options?: QueueActionOptions) => {
			if (items.length === 0) {
				return Promise.resolve();
			}
			return mutation.mutateAsync({ action, items, options }).then(() => {});
		},
		[mutation],
	);

	const execute = useCallback(
		(action: QueueActionType, items: QueueItem[], options?: QueueActionOptions) => {
			if (items.length === 0) {
				return;
			}
			mutation.mutate({ action, items, options });
		},
		[mutation],
	);

	return {
		execute,
		executeAsync,
		isPending: mutation.isPending,
		error: mutation.error,
		searchWarning,
		clearSearchWarning: useCallback(() => setSearchWarning(null), []),
	};
};
