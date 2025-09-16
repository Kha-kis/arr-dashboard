import { ApiClientManager } from './api';

export interface MediaInfo {
  series: string;
  episode: string;
  year?: string;
  overview?: string;
}

export interface BatchLookupCache {
  series: Map<number, any>;
  movies: Map<number, any>;
  episodes: Map<number, Map<number, any>>; // seriesId -> Map<episodeId, episode>
  mediaInfo: Map<string, MediaInfo>;
}

export interface HistoryRecord {
  id: number;
  seriesId?: number;
  movieId?: number;
  episodeId?: number;
  title?: string;
  service: string;
}

export class BatchLookupService {
  private cache: BatchLookupCache;
  private cacheExpiry: number = 10 * 60 * 1000; // 10 minutes
  private lastCacheUpdate: number = 0;

  constructor(private apiManager: ApiClientManager) {
    this.cache = {
      series: new Map(),
      movies: new Map(),
      episodes: new Map(),
      mediaInfo: new Map(),
    };
  }

  /**
   * Preload data smartly based on what's actually needed
   * Only loads data for services that have records in history
   */
  async preloadData(recordsHint?: any[]): Promise<void> {
    console.log('🚀 Starting smart batch preload...');
    const startTime = Date.now();

    // Check what services are actually needed based on records
    const needsSonarr =
      !recordsHint || recordsHint.some(r => r.service === 'sonarr');
    const needsRadarr =
      !recordsHint || recordsHint.some(r => r.service === 'radarr');

    const loadPromises: Promise<void>[] = [];

    // Only load Sonarr data if we have Sonarr records
    if (this.apiManager.isConfigured('sonarr') && needsSonarr) {
      console.log('📺 Loading Sonarr data (found TV records)...');
      loadPromises.push(this.preloadSeriesData());
    } else if (this.apiManager.isConfigured('sonarr')) {
      console.log('ℹ️ Skipping Sonarr preload (no TV records found)');
    }

    // Only load Radarr data if we have Radarr records (with delay)
    if (this.apiManager.isConfigured('radarr') && needsRadarr) {
      console.log('🎥 Loading Radarr data (found movie records)...');
      loadPromises.push(this.delayedPreloadMovieData());
    } else if (this.apiManager.isConfigured('radarr')) {
      console.log('ℹ️ Skipping Radarr preload (no movie records found)');
    }

    if (loadPromises.length === 0) {
      console.log('⚡ No preloading needed - using fallback parsing only');
      return;
    }

    await Promise.allSettled(loadPromises);

    this.lastCacheUpdate = Date.now();
    const totalTime = Date.now() - startTime;
    console.log(`🏁 Smart preload completed in ${totalTime}ms`);
    console.log(
      `📊 Cache status: ${this.cache.series.size} series, ${this.cache.movies.size} movies`
    );

    if (
      loadPromises.length > 0 &&
      this.cache.series.size === 0 &&
      this.cache.movies.size === 0
    ) {
      console.warn(
        '⚠️ No data was preloaded due to rate limiting - fallback parsing will be used'
      );
    }
  }

  private async delayedPreloadMovieData(): Promise<void> {
    // Add 1 second delay to avoid simultaneous API calls
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.preloadMovieData();
  }

  private async preloadSeriesData(): Promise<void> {
    try {
      console.log('Attempting to load Sonarr series...');
      const series = await this.apiManager.sonarr.getSeries();
      this.cache.series.clear();
      series.forEach(s => this.cache.series.set(s.id, s));
      console.log(`✅ Preloaded ${series.length} series from Sonarr`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message &&
        error.message.includes('Rate limit')
      ) {
        console.warn(
          '⚠️ Sonarr rate limit hit during series preload - will retry later or use fallback parsing'
        );
        // Don't throw - allow the system to continue with fallback parsing
      } else {
        console.error('❌ Failed to preload series data:', error);
      }
    }
  }

