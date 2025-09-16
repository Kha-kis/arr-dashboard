import { useCallback, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAppStore } from '@/store';
import { SearchResult } from '@/types';

export const useSearch = () => {
  const {
    apiManager,
    searchQuery,
    searchType,
    selectedIndexers,
    searchResults,
    isSearching,
    setSearchQuery,
    setSearchType,
    toggleIndexer,
    updateSearchResults,
    setSearching,
    setError,
  } = useAppStore();

  // Fetch indexers from Prowlarr
  const {
    data: indexers = [],
    isLoading: isLoadingIndexers,
    error: indexersError,
  } = useQuery({
    queryKey: ['prowlarr', 'indexers'],
    queryFn: async () => {
      if (!apiManager?.isConfigured('prowlarr')) {
        return [];
      }
      return apiManager.prowlarr.getIndexers();
    },
    enabled: !!apiManager?.isConfigured('prowlarr'),
    staleTime: 5 * 60 * 1000, // 5 minutes
    onError: (error: any) => {
      console.error('Failed to fetch indexers:', error);
      setError(`Failed to fetch indexers: ${error.message}`);
    },
  });

  // Search mutation
  const searchMutation = useMutation({
    mutationFn: async ({
      query,
      type,
      indexerIds,
    }: {
      query: string;
      type: 'movie' | 'tv';
      indexerIds: number[];
    }) => {
      if (!apiManager?.isConfigured('prowlarr')) {
        throw new Error('Prowlarr is not configured');
      }

      if (!query.trim()) {
        return [];
      }

      return apiManager.prowlarr.search(
        query.trim(),
        type,
        indexerIds.length > 0 ? indexerIds : [],
        [], // categories - let Prowlarr handle defaults
        100 // limit
      );
    },
    onMutate: () => {
      setSearching(true);
      setError(null);
    },
    onSuccess: (results: SearchResult[]) => {
      updateSearchResults(results);
      setSearching(false);

      if (results.length === 0 && searchQuery.trim()) {
        toast.info('No results found for your search');
      } else if (results.length > 0) {
        toast.success(
          `Found ${results.length} result${results.length !== 1 ? 's' : ''}`
        );
      }
    },
    onError: (error: any) => {
      console.error('Search failed:', error);
      setSearching(false);
      updateSearchResults([]);

      const errorMessage = error.message || 'Search failed';
      setError(errorMessage);
      toast.error(`Search failed: ${errorMessage}`);
    },
  });

  // Grab/download mutation
  const grabMutation = useMutation({
    mutationFn: async (result: SearchResult) => {
      if (!apiManager?.isConfigured('prowlarr')) {
        throw new Error('Prowlarr is not configured');
      }

      return apiManager.prowlarr.grabRelease(result);
    },
    onSuccess: (_, result) => {
      toast.success(`Successfully grabbed "${result.title || result.name}"`);
    },
    onError: (error: any, result) => {
      console.error('Grab failed:', error);
      const errorMessage = error.message || 'Download failed';
      toast.error(
        `Failed to grab "${result.title || result.name}": ${errorMessage}`
      );
    },
  });

  // Perform search
  const performSearch = useCallback(
    (query?: string, type?: 'movie' | 'tv', indexerIds?: number[]) => {
      const searchQueryToUse = query ?? searchQuery;
      const searchTypeToUse = type ?? searchType;
      const indexerIdsToUse = indexerIds ?? Array.from(selectedIndexers);

      if (!searchQueryToUse.trim()) {
        updateSearchResults([]);
        return;
      }

      searchMutation.mutate({
        query: searchQueryToUse,
        type: searchTypeToUse,
        indexerIds: indexerIdsToUse,
      });
    },
    [
      searchQuery,
      searchType,
      selectedIndexers,
      searchMutation,
      updateSearchResults,
    ]
  );

  // Download/grab a result
  const grabResult = useCallback(
    (result: SearchResult) => {
      grabMutation.mutate(result);
    },
    [grabMutation]
  );

  // Auto-select all indexers when they load
  useEffect(() => {
    if (indexers.length > 0 && selectedIndexers.size === 0) {
      const enabledIndexers = indexers.filter(indexer => indexer.enable);
      enabledIndexers.forEach(indexer => {
        toggleIndexer(indexer.id);
      });
    }
  }, [indexers, selectedIndexers.size, toggleIndexer]);

  // Clear results when query is empty
  useEffect(() => {
    if (!searchQuery.trim()) {
      updateSearchResults([]);
    }
  }, [searchQuery, updateSearchResults]);

  return {
    // State
    searchQuery,
    searchType,
    selectedIndexers,
    searchResults,
    isSearching,
    indexers,
    isLoadingIndexers,

    // Actions
    setSearchQuery,
    setSearchType,
    toggleIndexer,
    performSearch,
    grabResult,

    // Status
    isGrabbing: grabMutation.isLoading,
    canSearch: !!apiManager?.isConfigured('prowlarr') && !isSearching,
    hasIndexers: indexers.length > 0,

    // Errors
    searchError: searchMutation.error,
    indexersError,
    grabError: grabMutation.error,
  };
};
