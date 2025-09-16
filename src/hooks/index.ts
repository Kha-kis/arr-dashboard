import { useCallback, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAppStore } from '@/store';
import { ApiError } from '@/services/api';
import { SearchResult } from '@/types';
import { debounce } from '@/utils';

// Export the search hook
export { useSearch } from './useSearch';
// Note: useBatchLookup and useOptimistic hooks available but not currently used

// Query keys
const QUERY_KEYS = {
  sonarrStatus: ['sonarr', 'status'] as const,
  sonarrQueue: ['sonarr', 'queue'] as const,
  sonarrHistory: (page: number) => ['sonarr', 'history', page] as const,
  sonarrCalendar: (start: string, end: string) =>
    ['sonarr', 'calendar', start, end] as const,

  radarrStatus: ['radarr', 'status'] as const,
  radarrQueue: ['radarr', 'queue'] as const,
  radarrHistory: (page: number) => ['radarr', 'history', page] as const,
  radarrCalendar: (start: string, end: string) =>
    ['radarr', 'calendar', start, end] as const,

  prowlarrStatus: ['prowlarr', 'status'] as const,
  prowlarrIndexers: ['prowlarr', 'indexers'] as const,
  prowlarrSearch: (query: string, type: string, indexers: number[]) =>
    ['prowlarr', 'search', query, type, ...indexers] as const,
} as const;

// Status hooks
export const useSonarrStatus = () => {
  const { apiManager, updateStatus } = useAppStore();

  return useQuery({
    queryKey: QUERY_KEYS.sonarrStatus,
    queryFn: async () => {
      if (!apiManager?.isConfigured('sonarr')) {
        throw new ApiError('Sonarr not configured');
      }
      return apiManager.sonarr.getStatus();
    },
    enabled: !!apiManager?.isConfigured('sonarr'),
    onSuccess: data => updateStatus('sonarr', data),
    refetchInterval: 5 * 60 * 1000, // 5 minutes
  });
};

export const useRadarrStatus = () => {
  const { apiManager, updateStatus } = useAppStore();

  return useQuery({
    queryKey: QUERY_KEYS.radarrStatus,
    queryFn: async () => {
      if (!apiManager?.isConfigured('radarr')) {
        throw new ApiError('Radarr not configured');
      }
      return apiManager.radarr.getStatus();
    },
    enabled: !!apiManager?.isConfigured('radarr'),
    onSuccess: data => updateStatus('radarr', data),
    refetchInterval: 5 * 60 * 1000,
  });
};

export const useProwlarrStatus = () => {
  const { apiManager, updateStatus } = useAppStore();

  return useQuery({
    queryKey: QUERY_KEYS.prowlarrStatus,
    queryFn: async () => {
      if (!apiManager?.isConfigured('prowlarr')) {
        throw new ApiError('Prowlarr not configured');
      }
      return apiManager.prowlarr.getStatus();
    },
    enabled: !!apiManager?.isConfigured('prowlarr'),
    onSuccess: data => updateStatus('prowlarr', data),
    refetchInterval: 5 * 60 * 1000,
  });
};

// Queue hooks
export const useSonarrQueue = () => {
  const { apiManager, updateQueue } = useAppStore();

  return useQuery({
    queryKey: QUERY_KEYS.sonarrQueue,
    queryFn: async () => {
      if (!apiManager?.isConfigured('sonarr')) {
        throw new ApiError('Sonarr not configured');
      }
      return apiManager.sonarr.getQueue();
    },
    enabled: !!apiManager?.isConfigured('sonarr'),
    onSuccess: data => updateQueue('sonarr', data),
    refetchInterval: 30 * 1000, // 30 seconds
  });
};

export const useRadarrQueue = () => {
  const { apiManager, updateQueue } = useAppStore();

  return useQuery({
    queryKey: QUERY_KEYS.radarrQueue,
    queryFn: async () => {
      if (!apiManager?.isConfigured('radarr')) {
        throw new ApiError('Radarr not configured');
      }
      return apiManager.radarr.getQueue();
    },
    enabled: !!apiManager?.isConfigured('radarr'),
    onSuccess: data => updateQueue('radarr', data),
    refetchInterval: 30 * 1000,
  });
};