  private async preloadMovieData(): Promise<void> {
    try {
      console.log('Attempting to load Radarr movies...');
      const movies = await this.apiManager.radarr.getMovies();
      this.cache.movies.clear();
      movies.forEach(m => this.cache.movies.set(m.id, m));
      console.log(`✅ Preloaded ${movies.length} movies from Radarr`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message &&
        error.message.includes('Rate limit')
      ) {
        console.warn(
          '⚠️ Radarr rate limit hit during movie preload - will retry later or use fallback parsing'
        );
        // Don't throw - allow the system to continue with fallback parsing
      } else {
        console.error('❌ Failed to preload movie data:', error);
      }
    }
  }

  /**
   * Batch load episode data for multiple series
   * This is called when we identify series in history that need episode info
   */
  async batchLoadEpisodes(seriesIds: number[]): Promise<void> {
    if (!this.apiManager.isConfigured('sonarr') || seriesIds.length === 0) {
      return;
    }

    // Filter out series we already have episode data for
    const seriesToFetch = seriesIds.filter(id => !this.cache.episodes.has(id));

    if (seriesToFetch.length === 0) {
      console.log('💾 All requested series episodes already cached');
      return;
    }

    console.log(
      `📺 Batch loading episodes for ${seriesToFetch.length} series...`
    );

    try {
      const episodeMap =
        await this.apiManager.sonarr.getEpisodesBySeriesIds(seriesToFetch);

      // Store in our cache structure
      episodeMap.forEach((episodes, seriesId) => {
        const episodeIdMap = new Map();
        episodes.forEach(ep => episodeIdMap.set(ep.id, ep));
        this.cache.episodes.set(seriesId, episodeIdMap);
      });

      console.log(`✅ Batch loaded episodes for ${episodeMap.size} series`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message &&
        error.message.includes('Rate limit')
      ) {
        console.warn(
          '⚠️ Rate limit hit during episode batch loading - some episode info may use fallback parsing'
        );
        // Don't throw - allow the system to continue with fallback parsing
      } else {
        console.error('❌ Failed to batch load episodes:', error);
      }
    }
  }

  /**
   * Resolve media information for history records efficiently using cached data
   */
  async resolveMediaInfo(
    records: HistoryRecord[]
  ): Promise<Map<string, MediaInfo>> {
    const results = new Map<string, MediaInfo>();

    // Check if cache needs refresh
    if (Date.now() - this.lastCacheUpdate > this.cacheExpiry) {
      console.log('Cache expired, refreshing...');
      await this.preloadData();
    }

    // Collect all series IDs that need episode data
    const seriesNeedingEpisodes = new Set<number>();
    records.forEach(record => {
      if (record.service === 'sonarr' && record.seriesId && record.episodeId) {
        seriesNeedingEpisodes.add(record.seriesId);
      }
    });

    // Batch load episode data for series that need it
    if (seriesNeedingEpisodes.size > 0) {
      await this.batchLoadEpisodes(Array.from(seriesNeedingEpisodes));
    }

    // Resolve each record
    for (const record of records) {
      const cacheKey = `${record.service}-${record.id}`;

      // Check if already cached
      if (this.cache.mediaInfo.has(cacheKey)) {
        results.set(cacheKey, this.cache.mediaInfo.get(cacheKey)!);
        continue;
      }

      let mediaInfo: MediaInfo;

      if (record.service === 'sonarr' && record.seriesId) {
        mediaInfo = await this.resolveSonarrRecord(record);
      } else if (record.service === 'radarr' && record.movieId) {
        mediaInfo = await this.resolveRadarrRecord(record);
      } else {
        mediaInfo = this.parseFallbackInfo(record);
      }

      // Cache the result
      this.cache.mediaInfo.set(cacheKey, mediaInfo);
      results.set(cacheKey, mediaInfo);
    }

    return results;
  }

