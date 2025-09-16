import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAppStore } from '@/store';
import { QueueItem } from '@/types';
import { ApiError } from '@/services/api';

/**
 * Hook for optimistic updates that immediately update the UI
 * before the API call completes, with automatic rollback on error
 */
export const useOptimisticQueue = () => {
  const queryClient = useQueryClient();
  const { apiManager, clearSelection } = useAppStore();

  const optimisticRemove = useMutation({
    mutationFn: async ({
      id,
      service,
      removeFromClient = true,
      blocklist = false,
      changeCategory = false,
    }: {
      id: string | number;
      service: 'sonarr' | 'radarr';
      removeFromClient?: boolean;
      blocklist?: boolean;
      changeCategory?: boolean;
    }) => {
      const queueKey = [service, 'queue'];

      // Immediately update the UI
      queryClient.setQueryData(queueKey, (oldData: QueueItem[] | undefined) => {
        if (!oldData) return [];
        return oldData.filter(item => item.id !== id);
      });

      // Show immediate feedback
      const action = blocklist ? 'blocked and removed' : 'removed';
      toast.success(`Item ${action} from queue`, {
        duration: 2000,
        id: `remove-${id}`, // Prevent duplicate toasts
      });

      // Make the actual API call
      const client =
        service === 'sonarr' ? apiManager!.sonarr : apiManager!.radarr;
      return client.deleteQueueItem(
        id,
        removeFromClient,
        blocklist,
        changeCategory
      );
    },
    onError: (error: ApiError, variables) => {
      // Revert the optimistic update
      const queueKey = [variables.service, 'queue'];
      queryClient.invalidateQueries({ queryKey: queueKey });

      // Show error toast
      toast.error(`Failed to remove item: ${error.message}`, {
        id: `remove-error-${variables.id}`,
      });

      console.error('Optimistic remove failed:', error);
    },
    onSuccess: (_, variables) => {
      // Update was successful, ensure data is fresh
      const queueKey = [variables.service, 'queue'];
      queryClient.invalidateQueries({ queryKey: queueKey });
    },
  });

  const optimisticRetry = useMutation({
    mutationFn: async ({
      id,
      service,
    }: {
      id: string | number;
      service: 'sonarr' | 'radarr';
    }) => {
      const queueKey = [service, 'queue'];

      // Optimistically update the item status
      queryClient.setQueryData(queueKey, (oldData: QueueItem[] | undefined) => {
        if (!oldData) return [];
        return oldData.map(item =>
          item.id === id
            ? { ...item, status: 'queued', errorMessage: undefined }
            : item
        );
      });

      // Show immediate feedback
      toast.success('Item retry initiated', {
        duration: 2000,
        id: `retry-${id}`,
      });

      // Make the actual API call
      const client =
        service === 'sonarr' ? apiManager!.sonarr : apiManager!.radarr;
      return client.retryQueueItem(id);
    },
    onError: (error: ApiError, variables) => {
      // Revert the optimistic update
      const queueKey = [variables.service, 'queue'];
      queryClient.invalidateQueries({ queryKey: queueKey });

      // Show error toast
      toast.error(`Failed to retry item: ${error.message}`, {
        id: `retry-error-${variables.id}`,
      });

      console.error('Optimistic retry failed:', error);
    },
    onSuccess: (_, variables) => {
      // Refresh queue data to get latest status
      const queueKey = [variables.service, 'queue'];
      queryClient.invalidateQueries({ queryKey: queueKey });
    },
  });

  const optimisticBulkAction = useMutation({
    mutationFn: async ({
      ids,
      action,
      service,
      removeFromClient = true,
      blocklist = false,
      changeCategory = false,
    }: {
      ids: (string | number)[];
      action: 'delete' | 'retry';
      service: 'sonarr' | 'radarr';
      removeFromClient?: boolean;
      blocklist?: boolean;
      changeCategory?: boolean;
    }) => {
      const queueKey = [service, 'queue'];

      // Optimistically update the UI based on action
      queryClient.setQueryData(queueKey, (oldData: QueueItem[] | undefined) => {
        if (!oldData) return [];

        if (action === 'delete') {
          return oldData.filter(item => !ids.includes(item.id!));
        } else if (action === 'retry') {
          return oldData.map(item =>
            ids.includes(item.id!)
              ? { ...item, status: 'queued', errorMessage: undefined }
              : item
          );
        }

        return oldData;
      });

      // Clear selection immediately
      clearSelection(service);

      // Show immediate feedback
      const actionText =
        action === 'retry'
          ? 'retried'
          : blocklist
            ? 'blocked and removed'
            : 'removed';
      toast.success(`${ids.length} items ${actionText}`, {
        duration: 2000,
        id: `bulk-${action}-${service}`,
      });

      // Make the actual API call
      const client =
        service === 'sonarr' ? apiManager!.sonarr : apiManager!.radarr;
      return client.bulkQueueAction(
        ids,
        action,
        removeFromClient,
        blocklist,
        changeCategory
      );
    },
    onError: (error: ApiError, variables) => {
      // Revert the optimistic update
      const queueKey = [variables.service, 'queue'];
      queryClient.invalidateQueries({ queryKey: queueKey });

      // Show error toast
      toast.error(`Bulk ${variables.action} failed: ${error.message}`, {
        id: `bulk-${variables.action}-error-${variables.service}`,
      });

      console.error('Optimistic bulk action failed:', error);
    },
    onSuccess: (_, variables) => {
      // Refresh queue data to get latest status
      const queueKey = [variables.service, 'queue'];
      queryClient.invalidateQueries({ queryKey: queueKey });
    },
  });

  return {
    optimisticRemove: optimisticRemove.mutate,
    optimisticRetry: optimisticRetry.mutate,
    optimisticBulkAction: optimisticBulkAction.mutate,
    isProcessing:
      optimisticRemove.isPending ||
      optimisticRetry.isPending ||
      optimisticBulkAction.isPending,
  };
};

/**
 * Hook for optimistic search results updates
 */
export const useOptimisticSearch = () => {
  const { updateSearchResults, searchResults } = useAppStore();

  const optimisticGrab = useMutation({
    mutationFn: async (result: any) => {
      // Immediately show success state
      const updatedResults = searchResults.map(r =>
        r.guid === result.guid
          ? { ...r, grabbed: true, grabbedAt: new Date().toISOString() }
          : r
      );
      updateSearchResults(updatedResults);

      // Show immediate feedback
      toast.success(`Grabbed "${result.title || result.name}"`, {
        duration: 3000,
        id: `grab-${result.guid}`,
      });

      // Make the actual API call
      const { apiManager } = useAppStore.getState();
      return apiManager!.prowlarr.grabRelease(result);
    },
    onError: (error: ApiError, result) => {
      // Revert the optimistic update
      const revertedResults = searchResults.map(r =>
        r.guid === result.guid
          ? { ...r, grabbed: false, grabbedAt: undefined }
          : r
      );
      updateSearchResults(revertedResults);

      // Show error toast
      toast.error(
        `Failed to grab "${result.title || result.name}": ${error.message}`,
        {
          id: `grab-error-${result.guid}`,
        }
      );

      console.error('Optimistic grab failed:', error);
    },
  });

  return {
    optimisticGrab: optimisticGrab.mutate,
    isGrabbing: optimisticGrab.isPending,
  };
};
