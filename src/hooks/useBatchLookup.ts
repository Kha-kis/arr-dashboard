import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/store';
import {
  BatchLookupService,
  MediaInfo,
  HistoryRecord,
} from '@/services/batchLookupService';

interface BatchLookupStats {
  totalRecords: number;
  resolvedRecords: number;
  cacheHits: number;
  apiCalls: number;
  responseTimeMs: number;
}

export const useBatchLookup = () => {
  const { apiManager } = useAppStore();
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [stats, setStats] = useState<BatchLookupStats>({
    totalRecords: 0,
    resolvedRecords: 0,
    cacheHits: 0,
    apiCalls: 0,
    responseTimeMs: 0,
  });
  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null);

  const batchServiceRef = useRef<BatchLookupService | null>(null);

  // Initialize the batch lookup service
  useEffect(() => {
    if (apiManager && !batchServiceRef.current) {
      console.log('Initializing BatchLookupService...');
      batchServiceRef.current = new BatchLookupService(apiManager);
      setIsInitialized(true);
    }
  }, [apiManager]);

  // Preload data when service is available
  const preloadData = useCallback(
    async (recordsHint?: any[]) => {
      if (!batchServiceRef.current || isLoading) return;

      setIsLoading(true);
      const startTime = Date.now();

      try {
        await batchServiceRef.current.preloadData(recordsHint);
        const responseTime = Date.now() - startTime;
        const cacheStats = batchServiceRef.current.getCacheStats();

        console.log(`Data preloading completed in ${responseTime}ms`);
        setStats(prev => ({
          ...prev,
          responseTimeMs: responseTime,
          apiCalls: prev.apiCalls + 2,
        })); // Typically 2 calls (series + movies)

        // Check if we hit rate limits
        if (cacheStats.series === 0 || cacheStats.movies === 0) {
          setRateLimitWarning(
            'Some data preloading was limited due to API rate limits. Fallback parsing is being used.'
          );
          setTimeout(() => setRateLimitWarning(null), 10000); // Clear after 10 seconds
        }
      } catch (error) {
        console.error('Failed to preload data:', error);
        setRateLimitWarning(
          'Data preloading failed. Using fallback parsing for media information.'
        );
        setTimeout(() => setRateLimitWarning(null), 10000);
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading]
  );

  // Resolve media info for history records
  const resolveMediaInfo = useCallback(
    async (records: HistoryRecord[]): Promise<Map<string, MediaInfo>> => {
      if (!batchServiceRef.current || records.length === 0) {
        return new Map();
      }

      const startTime = Date.now();
      console.log(`Resolving media info for ${records.length} records...`);

      try {
        const mediaInfoMap =
          await batchServiceRef.current.resolveMediaInfo(records);
        const responseTime = Date.now() - startTime;

        // Update stats
        const resolved = mediaInfoMap.size;
        const cacheStats = batchServiceRef.current.getCacheStats();

        setStats(prev => ({
          totalRecords: records.length,
          resolvedRecords: resolved,
          cacheHits:
            prev.cacheHits + (resolved - (records.length - prev.totalRecords)), // Estimate cache hits
          apiCalls: prev.apiCalls + Math.max(0, records.length - resolved), // Estimate additional API calls
          responseTimeMs: responseTime,
        }));

        console.log(
          `Media info resolution completed in ${responseTime}ms - ${resolved}/${records.length} resolved`
        );
        console.log('Cache stats:', cacheStats);

        return mediaInfoMap;
      } catch (error) {
        console.error('Failed to resolve media info:', error);
        return new Map();
      }
    },
    []
  );

  // Get cache statistics
  const getCacheStats = useCallback(() => {
    if (!batchServiceRef.current) {
      return {
        series: 0,
        movies: 0,
        episodes: 0,
        mediaInfo: 0,
        lastUpdate: null,
      };
    }
    return batchServiceRef.current.getCacheStats();
  }, []);

  // Clear cache
  const clearCache = useCallback(() => {
    if (batchServiceRef.current) {
      batchServiceRef.current.clearCache();
      setStats({
        totalRecords: 0,
        resolvedRecords: 0,
        cacheHits: 0,
        apiCalls: 0,
        responseTimeMs: 0,
      });
      console.log('Batch lookup cache cleared');
    }
  }, []);

  // Performance monitoring helper
  const getPerformanceMetrics = useCallback(() => {
    const cacheStats = getCacheStats();
    const cacheHitRate =
      stats.totalRecords > 0 ? (stats.cacheHits / stats.totalRecords) * 100 : 0;
    const apiEfficiency =
      stats.totalRecords > 0
        ? ((stats.totalRecords - stats.apiCalls) / stats.totalRecords) * 100
        : 0;

    return {
      ...stats,
      cacheHitRate: Math.round(cacheHitRate),
      apiEfficiency: Math.round(apiEfficiency),
      avgResponseTime: stats.responseTimeMs,
      cacheSize:
        cacheStats.series +
        cacheStats.movies +
        cacheStats.episodes +
        cacheStats.mediaInfo,
      lastCacheUpdate: cacheStats.lastUpdate,
    };
  }, [stats, getCacheStats]);

  return {
    isInitialized,
    isLoading,
    preloadData,
    resolveMediaInfo,
    getCacheStats,
    clearCache,
    getPerformanceMetrics,
    stats,
    rateLimitWarning,
  };
};