  private async resolveSonarrRecord(record: HistoryRecord): Promise<MediaInfo> {
    const series = this.cache.series.get(record.seriesId!);

    if (!series) {
      return this.parseFallbackInfo(record);
    }

    let episodeInfo = 'Episode';

    // Try to get episode info if we have the episode ID
    if (record.episodeId && this.cache.episodes.has(record.seriesId!)) {
      const episodes = this.cache.episodes.get(record.seriesId!)!;
      const episode = episodes.get(record.episodeId);

      if (episode) {
        episodeInfo = `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
        if (episode.title) {
          episodeInfo += ` - ${episode.title}`;
        }
      }
    }

    // Fallback to parsing from source title if no episode data
    if (episodeInfo === 'Episode' && record.title) {
      const seasonEpisodeMatch = record.title.match(/S(\d+)E(\d+)/);
      if (seasonEpisodeMatch) {
        const [, season, episode] = seasonEpisodeMatch;
        episodeInfo = `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;

        // Try to extract episode title
        const titleMatch = record.title.match(
          /S\d+E\d+[\s\-.]*([^([\d.]+(?:[\s\-.][^([\d.]+)*)/i
        );
        if (titleMatch) {
          let episodeTitle = titleMatch[1].replace(/[._]/g, ' ').trim();
          episodeTitle = episodeTitle
            .replace(/\b(\d{4}p|WEB-?DL|BluRay|HDTV).*$/i, '')
            .trim();
          if (episodeTitle && episodeTitle.length > 2) {
            episodeInfo += ` - ${episodeTitle}`;
          }
        }
      }
    }

    return {
      series: series.title,
      episode: episodeInfo,
      year: series.year?.toString(),
      overview: series.overview,
    };
  }

  private async resolveRadarrRecord(record: HistoryRecord): Promise<MediaInfo> {
    const movie = this.cache.movies.get(record.movieId!);

    if (!movie) {
      return this.parseFallbackInfo(record);
    }

    return {
      series: movie.title,
      episode: movie.year ? `(${movie.year})` : 'Movie',
      year: movie.year?.toString(),
      overview: movie.overview,
    };
  }

  private parseFallbackInfo(record: HistoryRecord): MediaInfo {
    if (!record.title) {
      return {
        series: record.service === 'sonarr' ? 'TV Show' : 'Movie',
        episode: record.service === 'sonarr' ? 'Episode' : 'Movie',
      };
    }

    if (record.service === 'sonarr') {
      // Try to parse series and episode from title
      const seasonEpisodeMatch = record.title.match(/(.+?)[.\s]+S(\d+)E(\d+)/);
      if (seasonEpisodeMatch) {
        const [, seriesName, season, episode] = seasonEpisodeMatch;
        return {
          series: seriesName.replace(/[.]/g, ' ').trim(),
          episode: `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`,
        };
      }
    } else if (record.service === 'radarr') {
      // Try to parse movie and year from title
      const yearMatch = record.title.match(/(.+?)[.\s]+(\d{4})/);
      if (yearMatch) {
        const [, movieName, year] = yearMatch;
        return {
          series: movieName.replace(/[.]/g, ' ').trim(),
          episode: `(${year})`,
          year,
        };
      }
    }

    // Ultimate fallback
    const cleanTitle = record.title.replace(/[.]/g, ' ').trim();
    return {
      series:
        cleanTitle.length > 40
          ? cleanTitle.substring(0, 40) + '...'
          : cleanTitle,
      episode: record.service === 'sonarr' ? 'Episode' : 'Movie',
    };
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.series.clear();
    this.cache.movies.clear();
    this.cache.episodes.clear();
    this.cache.mediaInfo.clear();
    this.lastCacheUpdate = 0;
    console.log('Batch lookup cache cleared');
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): {
    series: number;
    movies: number;
    episodes: number;
    mediaInfo: number;
    lastUpdate: Date | null;
  } {
    return {
      series: this.cache.series.size,
      movies: this.cache.movies.size,
      episodes: this.cache.episodes.size,
      mediaInfo: this.cache.mediaInfo.size,
      lastUpdate: this.lastCacheUpdate ? new Date(this.lastCacheUpdate) : null,
    };
  }
}
