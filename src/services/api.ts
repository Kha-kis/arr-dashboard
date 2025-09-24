import {
  AppConfig,
  SystemStatus,
  QueueItem,
  Indexer,
  SearchResult,
  DownloadHistoryItem,
  CalendarItem,
} from '@/types';

const getBackendUrl = () => {
  const env =
    typeof import.meta !== 'undefined' && (import.meta as any).env
      ? (import.meta as any).env
      : {};

  const normalize = (url: string) => url.replace(/\/$/, '');

  // Highest priority: explicit environment override
  if (env.VITE_BACKEND_URL) {
    return normalize(env.VITE_BACKEND_URL as string);
  }

  // Server-side rendering or tests
  if (typeof window === 'undefined') {
    if (env.DEV) {
      const port = (env.VITE_BACKEND_PORT as string) || '3001';
      return `http://localhost:${port}`;
    }
    return 'http://localhost:3000';
  }

  const { protocol, hostname, port } = window.location;

  // In development we run the API proxy on a dedicated express server
  if (env.DEV) {
    const devPort = (env.VITE_BACKEND_PORT as string) || '3001';
    return `${protocol}//${hostname}:${devPort}`;
  }

  if (port) {
    return `${protocol}//${hostname}:${port}`;
  }

  const defaultPort = protocol === 'https:' ? '443' : '80';
  return `${protocol}//${hostname}:${defaultPort}`;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  timeout?: number;
}

export class BaseClient {
  protected baseUrl: string;
  protected apiKey: string;
  protected cache = new Map<string, { data: any; timestamp: number }>();
  protected cacheDuration = 5 * 60 * 1000; // 5 minutes
  private readonly backendUrl = getBackendUrl();
  private requestTimes = new Map<string, number[]>();
  private readonly rateLimitWindow = 60000; // 1 minute
  private readonly maxRequestsPerMinute = 30; // Reduced to be more conservative

  constructor(config: { baseUrl: string; apiKey: string }) {
    this.baseUrl = (config.baseUrl || '').replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
  }

  protected getUrl(path: string): string {
    const url = `${this.baseUrl}${path}`;
    // Always use backend API proxy to avoid CORS issues
    return `${this.backendUrl}/api/proxy?url=${encodeURIComponent(url)}`;
  }

