import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/services/api';
import { toast } from 'sonner';

interface OptimizedQueryOptions<T> {
  queryKey: string[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
  staleTime?: number;
  cacheTime?: number;
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  retryDelay?: number | ((attemptIndex: number, error: Error) => number);
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
  background?: boolean;
}

interface OptimizedQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  isStale: boolean;
  isFetching: boolean;
  retry: () => void;
}

export function useOptimizedQuery<T>(
  options: OptimizedQueryOptions<T>
): OptimizedQueryResult<T> {
  const {
    queryKey,
    queryFn,
    enabled = true,
    staleTime = 5 * 60 * 1000, // 5 minutes
    cacheTime = 10 * 60 * 1000, // 10 minutes
    refetchInterval,
    retry = 3,
    retryDelay = (attemptIndex) => Math.min(1000 * Math.pow(2, attemptIndex), 30000),
    onSuccess,
    onError,
    background = false,
  } = options;

  const queryClient = useQueryClient();
  const [retryCount, setRetryCount] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Enhanced retry logic
  const retryFn = useCallback((failureCount: number, error: Error) => {
    if (error instanceof ApiError) {
      // Don't retry on authentication errors
      if (error.status === 401 || error.status === 403) {
        return false;
      }
      // Don't retry on client errors (4xx) except rate limiting
      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        return false;
      }
    }
    
    // Retry up to configured limit
    if (typeof retry === 'number') {
      return failureCount < retry;
    } else if (typeof retry === 'boolean') {
      return retry;
    } else {
      return retry(failureCount, error);
    }
  }, [retry]);

  // Wrapped query function with abort support
  const wrappedQueryFn = useCallback(async () => {
    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    // Create new abort controller
    abortControllerRef.current = new AbortController();
    
    try {
      const result = await queryFn();
      setRetryCount(0);
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      setRetryCount(prev => prev + 1);
      throw error;
    }
  }, [queryFn]);

  const query = useQuery({
    queryKey,
    queryFn: wrappedQueryFn,
    enabled,
    staleTime,
    cacheTime,
    refetchInterval,
    retry: retryFn,
    retryDelay,
    onSuccess: useCallback((data) => {
      if (!background) {
        onSuccess?.(data);
      }
    }, [onSuccess, background]),
    onError: useCallback((error: Error) => {
      if (!background && retryCount >= (typeof retry === 'number' ? retry : 3)) {
        onError?.(error);
        
        // Show toast for user-facing errors
        if (error instanceof ApiError) {
          toast.error(`${error.message} (${error.status})`);
        } else {
          toast.error(error.message || 'An unexpected error occurred');
        }
      }
    }, [onError, background, retryCount, retry]),
    refetchOnWindowFocus: false,
    refetchOnMount: true,
    refetchOnReconnect: true,
  });

  // Manual retry function
  const manualRetry = useCallback(() => {
    setRetryCount(0);
    query.refetch();
  }, [query]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    isStale: query.isStale,
    isFetching: query.isFetching,
    retry: manualRetry,
  };
}

// Hook for batch queries (useful for dashboard)
interface BatchQueryOptions<T> {
  queries: Array<{
    queryKey: string[];
    queryFn: () => Promise<T>;
    enabled?: boolean;
  }>;
  staleTime?: number;
  cacheTime?: number;
}

export function useBatchQueries<T>(
  options: BatchQueryOptions<T>
) {
  const { queries, staleTime = 5 * 60 * 1000, cacheTime = 10 * 60 * 1000 } = options;

  const results = queries.map(query => 
    useOptimizedQuery({
      ...query,
      staleTime,
      cacheTime,
      background: true, // Don't show individual error toasts for batch queries
    })
  );

  const isLoading = results.some(result => result.isLoading);
  const hasError = results.some(result => result.error);
  const errors = results.filter(result => result.error).map(result => result.error);
  
  const refetchAll = useCallback(() => {
    results.forEach(result => result.refetch());
  }, [results]);

  return {
    results,
    isLoading,
    hasError,
    errors,
    refetchAll,
    data: results.map(result => result.data),
  };
}

// Hook for infinite queries with optimizations
interface InfiniteQueryOptions<T> {
  queryKey: string[];
  queryFn: (pageParam: number) => Promise<{ data: T[]; nextPage?: number }>;
  enabled?: boolean;
  pageSize?: number;
}

export function useOptimizedInfiniteQuery<T>(
  options: InfiniteQueryOptions<T>
) {
  const { queryKey, queryFn, enabled = true, pageSize = 50 } = options;
  const [allData, setAllData] = useState<T[]>([]);

  const query = useQuery({
    queryKey,
    queryFn: () => queryFn(1),
    enabled,
    staleTime: 2 * 60 * 1000, // 2 minutes for paginated data
    onSuccess: (data) => {
      setAllData(data.data);
    },
  });

  const loadMore = useCallback(async () => {
    const nextPage = Math.ceil(allData.length / pageSize) + 1;
    try {
      const result = await queryFn(nextPage);
      setAllData(prev => [...prev, ...result.data]);
      return result;
    } catch (error) {
      throw error;
    }
  }, [allData.length, pageSize, queryFn]);

  return {
    data: allData,
    isLoading: query.isLoading,
    error: query.error,
    loadMore,
    hasNextPage: true, // Simplified - in real use, this would be determined by API response
    refetch: () => {
      setAllData([]);
      return query.refetch();
    },
  };
}