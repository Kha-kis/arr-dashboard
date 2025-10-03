'use client';

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MultiInstanceQueueResponse, QueueItem } from "@arr/shared";
import { performQueueAction, performQueueBulkAction } from "../../lib/api-client/dashboard";

type QueueActionType = "retry" | "delete" | "manualImport";

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

type QueueActionContext = {
  previous?: MultiInstanceQueueResponse;
};

const QUEUE_QUERY_KEY = ["dashboard", "queue"] as const;

const getItemKey = (item: QueueItem): string | null => {
  if (item.id === undefined || item.id === null) {
    return null;
  }
  return `${item.service}:${item.instanceId}:${String(item.id)}`;
};

const buildGroupKey = (item: QueueItem) => `${item.instanceId}:${item.service}`;

const defaultOptions: Required<QueueActionOptions> = {
  removeFromClient: true,
  blocklist: false,
  changeCategory: false,
  search: false,
};

const applyOptimisticUpdate = (
  previous: MultiInstanceQueueResponse,
  variables: QueueActionVariables,
): MultiInstanceQueueResponse => {
  const keys = new Set(
    variables.items
      .map((item) => getItemKey(item))
      .filter((key): key is string => Boolean(key)),
  );

  const transform = (list: QueueItem[]) => {
    if (variables.action === "delete") {
      return list.filter((item) => {
        const key = getItemKey(item);
        return key ? !keys.has(key) : true;
      });
    }

    return list.map((item) => {
      const key = getItemKey(item);
      if (key && keys.has(key)) {
        return {
          ...item,
          status: variables.action === "manualImport" ? "Manual import requested" : "Retry requested",
        };
      }
      return item;
    });
  };

  const instances = previous.instances.map((instance) => ({
    ...instance,
    data: transform(instance.data),
  }));

  const aggregated = transform(previous.aggregated);

  return {
    instances,
    aggregated,
    totalCount: aggregated.length,
  };
};

type QueueSearchPayload = {
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
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

  return undefined;
};

const performActionRequests = async ({ action, items, options }: QueueActionVariables) => {
  const mergedOptions = { ...defaultOptions, ...options };

  const relevantItems =
    action === "delete"
      ? items
      : items.filter((item) => {
          if (action === "manualImport") {
            return Boolean(item.actions?.canManualImport && item.downloadId);
          }

          if (action === "retry") {
            if (!item.actions) {
              return true;
            }
            return Boolean(item.actions.canRetry);
          }

          return true;
        });

  if (relevantItems.length === 0) {
    return;
  }

  if (action === "manualImport") {
    const manualGroups = new Map<
      string,
      {
        instanceId: string;
        service: QueueItem["service"];
        itemId: string | number;
        downloadId: string;
      }
    >();

    const missingDownloadIds: QueueItem[] = [];

    for (const item of relevantItems) {
      const itemId = item.id;
      const downloadId = item.downloadId;

      if (itemId === undefined || itemId === null) {
        continue;
      }

      if (!downloadId) {
        missingDownloadIds.push(item);
        continue;
      }

      const key = `${item.instanceId}:${item.service}:${downloadId}`;
      if (!manualGroups.has(key)) {
        manualGroups.set(key, {
          instanceId: item.instanceId,
          service: item.service,
          itemId: itemId as string | number,
          downloadId,
        });
      }
    }

    if (manualGroups.size === 0) {
      if (missingDownloadIds.length > 0) {
        throw new Error("Selected items do not expose a download identifier for manual import.");
      }

      return;
    }

    await Promise.all(
      Array.from(manualGroups.values()).map((group) =>
        performQueueAction({
          instanceId: group.instanceId,
          service: group.service,
          itemId: group.itemId,
          action,
          downloadId: group.downloadId,
          removeFromClient: mergedOptions.removeFromClient,
          blocklist: mergedOptions.blocklist,
          changeCategory: mergedOptions.changeCategory,
          search: mergedOptions.search,
        }),
      ),
    );

    return;
  }

  if (action === "delete" && mergedOptions.search) {
    await Promise.all(
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

    return;
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

  const requests: Array<Promise<void>> = [];

  for (const group of groups.values()) {
    if (group.ids.length === 1) {
      const [firstId] = group.ids;
      if (firstId === undefined) {
        continue;
      }
      requests.push(
        performQueueAction({
          instanceId: group.instanceId,
          service: group.service,
          itemId: firstId,
          action,
          removeFromClient: mergedOptions.removeFromClient,
          blocklist: mergedOptions.blocklist,
          changeCategory: mergedOptions.changeCategory,
          search: mergedOptions.search,
        }),
      );
    } else {
      requests.push(
        performQueueBulkAction({
          instanceId: group.instanceId,
          service: group.service,
          ids: group.ids,
          action,
          removeFromClient: mergedOptions.removeFromClient,
          blocklist: mergedOptions.blocklist,
          changeCategory: mergedOptions.changeCategory,
          search: mergedOptions.search,
        }),
      );
    }
  }

  await Promise.all(requests);
};

export const useQueueActions = () => {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, QueueActionVariables, QueueActionContext>({
    mutationFn: performActionRequests,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: QUEUE_QUERY_KEY });
      const previous = queryClient.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY);

      if (previous) {
        const updated = applyOptimisticUpdate(previous, variables);
        queryClient.setQueryData(QUEUE_QUERY_KEY, updated);
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(QUEUE_QUERY_KEY, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
    },
  });

  const executeAsync = (
    action: QueueActionType,
    items: QueueItem[],
    options?: QueueActionOptions,
  ) => {
    if (items.length === 0) {
      return Promise.resolve();
    }

    return mutation.mutateAsync({ action, items, options });
  };

  const execute = (action: QueueActionType, items: QueueItem[], options?: QueueActionOptions) => {
    if (items.length === 0) {
      return;
    }
    mutation.mutate({ action, items, options });
  };

  return {
    execute,
    executeAsync,
    isPending: mutation.isPending,
    error: mutation.error,
  };
};