  protected async request<T>(
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    if (!this.baseUrl || !this.apiKey) {
      throw new ApiError('Missing baseUrl or apiKey');
    }

    // Rate limiting check
    const now = Date.now();
    const clientKey = this.baseUrl;
    const times = this.requestTimes.get(clientKey) || [];
    const recentTimes = times.filter(time => now - time < this.rateLimitWindow);

    if (recentTimes.length >= this.maxRequestsPerMinute) {
      throw new ApiError(
        'Rate limit exceeded. Please wait before making more requests.'
      );
    }

    recentTimes.push(now);
    this.requestTimes.set(clientKey, recentTimes);

    const cacheKey = `${path}:${JSON.stringify(options)}`;
    const cached = this.cache.get(cacheKey);

    if (
      cached &&
      Date.now() - cached.timestamp < this.cacheDuration &&
      options.method === 'GET'
    ) {
      return cached.data;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.timeout || 30000
    );

    try {
      // Pass API key securely in headers instead of URL parameters
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
        ...options.headers,
      };

      const response = await fetch(this.getUrl(path), {
        method: options.method || 'GET',
        headers,
        body: options.body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new ApiError(
          `${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
          response.status,
          errorText
        );
      }

      const contentType = response.headers.get('content-type') || '';
      let data;
      if (contentType.includes('application/json')) {
        const text = await response.text();
        data = text ? JSON.parse(text) : null;
      } else {
        data = await response.text();
      }

      // Cache GET requests
      if (options.method === 'GET' || !options.method) {
        this.cache.set(cacheKey, { data, timestamp: Date.now() });
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
    }
  }

  protected clearCache(): void {
    this.cache.clear();
  }

  protected clearCachePattern(pattern: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }
}

export class SonarrClient extends BaseClient {
  async getStatus(): Promise<SystemStatus> {
    return this.request<SystemStatus>('/api/v3/system/status');
  }

  async getQueue(): Promise<QueueItem[]> {
    // Get all queue items by setting a high page size
    const response = await this.request<
      { records?: QueueItem[] } | QueueItem[]
    >('/api/v3/queue?pageSize=1000&includeUnknownSeriesItems=true');
    return Array.isArray(response) ? response : response.records || [];
  }

  async retryQueueItem(id: string | number): Promise<void> {
    await this.request(`/api/v3/queue/${id}/retry`, { method: 'POST' });
    this.clearCachePattern('queue');
  }

  async deleteQueueItem(
    id: string | number,
    removeFromClient = true,
    blocklist = false,
    changeCategory = false
  ): Promise<void> {
    await this.request(
      `/api/v3/queue/${id}?removeFromClient=${removeFromClient}&blocklist=${blocklist}&changeCategory=${changeCategory}`,
      { method: 'DELETE' }
    );
    this.clearCachePattern('queue');
  }

  async bulkQueueAction(
    ids: (string | number)[],
    action: 'delete' | 'retry',
    removeFromClient = true,
    blocklist = false,
    changeCategory = false
  ): Promise<void> {
    if (action === 'retry') {
      // Retry items individually as bulk retry might not be supported
      await Promise.all(ids.map(id => this.retryQueueItem(id)));
    } else {
      await this.request('/api/v3/queue/bulk', {
        method: 'DELETE',
        body: JSON.stringify({
          ids,
          removeFromClient,
          blocklist,
          changeCategory,
        }),
      });
    }
    this.clearCachePattern('queue');
  }

  async getHistory(
    page = 1,
    pageSize = 50,
    sortKey = 'date',
    sortDirection = 'descending'
  ): Promise<{ records: DownloadHistoryItem[]; totalRecords: number }> {
    return this.request(
      `/api/v3/history?page=${page}&pageSize=${pageSize}&sortKey=${sortKey}&sortDirection=${sortDirection}`
    );
  }

  async getCalendar(
    startDate: string,
    endDate: string,
    unmonitored = false
  ): Promise<CalendarItem[]> {
    return this.request(
      `/api/v3/calendar?start=${startDate}&end=${endDate}&unmonitored=${unmonitored}&includeSeries=true&includeEpisodeFile=true`
    );
  }

  async getSeries(): Promise<any[]> {
    return this.request('/api/v3/series');
  }

  async searchSeries(term: string): Promise<any[]> {
    // Input validation and sanitization
    if (typeof term !== 'string' || term.trim().length === 0) {
      throw new ApiError('Search term must be a non-empty string');
    }
    if (term.length > 200) {
      throw new ApiError('Search term is too long (max 200 characters)');
    }
    const sanitizedTerm = term.trim().replace(/[<>"'&]/g, '');
    return this.request(
      `/api/v3/series/lookup?term=${encodeURIComponent(sanitizedTerm)}`
    );
  }

  async addSeries(series: any): Promise<any> {
    return this.request('/api/v3/series', {
      method: 'POST',
      body: JSON.stringify(series),
    });
  }

  async getQualityProfiles(): Promise<any[]> {
    return this.request('/api/v3/qualityprofile');
  }

  async getLanguageProfiles(): Promise<any[]> {
    return this.request('/api/v3/languageprofile');
  }

  async getRootFolders(): Promise<any[]> {
    return this.request('/api/v3/rootfolder');
  }

  async searchMissing(): Promise<void> {
    return this.request('/api/v3/command', {
      method: 'POST',
      body: JSON.stringify({ name: 'MissingEpisodeSearch' }),
    });
  }

  async getHealth(): Promise<any> {
    return this.request('/api/v3/health').catch(() => []);
  }

  async getTags(): Promise<any> {
    return this.request('/api/v3/tag').catch(() => []);
  }

  async getSystemInfo(): Promise<any> {
    return this.request('/api/v3/system/status');
  }

  async getDiskSpace(): Promise<any> {
    return this.request('/api/v3/diskspace');
  }

  async getWanted(): Promise<any> {
    return this.request(
      '/api/v3/wanted/missing?pageSize=1000&sortKey=airDateUtc&sortDirection=descending'
    ).catch(() => ({ records: [], totalRecords: 0 }));
  }

  async getCutoffUnmet(): Promise<any> {
    return this.request(
      '/api/v3/wanted/cutoff?pageSize=1000&sortKey=airDateUtc&sortDirection=descending'
    ).catch(() => ({ records: [], totalRecords: 0 }));
  }

  async getCommands(): Promise<any> {
    return this.request('/api/v3/command').catch(() => []);
  }

  async getSeriesById(id: number): Promise<any> {
    return this.request(`/api/v3/series/${id}`);
  }

  async getEpisodeById(id: number): Promise<any> {
    return this.request(`/api/v3/episode/${id}`);
  }

  // Enhanced batch episode fetching for multiple series with improved error handling and caching
  async getEpisodesBySeriesIds(
    seriesIds: number[],
    useCache = true
  ): Promise<Map<number, any[]>> {
    const episodeMap = new Map<number, any[]>();

    if (seriesIds.length === 0) return episodeMap;

    const cacheKey = 'episodes_batch';
    let cachedEpisodes = new Map<number, any[]>();

    // Check cache first if enabled
    if (useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheDuration) {
        cachedEpisodes = cached.data;
      }
    }

    // Filter out series that are already cached
    const seriesToFetch = useCache
      ? seriesIds.filter(id => !cachedEpisodes.has(id))
      : seriesIds;

    // Return cached data for series we already have
    cachedEpisodes.forEach((episodes, seriesId) => {
      if (seriesIds.includes(seriesId)) {
        episodeMap.set(seriesId, episodes);
      }
    });

    if (seriesToFetch.length === 0) {
      return episodeMap;
    }

    console.log(
      `Fetching episodes for ${seriesToFetch.length} series (${seriesIds.length - seriesToFetch.length} from cache)`
    );

    // Fetch episodes for each series in smaller batches to avoid API limits
    const batchSize = 15; // Increased batch size for better performance
    const batches: number[][] = [];

    for (let i = 0; i < seriesToFetch.length; i += batchSize) {
      batches.push(seriesToFetch.slice(i, i + batchSize));
    }

    // Process batches with controlled concurrency
    for (const batch of batches) {
      const batchPromises = batch.map(async seriesId => {
        try {
          const episodes = await this.request(
            `/api/v3/episode?seriesId=${seriesId}`
          );
          const episodesArray = Array.isArray(episodes) ? episodes : [];
          episodeMap.set(seriesId, episodesArray);
          cachedEpisodes.set(seriesId, episodesArray);
        } catch (error) {
          console.error(
            `Failed to fetch episodes for series ${seriesId}:`,
            error
          );
          episodeMap.set(seriesId, []);
          cachedEpisodes.set(seriesId, []); // Cache empty result to avoid retrying
        }
      });

      // Wait for current batch to complete before starting next
      await Promise.allSettled(batchPromises);

      // Small delay to be nice to the API
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Update cache
    if (useCache) {
      this.cache.set(cacheKey, { data: cachedEpisodes, timestamp: Date.now() });
    }

    console.log(
      `Completed episode fetching: ${episodeMap.size} series processed`
    );
    return episodeMap;
  }

  // Get multiple series by IDs
  async getSeriesByIds(seriesIds: number[]): Promise<Map<number, any>> {
    const seriesMap = new Map<number, any>();

    if (seriesIds.length === 0) return seriesMap;

    try {
      // Fetch all series first, then filter
      const allSeries = await this.getSeries();
      const seriesIdSet = new Set(seriesIds);

      allSeries
        .filter(series => seriesIdSet.has(series.id))
        .forEach(series => seriesMap.set(series.id, series));

      return seriesMap;
    } catch (error) {
      console.error('Failed to fetch series by IDs:', error);
      return seriesMap;
    }
  }

  async getStatistics(): Promise<any> {
    const [
      series,
      diskSpace,
      systemInfo,
      health,
      tags,
      wanted,
      cutoff,
      commands,
    ] = await Promise.all([
      this.getSeries(),
      this.getDiskSpace(),
      this.getSystemInfo(),
      this.getHealth(),
      this.getTags(),
      this.getWanted(),
      this.getCutoffUnmet(),
      this.getCommands(),
    ]);

    const totalSeries = series.length;
    const monitoredSeries = series.filter((s: any) => s.monitored).length;
    const totalEpisodes = series.reduce(
      (acc: number, s: any) => acc + (s.statistics?.totalEpisodeCount || 0),
      0
    );
    const downloadedEpisodes = series.reduce(
      (acc: number, s: any) => acc + (s.statistics?.episodeFileCount || 0),
      0
    );
    const missingEpisodes = wanted?.totalRecords || 0;
    const cutoffUnmetCount = cutoff?.totalRecords || 0;
    const activeCommands =
      commands?.filter((c: any) => c.status === 'started').length || 0;

    const totalSize = diskSpace.reduce(
      (acc: number, d: any) => acc + (d.totalSpace || 0),
      0
    );
    const freeSpace = diskSpace.reduce(
      (acc: number, d: any) => acc + (d.freeSpace || 0),
      0
    );

    // Quality distribution analysis
    const qualityDistribution = series.reduce((acc: any, s: any) => {
      const qualityName = s.qualityProfile?.name || 'Unknown';
      acc[qualityName] = (acc[qualityName] || 0) + 1;
      return acc;
    }, {});

    // Series status breakdown
    const seriesStatus = series.reduce((acc: any, s: any) => {
      const status = s.status || 'unknown';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    return {
      totalSeries,
      monitoredSeries,
      totalEpisodes,
      downloadedEpisodes,
      missingEpisodes,
      cutoffUnmetCount,
      activeCommands,
      downloadedPercentage:
        totalEpisodes > 0
          ? Math.round((downloadedEpisodes / totalEpisodes) * 100)
          : 0,
      totalDiskSpace: totalSize,
      freeDiskSpace: freeSpace,
      usedDiskSpace: totalSize - freeSpace,
      usedPercentage:
        totalSize > 0
          ? Math.round(((totalSize - freeSpace) / totalSize) * 100)
          : 0,
      qualityDistribution,
      seriesStatus,
      systemInfo,
      health: health || [],
      tags: tags || [],
      healthIssues: (health || []).filter(
        (h: any) => h.type === 'error' || h.type === 'warning'
      ).length,
      version: systemInfo?.version || 'Unknown',
      uptime: systemInfo?.startTime
        ? Math.round(
            (Date.now() - new Date(systemInfo.startTime).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0,
    };
  }
}

export class RadarrClient extends BaseClient {
  async getStatus(): Promise<SystemStatus> {
    return this.request<SystemStatus>('/api/v3/system/status');
  }

  async getQueue(): Promise<QueueItem[]> {
    // Get all queue items by setting a high page size and including unknown series items
    const response = await this.request<
      { records?: QueueItem[] } | QueueItem[]
    >('/api/v3/queue?pageSize=1000&includeUnknownSeriesItems=true');
    return Array.isArray(response) ? response : response.records || [];
  }

  async retryQueueItem(id: string | number): Promise<void> {
    await this.request(`/api/v3/queue/${id}/retry`, { method: 'POST' });
    this.clearCachePattern('queue');
  }

  async deleteQueueItem(
    id: string | number,
    removeFromClient = true,
    blocklist = false,
    changeCategory = false
  ): Promise<void> {
    await this.request(
      `/api/v3/queue/${id}?removeFromClient=${removeFromClient}&blocklist=${blocklist}&changeCategory=${changeCategory}`,
      { method: 'DELETE' }
    );
    this.clearCachePattern('queue');
  }

  async bulkQueueAction(
    ids: (string | number)[],
    action: 'delete' | 'retry',
    removeFromClient = true,
    blocklist = false,
    changeCategory = false
  ): Promise<void> {
    if (action === 'retry') {
      await Promise.all(ids.map(id => this.retryQueueItem(id)));
    } else {
      await this.request('/api/v3/queue/bulk', {
        method: 'DELETE',
        body: JSON.stringify({
          ids,
          removeFromClient,
          blocklist,
          changeCategory,
        }),
      });
    }
    this.clearCachePattern('queue');
  }

  async getHistory(
    page = 1,
    pageSize = 50,
    sortKey = 'date',
    sortDirection = 'descending'
  ): Promise<{ records: DownloadHistoryItem[]; totalRecords: number }> {
    return this.request(
      `/api/v3/history?page=${page}&pageSize=${pageSize}&sortKey=${sortKey}&sortDirection=${sortDirection}`
    );
  }

  async getCalendar(
    startDate: string,
    endDate: string,
    unmonitored = false
  ): Promise<CalendarItem[]> {
    return this.request(
      `/api/v3/calendar?start=${startDate}&end=${endDate}&unmonitored=${unmonitored}&includeUnmonitored=true`
    );
  }

  async getMovies(): Promise<any[]> {
    return this.request('/api/v3/movie');
  }

  async searchMovies(term: string): Promise<any[]> {
    // Input validation and sanitization
    if (typeof term !== 'string' || term.trim().length === 0) {
      throw new ApiError('Search term must be a non-empty string');
    }
    if (term.length > 200) {
      throw new ApiError('Search term is too long (max 200 characters)');
    }
    const sanitizedTerm = term.trim().replace(/[<>"'&]/g, '');
    return this.request(
      `/api/v3/movie/lookup?term=${encodeURIComponent(sanitizedTerm)}`
    );
  }

  async addMovie(movie: any): Promise<any> {
    return this.request('/api/v3/movie', {
      method: 'POST',
      body: JSON.stringify(movie),
    });
  }

  async getQualityProfiles(): Promise<any[]> {
    return this.request('/api/v3/qualityprofile');
  }

  async getRootFolders(): Promise<any[]> {
    return this.request('/api/v3/rootfolder');
  }

  async searchMissing(): Promise<void> {
    return this.request('/api/v3/command', {
      method: 'POST',
      body: JSON.stringify({ name: 'MissingMovieSearch' }),
    });
  }

  async getHealth(): Promise<any> {
    return this.request('/api/v3/health').catch(() => []);
  }

  async getTags(): Promise<any> {
    return this.request('/api/v3/tag').catch(() => []);
  }

  async getSystemInfo(): Promise<any> {
    return this.request('/api/v3/system/status');
  }

  async getDiskSpace(): Promise<any> {
    return this.request('/api/v3/diskspace');
  }

  async getWanted(): Promise<any> {
    return this.request(
      '/api/v3/wanted/missing?pageSize=1000&sortKey=added&sortDirection=descending'
    ).catch(() => ({ records: [], totalRecords: 0 }));
  }

  async getCutoffUnmet(): Promise<any> {
    return this.request(
      '/api/v3/wanted/cutoff?pageSize=1000&sortKey=added&sortDirection=descending'
    ).catch(() => ({ records: [], totalRecords: 0 }));
  }

  async getCommands(): Promise<any> {
    return this.request('/api/v3/command').catch(() => []);
  }

  async getMovieById(id: number): Promise<any> {
    return this.request(`/api/v3/movie/${id}`);
  }

  // Batch movie lookup functionality for efficient history resolution
  async getMoviesByIds(
    movieIds: number[],
    useCache = true
  ): Promise<Map<number, any>> {
    const movieMap = new Map<number, any>();

    if (movieIds.length === 0) return movieMap;

    const cacheKey = 'movies_batch';
    let cachedMovies = new Map<number, any>();

    // Check cache first if enabled
    if (useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheDuration) {
        cachedMovies = cached.data;
      }
    }

    try {
      // Fetch all movies first, then filter - this is usually more efficient than individual calls
      let allMovies: any[] = [];

      if (cachedMovies.size === 0 || !useCache) {
        console.log('Fetching all movies for batch lookup...');
        allMovies = await this.getMovies();

        // Cache all movies
        allMovies.forEach(movie => cachedMovies.set(movie.id, movie));

        if (useCache) {
          this.cache.set(cacheKey, {
            data: cachedMovies,
            timestamp: Date.now(),
          });
        }
      }

      // Filter requested movies from cache
      const movieIdSet = new Set(movieIds);
      cachedMovies.forEach((movie, id) => {
        if (movieIdSet.has(id)) {
          movieMap.set(id, movie);
        }
      });

      console.log(
        `Batch movie lookup: found ${movieMap.size}/${movieIds.length} movies`
      );
      return movieMap;
    } catch (error) {
      console.error('Failed to fetch movies in batch:', error);
      return movieMap;
    }
  }

  async getStatistics(): Promise<any> {
    const [
      movies,
      diskSpace,
      systemInfo,
      health,
      tags,
      wanted,
      cutoff,
      commands,
    ] = await Promise.all([
      this.getMovies(),
      this.getDiskSpace(),
      this.getSystemInfo(),
      this.getHealth(),
      this.getTags(),
      this.getWanted(),
      this.getCutoffUnmet(),
      this.getCommands(),
    ]);

    const totalMovies = movies.length;
    const monitoredMovies = movies.filter((m: any) => m.monitored).length;
    const downloadedMovies = movies.filter((m: any) => m.hasFile).length;
    const missingMovies = wanted?.totalRecords || 0;
    const cutoffUnmetCount = cutoff?.totalRecords || 0;
    const activeCommands =
      commands?.filter((c: any) => c.status === 'started').length || 0;

    const totalSize = diskSpace.reduce(
      (acc: number, d: any) => acc + (d.totalSpace || 0),
      0
    );
    const freeSpace = diskSpace.reduce(
      (acc: number, d: any) => acc + (d.freeSpace || 0),
      0
    );

    // Quality distribution analysis
    const qualityDistribution = movies.reduce((acc: any, m: any) => {
      const qualityName = m.qualityProfile?.name || 'Unknown';
      acc[qualityName] = (acc[qualityName] || 0) + 1;
      return acc;
    }, {});

    // Movie status breakdown
    const movieStatus = movies.reduce((acc: any, m: any) => {
      const status = m.status || 'unknown';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    return {
      totalMovies,
      monitoredMovies,
      downloadedMovies,
      missingMovies,
      cutoffUnmetCount,
      activeCommands,
      downloadedPercentage:
        totalMovies > 0
          ? Math.round((downloadedMovies / totalMovies) * 100)
          : 0,
      totalDiskSpace: totalSize,
      freeDiskSpace: freeSpace,
      usedDiskSpace: totalSize - freeSpace,
      usedPercentage:
        totalSize > 0
          ? Math.round(((totalSize - freeSpace) / totalSize) * 100)
          : 0,
      qualityDistribution,
      movieStatus,
      systemInfo,
      health: health || [],
      tags: tags || [],
      healthIssues: (health || []).filter(
        (h: any) => h.type === 'error' || h.type === 'warning'
      ).length,
      version: systemInfo?.version || 'Unknown',
      uptime: systemInfo?.startTime
        ? Math.round(
            (Date.now() - new Date(systemInfo.startTime).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0,
    };
  }
}

export class ProwlarrClient extends BaseClient {
  async getStatus(): Promise<SystemStatus> {
    return this.request<SystemStatus>('/api/v1/system/status');
  }

  async getIndexers(): Promise<Indexer[]> {
    return this.request<Indexer[]>('/api/v1/indexer');
  }

  async search(
    query: string,
    type: 'movie' | 'tv' | 'music' | 'book' = 'movie',
    indexerIds: number[] = [],
    categories: number[] = [],
    limit = 100
  ): Promise<SearchResult[]> {
    // Input validation
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new ApiError('Search query must be a non-empty string');
    }
    if (query.length > 200) {
      throw new ApiError('Search query is too long (max 200 characters)');
    }
    if (!['movie', 'tv', 'music', 'book'].includes(type)) {
      throw new ApiError('Invalid search type');
    }
    if (limit < 1 || limit > 500) {
      throw new ApiError('Limit must be between 1 and 500');
    }
    if (indexerIds.some(id => typeof id !== 'number' || id < 1)) {
      throw new ApiError('Invalid indexer IDs');
    }
    if (categories.some(cat => typeof cat !== 'number' || cat < 1)) {
      throw new ApiError('Invalid category IDs');
    }

    const params = new URLSearchParams();
    const sanitizedQuery = query.trim().replace(/[<>"'&]/g, '');

    if (sanitizedQuery) {
      params.append('query', sanitizedQuery);
    }

    if (type) {
      params.append('type', type);
    }

    params.append('limit', limit.toString());

    if (indexerIds.length > 0) {
      indexerIds.forEach(id => {
        params.append('indexerIds', id.toString());
      });
    }

    if (categories.length > 0) {
      categories.forEach(cat => {
        params.append('categories', cat.toString());
      });
    }

    const response = await this.request<
      SearchResult[] | { results?: SearchResult[] }
    >(`/api/v1/search?${params.toString()}`);
    return Array.isArray(response) ? response : response.results || [];
  }

  async grabRelease(result: SearchResult): Promise<void> {
    try {
      if (result.protocol === 'torrent' && result.magnetUrl) {
        await this.request('/api/v1/release', {
          method: 'POST',
          body: JSON.stringify({
            guid: result.guid || result.magnetUrl,
            indexerId: result.indexerId,
            title: result.title,
            size: result.size,
            downloadUrl: result.magnetUrl,
            protocol: result.protocol,
          }),
        });
        return;
      }

      if (result.downloadUrl || result.link) {
        const downloadUrl = result.downloadUrl || result.link;

        await this.request('/api/v1/release', {
          method: 'POST',
          body: JSON.stringify({
            guid: result.guid || downloadUrl,
            indexerId: result.indexerId,
            title: result.title,
            size: result.size,
            downloadUrl: downloadUrl,
            protocol: result.protocol,
            publishDate: result.publishDate,
            categories: result.categories,
          }),
        });
        return;
      }

      if (result.guid) {
        await this.request(
          `/api/v1/download?guid=${encodeURIComponent(result.guid)}&indexerId=${result.indexerId}`,
          {
            method: 'GET',
          }
        );
        return;
      }

      throw new ApiError('No download method available for this release');
    } catch (error) {
      console.error('Grab failed:', error);
      throw error;
    }
  }

  async testIndexer(
    indexerId: number
  ): Promise<{ isValid: boolean; errors: string[] }> {
    try {
      await this.request(`/api/v1/indexer/test/${indexerId}`, {
        method: 'POST',
      });
      return { isValid: true, errors: [] };
    } catch (error) {
      return {
        isValid: false,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      };
    }
  }

  async getHistory(page = 1, pageSize = 100): Promise<any> {
    return this.request(
      `/api/v1/history?page=${page}&pageSize=${pageSize}&sortKey=date&sortDirection=descending`
    );
  }

  async getComprehensiveHistory(): Promise<any> {
    // Get history data for at least the last 30 days by fetching until we have enough
    const promises = [];
    const maxPages = 50; // Increase to get more comprehensive data

    for (let page = 1; page <= maxPages; page++) {
      promises.push(this.getHistory(page, 1000).catch(() => ({ records: [] })));
    }

    const results = await Promise.all(promises);
    let allRecords = results.flatMap(result => result.records || []);

    // Filter to ensure we have at least 30 days of data
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Keep all records, but prioritize recent ones
    allRecords = allRecords.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return { records: allRecords, totalRecords: allRecords.length };
  }

  async getApplications(): Promise<any> {
    return this.request('/api/v1/applications').catch(() => []);
  }

  async getDownloadClients(): Promise<any> {
    return this.request('/api/v1/downloadclient').catch(() => []);
  }

  async getNotifications(): Promise<any> {
    return this.request('/api/v1/notification').catch(() => []);
  }

  async getTags(): Promise<any> {
    return this.request('/api/v1/tag').catch(() => []);
  }

  async getSystemStatus(): Promise<any> {
    return this.request('/api/v1/system/status').catch(() => {});
  }

  async getHealth(): Promise<any> {
    return this.request('/api/v1/health').catch(() => []);
  }

  async getLog(page = 1, pageSize = 50): Promise<any> {
    return this.request(
      `/api/v1/log?page=${page}&pageSize=${pageSize}&sortKey=time&sortDirection=descending`
    ).catch(() => ({ records: [] }));
  }

  async getStatistics(): Promise<any> {
    try {
      const [
        indexers,
        history,
        applications,
        downloadClients,
        systemStatus,
        health,
        tags,
        notifications,
      ] = await Promise.all([
        this.getIndexers(),
        this.getComprehensiveHistory(), // Get comprehensive history data
        this.getApplications(),
        this.getDownloadClients(),
        this.getSystemStatus(),
        this.getHealth(),
        this.getTags(),
        this.getNotifications(),
      ]);

      const totalIndexers = indexers.length;
      const activeIndexers = indexers.filter((i: any) => i.enable).length;
      const inactiveIndexers = totalIndexers - activeIndexers;

      // Calculate statistics from history
      const historyRecords = history.records || [];
      const totalQueries = historyRecords.length;
      const totalGrabs = historyRecords.filter(
        (record: any) =>
          record.eventType === 'grabbed' || record.successful === true
      ).length;
      const successRate =
        totalQueries > 0 ? Math.round((totalGrabs / totalQueries) * 100) : 0;

      // Calculate per-indexer statistics
      const indexerStats = indexers.map((indexer: any) => {
        const indexerHistory = historyRecords.filter(
          (record: any) => record.indexerId === indexer.id
        );
        const queries = indexerHistory.length;
        const grabs = indexerHistory.filter(
          (record: any) =>
            record.eventType === 'grabbed' || record.successful === true
        ).length;

        // Calculate average response time for this indexer
        const responseTimes = indexerHistory
          .filter((record: any) => record.data && record.data.elapsedTime)
          .map((record: any) => parseInt(record.data.elapsedTime));
        const avgResponseTime =
          responseTimes.length > 0
            ? Math.round(
                responseTimes.reduce(
                  (acc: number, time: number) => acc + time,
                  0
                ) / responseTimes.length
              )
            : 0;

        // Calculate indexer performance metrics

        return {
          id: indexer.id,
          name: indexer.name,
          enable: indexer.enable,
          implementation: indexer.implementation,
          queries,
          grabs,
          successRate: queries > 0 ? Math.round((grabs / queries) * 100) : 0,
          avgResponseTime,
          categories: indexer.categories?.length || 0,
          priority: indexer.priority || 25,
        };
      });

      // Calculate user agent statistics (from history records)
      const userAgentStats: any = {};
      const queryTypeStats: any = {};
      const categoryStats: any = {};
      const responseTimeStats: any = [];
      const dailyStats: any = {};

      historyRecords.forEach((record: any) => {
        // User agent stats
        if (record.data && record.data.source) {
          const source = record.data.source.toLowerCase();
          if (!userAgentStats[source]) {
            userAgentStats[source] = {
              queries: 0,
              grabs: 0,
              avgResponseTime: 0,
              totalResponseTime: 0,
            };
          }
          userAgentStats[source].queries++;
          if (record.eventType === 'grabbed' || record.successful === true) {
            userAgentStats[source].grabs++;
          }
          if (record.data.elapsedTime) {
            userAgentStats[source].totalResponseTime += parseInt(
              record.data.elapsedTime
            );
            userAgentStats[source].avgResponseTime = Math.round(
              userAgentStats[source].totalResponseTime /
                userAgentStats[source].queries
            );
          }
        }

        // Query type statistics
        if (record.data && record.data.queryType) {
          const queryType = record.data.queryType;
          if (!queryTypeStats[queryType]) {
            queryTypeStats[queryType] = { count: 0, successful: 0 };
          }
          queryTypeStats[queryType].count++;
          if (record.successful) {
            queryTypeStats[queryType].successful++;
          }
        }

        // Category statistics
        if (record.data && record.data.categories) {
          const categories = record.data.categories.split(',');
          categories.forEach((cat: string) => {
            if (!categoryStats[cat]) {
              categoryStats[cat] = 0;
            }
            categoryStats[cat]++;
          });
        }

        // Response time tracking
        if (record.data && record.data.elapsedTime) {
          responseTimeStats.push({
            indexerId: record.indexerId,
            responseTime: parseInt(record.data.elapsedTime),
            date: record.date,
          });
        }

        // Daily statistics (for charts)
        const date = record.date.split('T')[0];
        if (!dailyStats[date]) {
          dailyStats[date] = { queries: 0, successful: 0 };
        }
        dailyStats[date].queries++;
        if (record.successful) {
          dailyStats[date].successful++;
        }
      });

      // Calculate average response time across all indexers
      const avgResponseTime =
        responseTimeStats.length > 0
          ? Math.round(
              responseTimeStats.reduce(
                (acc: number, stat: any) => acc + stat.responseTime,
                0
              ) / responseTimeStats.length
            )
          : 0;

      // Calculate time-based statistics
      const now = new Date();
      const timeBasedStats = {
        lastDay: { queries: 0, successful: 0, failed: 0 },
        lastWeek: { queries: 0, successful: 0, failed: 0 },
        last2Weeks: { queries: 0, successful: 0, failed: 0 },
        lastMonth: { queries: 0, successful: 0, failed: 0 },
        monthToDate: { queries: 0, successful: 0, failed: 0 },
      };

      historyRecords.forEach((record: any) => {
        const recordDate = new Date(record.date);
        const daysDiff = Math.floor(
          (now.getTime() - recordDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const successful = record.successful ? 1 : 0;
        const failed = !record.successful ? 1 : 0;

        // Last 24 hours
        if (daysDiff < 1) {
          timeBasedStats.lastDay.queries++;
          timeBasedStats.lastDay.successful += successful;
          timeBasedStats.lastDay.failed += failed;
        }

        // Last 7 days
        if (daysDiff < 7) {
          timeBasedStats.lastWeek.queries++;
          timeBasedStats.lastWeek.successful += successful;
          timeBasedStats.lastWeek.failed += failed;
        }

        // Last 14 days
        if (daysDiff < 14) {
          timeBasedStats.last2Weeks.queries++;
          timeBasedStats.last2Weeks.successful += successful;
          timeBasedStats.last2Weeks.failed += failed;
        }

        // Last 30 days
        if (daysDiff < 30) {
          timeBasedStats.lastMonth.queries++;
          timeBasedStats.lastMonth.successful += successful;
          timeBasedStats.lastMonth.failed += failed;
        }

        // Month to date
        if (recordDate >= monthStart) {
          timeBasedStats.monthToDate.queries++;
          timeBasedStats.monthToDate.successful += successful;
          timeBasedStats.monthToDate.failed += failed;
        }
      });

      // Calculate success rates for each time period
      Object.keys(timeBasedStats).forEach(period => {
        const stats = timeBasedStats[
          period as keyof typeof timeBasedStats
        ] as any;
        stats.successRate =
          stats.queries > 0
            ? Math.round((stats.successful / stats.queries) * 100)
            : 0;
      });

      return {
        totalIndexers,
        activeIndexers,
        inactiveIndexers,
        totalQueries,
        totalGrabs,
        successRate,
        avgResponseTime,
        grabsPerQuery:
          totalQueries > 0
            ? Math.round((totalGrabs / totalQueries) * 100) / 100
            : 0,
        indexerStats: indexerStats.sort((a, b) => b.queries - a.queries), // All indexers, not limited to 10
        userAgentStats,
        queryTypeStats,
        categoryStats: Object.entries(categoryStats)
          .sort(([, a]: [string, any], [, b]: [string, any]) => b - a)
          .slice(0, 20) // Top 20 categories
          .reduce((acc: any, [cat, count]) => {
            acc[cat] = count;
            return acc;
          }, {}),
        dailyStats: Object.entries(dailyStats)
          .sort(([a], [b]) => b.localeCompare(a)) // Most recent first
          .slice(0, 30) // Last 30 days
          .reduce((acc: any, [date, stats]) => {
            acc[date] = stats;
            return acc;
          }, {}),
        responseTimeStats: responseTimeStats.slice(0, 1000), // Sample for analysis
        implementations: indexers.reduce((acc: any, indexer: any) => {
          const impl = indexer.implementation || 'Unknown';
          acc[impl] = (acc[impl] || 0) + 1;
          return acc;
        }, {}),
        totalCategories: indexers.reduce(
          (acc: number, indexer: any) =>
            acc + (indexer.categories?.length || 0),
          0
        ),
        avgCategoriesPerIndexer:
          indexers.length > 0
            ? Math.round(
                indexers.reduce(
                  (acc: number, indexer: any) =>
                    acc + (indexer.categories?.length || 0),
                  0
                ) / indexers.length
              )
            : 0,
        applications: applications || [],
        downloadClients: downloadClients || [],
        systemStatus: systemStatus || {},
        health: health || [],
        tags: tags || [],
        notifications: notifications || [],
        totalHistoryRecords: historyRecords.length,
        // Enhanced analysis
        healthIssues: (health || []).filter(
          (h: any) => h.type === 'error' || h.type === 'warning'
        ).length,
        connectedApps: (applications || []).filter((app: any) => app.enable)
          .length,
        activeDownloadClients: (downloadClients || []).filter(
          (dc: any) => dc.enable
        ).length,
        systemUptime: systemStatus?.startTime
          ? Math.round(
              (Date.now() - new Date(systemStatus.startTime).getTime()) /
                (1000 * 60 * 60 * 24)
            )
          : 0,
        version: systemStatus?.version || 'Unknown',
        timeBasedStats,
      };
    } catch (error) {
      console.error('Error fetching Prowlarr statistics:', error);
      return {
        totalIndexers: 0,
        activeIndexers: 0,
        inactiveIndexers: 0,
        totalQueries: 0,
        totalGrabs: 0,
        successRate: 0,
        avgResponseTime: 0,
        grabsPerQuery: 0,
        indexerStats: [],
        userAgentStats: {},
        implementations: {},
        totalCategories: 0,
        avgCategoriesPerIndexer: 0,
      };
    }
  }
}

export class ApiClientManager {
  private sonarrClient?: SonarrClient;
  private radarrClient?: RadarrClient;
  private prowlarrClient?: ProwlarrClient;

  constructor(private config: AppConfig) {
    this.updateClients(config);
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
    this.updateClients(config);
  }

  private updateClients(config: AppConfig): void {
    if (config.sonarr.baseUrl && config.sonarr.apiKey) {
      this.sonarrClient = new SonarrClient(config.sonarr);
    }

    if (config.radarr.baseUrl && config.radarr.apiKey) {
      this.radarrClient = new RadarrClient(config.radarr);
    }

    if (config.prowlarr.baseUrl && config.prowlarr.apiKey) {
      this.prowlarrClient = new ProwlarrClient(config.prowlarr);
    }
  }

  get sonarr(): SonarrClient {
    if (!this.sonarrClient) {
      throw new ApiError('Sonarr client not configured');
    }
    return this.sonarrClient;
  }

  get radarr(): RadarrClient {
    if (!this.radarrClient) {
      throw new ApiError('Radarr client not configured');
    }
    return this.radarrClient;
  }

  get prowlarr(): ProwlarrClient {
    if (!this.prowlarrClient) {
      throw new ApiError('Prowlarr client not configured');
    }
    return this.prowlarrClient;
  }

  isConfigured(service: 'sonarr' | 'radarr' | 'prowlarr'): boolean {
    switch (service) {
      case 'sonarr':
        return !!(this.config.sonarr.baseUrl && this.config.sonarr.apiKey);
      case 'radarr':
        return !!(this.config.radarr.baseUrl && this.config.radarr.apiKey);
      case 'prowlarr':
        return !!(this.config.prowlarr.baseUrl && this.config.prowlarr.apiKey);
      default:
        return false;
    }
  }

  clearCache(): void {
    this.sonarrClient?.['clearCache']();
    this.radarrClient?.['clearCache']();
    this.prowlarrClient?.['clearCache']();
  }
}