// Indexer hooks
export const useIndexers = () => {
  const { apiManager, updateIndexers } = useAppStore();

  return useQuery({
    queryKey: QUERY_KEYS.prowlarrIndexers,
    queryFn: async () => {
      if (!apiManager?.isConfigured('prowlarr')) {
        throw new ApiError('Prowlarr not configured');
      }
      return apiManager.prowlarr.getIndexers();
    },
    enabled: !!apiManager?.isConfigured('prowlarr'),
    onSuccess: data => updateIndexers(data),
    refetchInterval: 10 * 60 * 1000, // 10 minutes
  });
};

// Queue mutation hooks
export const useQueueMutations = (service: 'sonarr' | 'radarr') => {
  const queryClient = useQueryClient();
  const { apiManager, clearSelection } = useAppStore();

  const queueKey =
    service === 'sonarr' ? QUERY_KEYS.sonarrQueue : QUERY_KEYS.radarrQueue;

  const retryMutation = useMutation({
    mutationFn: async (id: string | number) => {
      if (!apiManager?.isConfigured(service)) {
        throw new ApiError(`${service} not configured`);
      }
      const client =
        service === 'sonarr' ? apiManager.sonarr : apiManager.radarr;
      return client.retryQueueItem(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queueKey });
      toast.success('Item retry initiated');
    },
    onError: (error: ApiError) => {
      toast.error(`Retry failed: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({
      id,
      removeFromClient = true,
      blocklist = false,
      changeCategory = false,
    }: {
      id: string | number;
      removeFromClient?: boolean;
      blocklist?: boolean;
      changeCategory?: boolean;
    }) => {
      if (!apiManager?.isConfigured(service)) {
        throw new ApiError(`${service} not configured`);
      }
      const client =
        service === 'sonarr' ? apiManager.sonarr : apiManager.radarr;
      return client.deleteQueueItem(
        id,
        removeFromClient,
        blocklist,
        changeCategory
      );
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: queueKey });
      const action = variables.blocklist ? 'blocked and removed' : 'removed';
      toast.success(`Item ${action}`);
    },
    onError: (error: ApiError) => {
      toast.error(`Delete failed: ${error.message}`);
    },
  });

  const bulkActionMutation = useMutation({
    mutationFn: async ({
      ids,
      action,
      removeFromClient = true,
      blocklist = false,
      changeCategory = false,
    }: {
      ids: (string | number)[];
      action: 'delete' | 'retry';
      removeFromClient?: boolean;
      blocklist?: boolean;
      changeCategory?: boolean;
    }) => {
      if (!apiManager?.isConfigured(service)) {
        throw new ApiError(`${service} not configured`);
      }
      const client =
        service === 'sonarr' ? apiManager.sonarr : apiManager.radarr;
      return client.bulkQueueAction(
        ids,
        action,
        removeFromClient,
        blocklist,
        changeCategory
      );
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: queueKey });
      clearSelection(service);
      const actionText =
        variables.action === 'retry'
          ? 'retried'
          : variables.blocklist
            ? 'blocked and removed'
            : 'removed';
      toast.success(`${variables.ids.length} items ${actionText}`);
    },
    onError: (error: ApiError) => {
      toast.error(`Bulk action failed: ${error.message}`);
    },
  });

  return {
    retry: retryMutation.mutate,
    delete: deleteMutation.mutate,
    bulkAction: bulkActionMutation.mutate,
    isRetrying: retryMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isBulkActioning: bulkActionMutation.isPending,
  };
};

// Search hook with debouncing
export const useProwlarrSearch = () => {
  const {
    apiManager,
    searchType,
    selectedIndexers,
    updateSearchResults,
    setSearching,
  } = useAppStore();

  const searchMutation = useMutation({
    mutationFn: async ({
      query,
      type = 'movie',
      indexers = [],
    }: {
      query: string;
      type?: 'movie' | 'tv';
      indexers?: number[];
    }) => {
      if (!apiManager?.isConfigured('prowlarr')) {
        throw new ApiError('Prowlarr not configured');
      }
      return apiManager.prowlarr.search(query, type, indexers);
    },
    onMutate: () => {
      setSearching(true);
    },
    onSuccess: data => {
      updateSearchResults(data);
      toast.success(`Found ${data.length} results`);
    },
    onError: (error: ApiError) => {
      toast.error(`Search failed: ${error.message}`);
      updateSearchResults([]);
    },
    onSettled: () => {
      setSearching(false);
    },
  });

  const debouncedSearch = useCallback(
    debounce((query: string) => {
      if (query.trim()) {
        searchMutation.mutate({
          query,
          type: searchType,
          indexers: Array.from(selectedIndexers),
        });
      }
    }, 500),
    [searchType, selectedIndexers]
  );

  return {
    search: (query: string) => debouncedSearch(query),
    manualSearch: searchMutation.mutate,
    isSearching: searchMutation.isPending,
  };
};

// Send to *arr hook
export const useSendToArr = () => {
  const { apiManager } = useAppStore();

  return useMutation({
    mutationFn: async (result: SearchResult) => {
      if (!apiManager?.isConfigured('prowlarr')) {
        throw new ApiError('Prowlarr not configured');
      }
      return apiManager.prowlarr.grabRelease(result);
    },
    onSuccess: () => {
      toast.success('Sent to *arr services successfully');
    },
    onError: (error: ApiError) => {
      toast.error(`Send failed: ${error.message}`);
    },
  });
};

// Auto-refresh hook
export const useAutoRefresh = () => {
  const { autoRefresh, refreshInterval } = useAppStore();
  const queryClient = useQueryClient();
  const intervalRef = useRef<NodeJS.Timeout>();

  const refreshAllData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['sonarr'] });
    queryClient.invalidateQueries({ queryKey: ['radarr'] });
    queryClient.invalidateQueries({ queryKey: ['prowlarr'] });
  }, [queryClient]);

  useEffect(() => {
    if (autoRefresh && refreshInterval > 0) {
      intervalRef.current = setInterval(refreshAllData, refreshInterval * 1000);
      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      };
    }
  }, [autoRefresh, refreshInterval, refreshAllData]);

  return { refreshAllData };
};

// History hooks
export const useHistory = (service: 'sonarr' | 'radarr', page = 1) => {
  const { apiManager } = useAppStore();

  const queryKey =
    service === 'sonarr'
      ? QUERY_KEYS.sonarrHistory(page)
      : QUERY_KEYS.radarrHistory(page);

  return useQuery({
    queryKey,
    queryFn: async () => {
      if (!apiManager?.isConfigured(service)) {
        throw new ApiError(`${service} not configured`);
      }
      const client =
        service === 'sonarr' ? apiManager.sonarr : apiManager.radarr;
      return client.getHistory(page);
    },
    enabled: !!apiManager?.isConfigured(service),
  });
};

// Enhanced history hooks with filtering and pagination
interface HistoryFilters {
  search?: string;
  status?: string;
  protocol?: string;
  quality?: string;
  indexer?: string;
  downloadClient?: string;
  dateFrom?: string;
  dateTo?: string;
}

export const useEnhancedHistory = (
  service: 'sonarr' | 'radarr',
  page = 1,
  pageSize = 50,
  filters: HistoryFilters = {}
) => {
  const { apiManager } = useAppStore();

  const queryKey = [
    service,
    'history-enhanced',
    page,
    pageSize,
    JSON.stringify(filters),
  ] as const;

  return useQuery({
    queryKey,
    queryFn: async () => {
      if (!apiManager?.isConfigured(service)) {
        throw new ApiError(`${service} not configured`);
      }
      const client =
        service === 'sonarr' ? apiManager.sonarr : apiManager.radarr;
      return client.getHistory(page, pageSize, 'date', 'descending');
    },
    enabled: !!apiManager?.isConfigured(service),
    keepPreviousData: true,
  });
};

export const useProwlarrHistory = (
  page = 1,
  pageSize = 100,
  comprehensive = false
) => {
  const { apiManager } = useAppStore();

  const queryKey = comprehensive
    ? (['prowlarr', 'history-comprehensive'] as const)
    : (['prowlarr', 'history', page, pageSize] as const);

  return useQuery({
    queryKey,
    queryFn: async () => {
      if (!apiManager?.isConfigured('prowlarr')) {
        throw new ApiError('Prowlarr not configured');
      }
      return comprehensive
        ? apiManager.prowlarr.getComprehensiveHistory()
        : apiManager.prowlarr.getHistory(page, pageSize);
    },
    enabled: !!apiManager?.isConfigured('prowlarr'),
    keepPreviousData: true,
    staleTime: comprehensive ? 5 * 60 * 1000 : 30 * 1000, // 5 min for comprehensive, 30s for paginated
  });
};

// Unified history hook that merges data from all services
export const useUnifiedHistory = (
  page = 1,
  pageSize = 50,
  filters: HistoryFilters & {
    service?: 'all' | 'sonarr' | 'radarr' | 'prowlarr';
  } = { service: 'all' }
) => {
  // Get API manager from store if needed later

  const sonarrQuery = useEnhancedHistory('sonarr', page, pageSize, filters);
  const radarrQuery = useEnhancedHistory('radarr', page, pageSize, filters);
  const prowlarrQuery = useProwlarrHistory(page, pageSize);

  const isLoading =
    ((filters.service === 'all' || filters.service === 'sonarr') &&
      sonarrQuery.isLoading) ||
    ((filters.service === 'all' || filters.service === 'radarr') &&
      radarrQuery.isLoading) ||
    ((filters.service === 'all' || filters.service === 'prowlarr') &&
      prowlarrQuery.isLoading);

  const error = sonarrQuery.error || radarrQuery.error || prowlarrQuery.error;

  const data = useMemo(() => {
    const allRecords: Array<any & { service: string }> = [];
    let totalRecords = 0;

    if (
      (filters.service === 'all' || filters.service === 'sonarr') &&
      sonarrQuery.data
    ) {
      const sonarrRecords = sonarrQuery.data.records || [];
      allRecords.push(
        ...sonarrRecords.map((record: any) => ({
          ...record,
          service: 'sonarr',
        }))
      );
      if (filters.service === 'sonarr')
        totalRecords = sonarrQuery.data.totalRecords || 0;
    }

    if (
      (filters.service === 'all' || filters.service === 'radarr') &&
      radarrQuery.data
    ) {
      const radarrRecords = radarrQuery.data.records || [];
      allRecords.push(
        ...radarrRecords.map((record: any) => ({
          ...record,
          service: 'radarr',
        }))
      );
      if (filters.service === 'radarr')
        totalRecords = radarrQuery.data.totalRecords || 0;
    }

    if (
      (filters.service === 'all' || filters.service === 'prowlarr') &&
      prowlarrQuery.data
    ) {
      const prowlarrRecords = prowlarrQuery.data.records || [];
      allRecords.push(
        ...prowlarrRecords.map((record: any) => ({
          ...record,
          service: 'prowlarr',
        }))
      );
      if (filters.service === 'prowlarr')
        totalRecords = prowlarrQuery.data.totalRecords || 0;
    }

    // Apply client-side filters
    let filteredRecords = allRecords;

    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      filteredRecords = filteredRecords.filter(
        record =>
          record.title?.toLowerCase().includes(searchLower) ||
          record.downloadId?.toLowerCase().includes(searchLower)
      );
    }

    if (filters.status) {
      filteredRecords = filteredRecords.filter(
        record => record.status === filters.status
      );
    }

    if (filters.protocol) {
      filteredRecords = filteredRecords.filter(
        record => record.protocol === filters.protocol
      );
    }

    if (filters.indexer) {
      filteredRecords = filteredRecords.filter(
        record => record.indexer === filters.indexer
      );
    }

    if (filters.downloadClient) {
      filteredRecords = filteredRecords.filter(
        record => record.downloadClient === filters.downloadClient
      );
    }

    if (filters.dateFrom || filters.dateTo) {
      filteredRecords = filteredRecords.filter(record => {
        if (!record.date) return false;
        const recordDate = new Date(record.date);
        if (filters.dateFrom && recordDate < new Date(filters.dateFrom))
          return false;
        if (filters.dateTo && recordDate > new Date(filters.dateTo))
          return false;
        return true;
      });
    }

    // Sort by date descending
    filteredRecords.sort(
      (a, b) =>
        new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
    );

    // Calculate totals for unified view
    if (filters.service === 'all') {
      totalRecords = filteredRecords.length;
    }

    return {
      records: filteredRecords,
      totalRecords,
      hasMore: filteredRecords.length >= pageSize,
    };
  }, [
    sonarrQuery.data,
    radarrQuery.data,
    prowlarrQuery.data,
    filters,
    pageSize,
  ]);

  return {
    data,
    isLoading,
    error,
    refetch: () => {
      if (filters.service === 'all' || filters.service === 'sonarr')
        sonarrQuery.refetch();
      if (filters.service === 'all' || filters.service === 'radarr')
        radarrQuery.refetch();
      if (filters.service === 'all' || filters.service === 'prowlarr')
        prowlarrQuery.refetch();
    },
  };
};

// Calendar hooks
export const useCalendar = (
  service: 'sonarr' | 'radarr',
  startDate: string,
  endDate: string
) => {
  const { apiManager } = useAppStore();

  const queryKey =
    service === 'sonarr'
      ? QUERY_KEYS.sonarrCalendar(startDate, endDate)
      : QUERY_KEYS.radarrCalendar(startDate, endDate);

  return useQuery({
    queryKey,
    queryFn: async () => {
      if (!apiManager?.isConfigured(service)) {
        throw new ApiError(`${service} not configured`);
      }
      const client =
        service === 'sonarr' ? apiManager.sonarr : apiManager.radarr;
      return client.getCalendar(startDate, endDate);
    },
    enabled: !!apiManager?.isConfigured(service) && !!startDate && !!endDate,
  });
};

// Statistics hooks
export const useStatistics = (service: 'sonarr' | 'radarr' | 'prowlarr') => {
  const { apiManager } = useAppStore();

  const queryKey =
    service === 'sonarr'
      ? (['sonarr', 'statistics'] as const)
      : service === 'radarr'
        ? (['radarr', 'statistics'] as const)
        : (['prowlarr', 'statistics'] as const);

  return useQuery({
    queryKey,
    queryFn: async () => {
      if (!apiManager?.isConfigured(service)) {
        throw new ApiError(`${service} not configured`);
      }
      const client =
        service === 'sonarr'
          ? apiManager.sonarr
          : service === 'radarr'
            ? apiManager.radarr
            : apiManager.prowlarr;
      return client.getStatistics();
    },
    enabled: !!apiManager?.isConfigured(service),
    refetchInterval: 5 * 60 * 1000, // 5 minutes
  });
};

// Error handling hook
export const useErrorHandler = () => {
  const { setError } = useAppStore();

  return useCallback(
    (error: unknown) => {
      let message = 'An unknown error occurred';

      if (error instanceof ApiError) {
        message = error.message;
      } else if (error instanceof Error) {
        message = error.message;
      } else if (typeof error === 'string') {
        message = error;
      }

      setError(message);
      toast.error(message);
    },
    [setError]
  );
};

// Configuration validation hook
export const useConfigValidation = () => {
  const { config } = useAppStore();

  const validateService = useCallback(
    (service: 'sonarr' | 'radarr' | 'prowlarr') => {
      const serviceConfig = config[service];
      return !!(serviceConfig.baseUrl && serviceConfig.apiKey);
    },
    [config]
  );

  const getConfigurationStatus = useCallback(() => {
    return {
      sonarr: validateService('sonarr'),
      radarr: validateService('radarr'),
      prowlarr: validateService('prowlarr'),
      hasAnyService:
        validateService('sonarr') ||
        validateService('radarr') ||
        validateService('prowlarr'),
    };
  }, [validateService]);

  return { validateService, getConfigurationStatus };
};
