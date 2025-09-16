import * as React from 'react';
import { useState, useMemo, useCallback } from 'react';
import { Card, CardContent, LoadingState } from '@/components/ui';
import { getStatusBadge, StatusType } from '@/utils/colors';
import { useEnhancedHistory, useProwlarrHistory } from '@/hooks';
import { useAppStore } from '@/store';
import { DownloadHistoryItem } from '@/types';
import {
  Search,
  Filter,
  Download,
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  HardDrive,
  Zap,
  MoreHorizontal,
  Calendar,
  Database,
  TrendingUp,
  Activity,
  FileDown,
  Film,
  Monitor,
} from 'lucide-react';

interface HistoryFilters {
  search: string;
  service: 'downloads' | 'all' | 'sonarr' | 'radarr' | 'prowlarr';
  status: string;
  protocol: string;
  dateFrom: string;
  dateTo: string;
}

interface EnhancedHistoryItem extends DownloadHistoryItem {
  service: string;
  seriesId?: number;
  movieId?: number;
  episodeId?: number;
};

export const HistoryPage = (): JSX.Element => {
  const { apiManager } = useAppStore();
  const [currentPage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [sortColumn, setSortColumn] = useState<string>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [showFilters, setShowFilters] = useState(false);
  const [itemsPerPage] = useState(50);
  const [currentPageView, setCurrentPageView] = useState(1);
  const [filters, setFilters] = useState<HistoryFilters>({
    search: '',
    service: 'downloads',
    status: '',
    protocol: '',
    dateFrom: '',
    dateTo: '',
  });

  // Simple data fetching with moderate batch sizes
  const sonarrHistory = useEnhancedHistory('sonarr', 1, 200);
  const radarrHistory = useEnhancedHistory('radarr', 1, 200);
  const prowlarrHistory = useProwlarrHistory(currentPage, 50);

  // Check which services are configured
  const servicesConfigured = {
    sonarr: apiManager?.isConfigured('sonarr') || false,
    radarr: apiManager?.isConfigured('radarr') || false,
    prowlarr: apiManager?.isConfigured('prowlarr') || false,
  };

  const calculateAnalytics = useCallback((records: EnhancedHistoryItem[]) => {
    const total = records.length;
    const successful = records.filter(
      r => r.status === 'imported' || r.status === 'grabbed'
    ).length;
    const failed = records.filter(r => r.status === 'failed').length;
    const deleted = records.filter(r => r.status === 'deleted').length;
    const unknown = records.filter(r => r.status === 'unknown').length;

    const completedOrFailed = successful + failed;
    const successRate =
      completedOrFailed > 0
        ? Math.round((successful / completedOrFailed) * 100)
        : 0;

    const indexerStats = records.reduce(
      (acc, record) => {
        if (record.indexer && record.indexer !== 'N/A') {
          acc[record.indexer] = (acc[record.indexer] || 0) + 1;
        }
        return acc;
      },
      {} as Record<string, number>
    );

    return {
      total,
      successful,
      failed,
      deleted,
      unknown,
      successRate,
      topIndexers: Object.entries(indexerStats)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([name, count]) => ({ name, count })),
    };
  }, []);

  // Enhanced title parsing function with episode name extraction
  const parseMediaTitle = useCallback((title: string, service: string) => {
    if (!title)
      return { series: 'Unknown', episode: 'Unknown', episodeName: null };

    // Remove file paths and clean up
    let cleanTitle = title;

    // If it's a file path, extract the filename
    if (cleanTitle.includes('/') || cleanTitle.includes('\\')) {
      const pathParts = cleanTitle.split(/[/\\]/);
      cleanTitle =
        pathParts[pathParts.length - 1] ||
        pathParts[pathParts.length - 2] ||
        cleanTitle;
    }

    // Remove file extensions
    cleanTitle = cleanTitle.replace(
      /\.(mkv|mp4|avi|m4v|wmv|mov|flv|webm)$/i,
      ''
    );

    if (service === 'sonarr') {
      // Pattern 1: Series Name S01E01 Episode Title
      let match = cleanTitle.match(
        /^(.+?)[\.\s]+S(\d+)E(\d+)[\.\s]+(.+?)(?:[\s\.]+(\d{4}|PROPER|REPACK|\d+p|x264|x265|HEVC|HDR|WEB|WEBDL|BluRay|BDRip|DVDRip|hdtv).*)?$/i
      );
      if (match) {
        const [, seriesName, season, episode, episodeTitle] = match;
        const cleanSeries = seriesName
          .replace(/[\._]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const cleanEpisodeTitle = episodeTitle
          ? episodeTitle.replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim()
          : null;

        return {
          series: cleanSeries,
          episode: `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`,
          episodeName: cleanEpisodeTitle,
        };
      }

      // Pattern 2: Series Name (YEAR) S01E01 Episode Title
      match = cleanTitle.match(
        /^(.+?)\s*\((\d{4})\)[\.\s]+S(\d+)E(\d+)[\.\s]+(.+?)(?:[\s\.]+(PROPER|REPACK|\d+p|x264|x265|HEVC|HDR|WEB|WEBDL|BluRay|BDRip|DVDRip|hdtv).*)?$/i
      );
      if (match) {
        const [, seriesName, year, season, episode, episodeTitle] = match;
        const cleanSeries = seriesName
          .replace(/[\._]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const cleanEpisodeTitle = episodeTitle
          ? episodeTitle.replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim()
          : null;

        return {
          series: `${cleanSeries} (${year})`,
          episode: `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`,
          episodeName: cleanEpisodeTitle,
        };
      }

      // Pattern 3: Just Series Name S01E01 (no episode title)
      match = cleanTitle.match(/^(.+?)[\.\s]*S(\d+)E(\d+)/i);
      if (match) {
        const [, seriesName, season, episode] = match;
        const cleanSeries = seriesName
          .replace(/[\._]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        // Try to extract episode name from the remaining part
        const remainingTitle = cleanTitle.replace(match[0], '').trim();
        let episodeTitle = null;

        if (remainingTitle) {
          // Remove common release info patterns
          const cleanRemaining = remainingTitle
            .replace(/^[\._\s-]+/, '') // Remove leading separators
            .replace(
              /[\._\s]+(\d{4}|PROPER|REPACK|\d+p|x264|x265|HEVC|HDR|WEB|WEBDL|BluRay|BDRip|DVDRip|hdtv).*$/i,
              ''
            ) // Remove release info
            .replace(/[\._]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          if (cleanRemaining.length > 2 && cleanRemaining.length < 100) {
            episodeTitle = cleanRemaining;
          }
        }

        return {
          series: cleanSeries,
          episode: `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`,
          episodeName: episodeTitle,
        };
      }

      // Pattern 4: Series Name with year in parentheses
      match = cleanTitle.match(/^(.+?)\s*\((\d{4})\)/i);
      if (match) {
        const [, seriesName] = match;
        const cleanSeries = seriesName
          .replace(/[\._]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        // Look for season/episode in remaining text
        const episodeMatch = cleanTitle.match(/S(\d+)E(\d+)/i);
        if (episodeMatch) {
          const [, season, episode] = episodeMatch;
          return {
            series: `${cleanSeries} (${match[2]})`,
            episode: `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`,
            episodeName: null,
          };
        }
      }
    } else if (service === 'radarr') {
      // Pattern for movies: Movie Name (YEAR) or Movie Name YEAR
      const match = cleanTitle.match(/^(.+?)\s*[([]?(\d{4})[)\]]?/i);
      if (match) {
        const [, movieName, year] = match;
        return {
          series: movieName.replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim(),
          episode: `(${year})`,
          episodeName: null,
        };
      }

      // Fallback: just clean the title
      const movieName = cleanTitle
        .replace(/[\._]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (movieName.length > 0) {
        return {
          series:
            movieName.length > 50
              ? movieName.substring(0, 50) + '...'
              : movieName,
          episode: 'Movie',
          episodeName: null,
        };
      }
    }

    // Fallback cleaning
    const fallbackTitle = cleanTitle
      .replace(/[\._]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      series:
        fallbackTitle.length > 50
          ? fallbackTitle.substring(0, 50) + '...'
          : fallbackTitle,
      episode:
        service === 'sonarr'
          ? 'Episode'
          : service === 'radarr'
            ? 'Movie'
            : 'Unknown',
      episodeName: null,
    };
  }, []);

  // Deduplication function
  const deduplicateRecords = useCallback((records: EnhancedHistoryItem[]) => {
    const seen = new Map<string, EnhancedHistoryItem>();

    return records.filter(record => {
      // Create a unique key based on title, status, size, and date (to nearest minute)
      const date = new Date(record.date || 0);
      const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
      const key = `${record.title}-${record.status}-${record.size}-${dateKey}`;

      if (seen.has(key)) {
        // Keep the record with more complete data or the latest one
        const existing = seen.get(key)!;
        if (
          record.downloadClient !== 'N/A' &&
          existing.downloadClient === 'N/A'
        ) {
          seen.set(key, record);
          return true;
        }
        return false;
      }

      seen.set(key, record);
      return true;
    });
  }, []);

  // Combine and filter data efficiently
  const processedData = useMemo(() => {
    const allRecords: EnhancedHistoryItem[] = [];
    let totalRecords = 0;

    // Add Sonarr records
    if (
      (filters.service === 'downloads' ||
        filters.service === 'all' ||
        filters.service === 'sonarr') &&
      sonarrHistory.data &&
      servicesConfigured.sonarr
    ) {
      const records = sonarrHistory.data.records || [];
      allRecords.push(
        ...records.map((record: DownloadHistoryItem) => ({
          id: record.id,
          downloadId: record.downloadId || record.id?.toString(),
          title: record.sourceTitle || record.data?.path || 'Unknown',
          size: parseInt(record.data?.size || '0') || 0,
          quality: record.quality || { name: 'N/A' },
          status: (record.eventType === 'downloadFolderImported'
            ? 'imported'
            : record.eventType === 'downloadFailed'
              ? 'failed'
              : record.eventType === 'grabbed'
                ? 'grabbed'
                : record.eventType === 'episodeFileDeleted'
                  ? 'deleted'
                  : 'unknown') as
            | 'completed'
            | 'failed'
            | 'deleted'
            | 'imported'
            | 'grabbed'
            | 'unknown',
          downloadClient:
            record.data?.downloadClientName ||
            record.data?.downloadClient ||
            'N/A',
          indexer: record.data?.indexer || 'N/A',
          protocol: record.data?.protocol || 'N/A',
          date: record.date,
          reason: record.data?.releaseGroup || '',
          service: 'sonarr',
          seriesId: record.seriesId,
          episodeId: record.episodeId,
        }))
      );
    }

    // Add Radarr records
    if (
      (filters.service === 'downloads' ||
        filters.service === 'all' ||
        filters.service === 'radarr') &&
      radarrHistory.data &&
      servicesConfigured.radarr
    ) {
      const records = radarrHistory.data.records || [];
      allRecords.push(
        ...records.map((record: DownloadHistoryItem) => ({
          id: record.id,
          downloadId: record.downloadId || record.id?.toString(),
          title: record.sourceTitle || record.data?.path || 'Unknown',
          size: parseInt(record.data?.size || '0') || 0,
          quality: record.quality || { name: 'N/A' },
          status: (record.eventType === 'downloadFolderImported'
            ? 'imported'
            : record.eventType === 'downloadFailed'
              ? 'failed'
              : record.eventType === 'grabbed'
                ? 'grabbed'
                : record.eventType === 'movieFileDeleted'
                  ? 'deleted'
                  : 'unknown') as
            | 'completed'
            | 'failed'
            | 'deleted'
            | 'imported'
            | 'grabbed'
            | 'unknown',
          downloadClient:
            record.data?.downloadClientName ||
            record.data?.downloadClient ||
            'N/A',
          indexer: record.data?.indexer || 'N/A',
          protocol: record.data?.protocol || 'N/A',
          date: record.date,
          reason: record.data?.releaseGroup || '',
          service: 'radarr',
          movieId: record.movieId,
        }))
      );
    }

    // Add Prowlarr records (only when specifically selected)
    if (
      (filters.service === 'all' || filters.service === 'prowlarr') &&
      prowlarrHistory.data &&
      servicesConfigured.prowlarr
    ) {
      const records = prowlarrHistory.data.records || [];
      allRecords.push(
        ...records.map((record: any) => ({
          id: record.id,
          downloadId: record.id?.toString(),
          title: record.data?.query || record.data?.source || 'Indexer Query',
          size: 0,
          quality: { name: record.data?.queryType || 'N/A' },
          status: record.successful ? 'completed' : 'failed',
          downloadClient: 'N/A',
          indexer: 'Indexer ID: ' + record.indexerId,
          protocol: 'N/A',
          date: record.date,
          reason: record.data?.queryResults
            ? `${record.data.queryResults} results`
            : '',
          service: 'prowlarr',
        }))
      );
    }

    // Apply deduplication first
    let filteredRecords = deduplicateRecords(allRecords);

    // Apply client-side filters
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      filteredRecords = filteredRecords.filter(record => {
        const mediaInfo = parseMediaTitle(record.title || '', record.service);
        return (
          record.title?.toLowerCase().includes(searchLower) ||
          record.downloadId?.toLowerCase().includes(searchLower) ||
          record.indexer?.toLowerCase().includes(searchLower) ||
          mediaInfo.series?.toLowerCase().includes(searchLower) ||
          mediaInfo.episode?.toLowerCase().includes(searchLower) ||
          mediaInfo.episodeName?.toLowerCase().includes(searchLower)
        );
      });
    }

    if (filters.status) {
      filteredRecords = filteredRecords.filter(
        record => record.status === filters.status
      );
    }

    if (filters.dateFrom || filters.dateTo) {
      filteredRecords = filteredRecords.filter(record => {
        if (!record.date) return false;
        const recordDate = new Date(record.date);
        if (filters.dateFrom && recordDate < new Date(filters.dateFrom))
          return false;
        if (
          filters.dateTo &&
          recordDate > new Date(filters.dateTo + 'T23:59:59')
        )
          return false;
        return true;
      });
    }

    // Sort records
    filteredRecords.sort((a, b) => {
      let aVal: any = a[sortColumn as keyof EnhancedHistoryItem];
      let bVal: any = b[sortColumn as keyof EnhancedHistoryItem];

      if (sortColumn === 'date') {
        aVal = new Date(aVal || 0).getTime();
        bVal = new Date(bVal || 0).getTime();
      } else if (sortColumn === 'size') {
        aVal = aVal || 0;
        bVal = bVal || 0;
      } else {
        aVal = String(aVal || '').toLowerCase();
        bVal = String(bVal || '').toLowerCase();
      }

      if (sortDirection === 'asc') {
        return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
      } else {
        return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
      }
    });

    totalRecords = filteredRecords.length;

    // Paginate results
    const startIndex = (currentPageView - 1) * itemsPerPage;
    const paginatedRecords = filteredRecords.slice(
      startIndex,
      startIndex + itemsPerPage
    );
    const totalPages = Math.ceil(totalRecords / itemsPerPage);

    return {
      records: paginatedRecords,
      totalRecords,
      totalPages,
      currentPage: currentPageView,
      hasMore: totalRecords > startIndex + itemsPerPage,
      analytics: calculateAnalytics(filteredRecords),
    };
  }, [
    sonarrHistory.data,
    radarrHistory.data,
    prowlarrHistory.data,
    filters,
    sortColumn,
    sortDirection,
    servicesConfigured,
    calculateAnalytics,
    deduplicateRecords,
    parseMediaTitle,
    currentPageView,
    itemsPerPage,
  ]);

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const toggleRowExpansion = (id: number) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedRows(newExpanded);
  };

  const formatBytes = (bytes: number) => {
    if (!bytes) return 'N/A';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleString();
  };

  const getStatusIcon = (status: string): JSX.Element => {
    switch (status) {
      case 'imported':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'grabbed':
        return <Download className="w-4 h-4 text-blue-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'deleted':
        return <XCircle className="w-4 h-4 text-orange-500" />;
      default:
        return <Clock className="w-4 h-4 text-gray-500" />;
    }
  };

  const getServiceIcon = (service: string): JSX.Element => {
    switch (service) {
      case 'sonarr':
        return (
          <div
            className="w-6 h-6 bg-sonarr text-sonarr-foreground rounded text-xs font-bold flex items-center justify-center"
            title="Sonarr (TV Shows)"
          >
            TV
          </div>
        );
      case 'radarr':
        return (
          <div
            className="w-6 h-6 bg-radarr text-radarr-foreground rounded text-xs font-bold flex items-center justify-center"
            title="Radarr (Movies)"
          >
            M
          </div>
        );
      case 'prowlarr':
        return (
          <div
            className="w-6 h-6 bg-prowlarr text-prowlarr-foreground rounded text-xs font-bold flex items-center justify-center"
            title="Prowlarr (Indexers)"
          >
            P
          </div>
        );
      default:
        return <MoreHorizontal className="w-4 h-4" />;
    }
  };

  const isLoading =
    sonarrHistory.isLoading ||
    radarrHistory.isLoading ||
    prowlarrHistory.isLoading;
  const hasError =
    sonarrHistory.error || radarrHistory.error || prowlarrHistory.error;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      <div className="container mx-auto px-4 py-8 space-y-8">
        {/* Header Section */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              Download History
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-2">
              Track your downloads across all services with enhanced filtering
              and analytics
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isLoading && (
              <LoadingState
                variant="inline"
                size="sm"
                message="Loading..."
                className="px-4 py-2 bg-info-muted rounded-lg"
              />
            )}
          </div>
        </div>

        {/* Analytics Dashboard */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
          <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 border-blue-200 dark:border-blue-700">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
                    Total Records
                  </p>
                  <p className="text-3xl font-bold text-blue-700 dark:text-blue-300">
                    {processedData.analytics.total}
                  </p>
                </div>
                <Database className="w-8 h-8 text-blue-500" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20 border-green-200 dark:border-green-700">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-green-600 dark:text-green-400">
                    Successful
                  </p>
                  <p className="text-3xl font-bold text-green-700 dark:text-green-300">
                    {processedData.analytics.successful}
                  </p>
                </div>
                <CheckCircle className="w-8 h-8 text-green-500" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-red-50 to-red-100 dark:from-red-900/20 dark:to-red-800/20 border-red-200 dark:border-red-700">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">
                    Failed
                  </p>
                  <p className="text-3xl font-bold text-red-700 dark:text-red-300">
                    {processedData.analytics.failed}
                  </p>
                </div>
                <XCircle className="w-8 h-8 text-red-500" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 border-purple-200 dark:border-purple-700">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-purple-600 dark:text-purple-400">
                    Success Rate
                  </p>
                  <p className="text-3xl font-bold text-purple-700 dark:text-purple-300">
                    {processedData.analytics.successRate}%
                  </p>
                </div>
                <TrendingUp className="w-8 h-8 text-purple-500" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-indigo-50 to-indigo-100 dark:from-indigo-900/20 dark:to-indigo-800/20 border-indigo-200 dark:border-indigo-700">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
                    Displayed
                  </p>
                  <p className="text-3xl font-bold text-indigo-700 dark:text-indigo-300">
                    {processedData.records.length}
                  </p>
                </div>
                <Activity className="w-8 h-8 text-indigo-500" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search & Filter Controls */}
        <Card className="backdrop-blur-sm bg-white/80 dark:bg-slate-900/80 shadow-xl border-0">
          <CardContent className="p-6">
            {/* Search Bar */}
            <div className="relative mb-6">
              <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                placeholder="Search by title, series, movie, or indexer..."
                value={filters.search}
                onChange={e =>
                  setFilters(prev => ({ ...prev, search: e.target.value }))
                }
                className="w-full pl-12 pr-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>

            {/* Service Filter Tabs */}
            <div className="flex flex-wrap gap-2 mb-6">
              <button
                onClick={() =>
                  setFilters(prev => ({ ...prev, service: 'downloads' }))
                }
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  filters.service === 'downloads'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                <FileDown className="w-4 h-4 inline mr-2" />
                Downloads Only
              </button>

              <button
                onClick={() =>
                  setFilters(prev => ({ ...prev, service: 'all' }))
                }
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  filters.service === 'all'
                    ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-700'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                <Activity className="w-4 h-4 inline mr-2" />
                All Events
              </button>

              {servicesConfigured.sonarr && (
                <button
                  onClick={() =>
                    setFilters(prev => ({ ...prev, service: 'sonarr' }))
                  }
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${
                    filters.service === 'sonarr'
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  <Monitor className="w-4 h-4 inline mr-2" />
                  TV Shows
                </button>
              )}

              {servicesConfigured.radarr && (
                <button
                  onClick={() =>
                    setFilters(prev => ({ ...prev, service: 'radarr' }))
                  }
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${
                    filters.service === 'radarr'
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-700'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  <Film className="w-4 h-4 inline mr-2" />
                  Movies
                </button>
              )}

              {servicesConfigured.prowlarr && (
                <button
                  onClick={() =>
                    setFilters(prev => ({ ...prev, service: 'prowlarr' }))
                  }
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${
                    filters.service === 'prowlarr'
                      ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-700'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  <Search className="w-4 h-4 inline mr-2" />
                  Indexers
                </button>
              )}
            </div>

            {/* Advanced Filters Toggle */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="flex items-center gap-2 px-4 py-2 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
              >
                <Filter className="w-4 h-4" />
                <span>Advanced Filters</span>
                {showFilters ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>

              {(filters.status || filters.dateFrom || filters.dateTo) && (
                <button
                  onClick={() =>
                    setFilters(prev => ({
                      ...prev,
                      status: '',
                      dateFrom: '',
                      dateTo: '',
                    }))
                  }
                  className="text-sm text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                >
                  Clear Filters
                </button>
              )}
            </div>

            {/* Advanced Filters */}
            {showFilters && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    Status
                  </label>
                  <select
                    value={filters.status}
                    onChange={e =>
                      setFilters(prev => ({ ...prev, status: e.target.value }))
                    }
                    className="w-full p-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">All Statuses</option>
                    <option value="imported">✅ Imported</option>
                    <option value="grabbed">📥 Grabbed</option>
                    <option value="failed">❌ Failed</option>
                    <option value="deleted">🗑️ Deleted</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    From Date
                  </label>
                  <input
                    type="date"
                    value={filters.dateFrom}
                    onChange={e =>
                      setFilters(prev => ({
                        ...prev,
                        dateFrom: e.target.value,
                      }))
                    }
                    className="w-full p-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    To Date
                  </label>
                  <input
                    type="date"
                    value={filters.dateTo}
                    onChange={e =>
                      setFilters(prev => ({ ...prev, dateTo: e.target.value }))
                    }
                    className="w-full p-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* History Cards Grid */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200">
              Recent Activity
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleSort('date')}
                className="flex items-center gap-2 px-3 py-2 text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                <Calendar className="w-4 h-4" />
                Date
                {sortColumn === 'date'
                  ? sortDirection === 'asc'
                    ? ' ↑'
                    : ' ↓'
                  : ''}
              </button>
              <button
                onClick={() => handleSort('size')}
                className="flex items-center gap-2 px-3 py-2 text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                <HardDrive className="w-4 h-4" />
                Size
                {sortColumn === 'size'
                  ? sortDirection === 'asc'
                    ? ' ↑'
                    : ' ↓'
                  : ''}
              </button>
            </div>
          </div>

          {hasError && (
            <Card className="border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20">
              <CardContent className="p-6">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-6 h-6 text-red-500" />
                  <div>
                    <h3 className="font-semibold text-red-800 dark:text-red-200">
                      Error Loading History
                    </h3>
                    <p className="text-red-600 dark:text-red-400 text-sm mt-1">
                      There was an issue loading your download history. Please
                      check your service connections.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Loading State */}
          {isLoading && !processedData.records.length && (
            <LoadingState variant="skeleton" count={6} className="space-y-4" />
          )}

          {/* History Cards */}
          {!isLoading && processedData.records.length > 0 && (
            <div className="grid gap-4">
              {processedData.records.map(record => {
                const mediaInfo = parseMediaTitle(
                  record.title || '',
                  record.service
                );
                const isExpanded = expandedRows.has(record.id);

                return (
                  <Card
                    key={`${record.service}-${record.id}`}
                    className="group hover:shadow-lg transition-all duration-200 bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                  >
                    <CardContent className="p-6">
                      <div className="flex items-start gap-4">
                        {/* Service Icon */}
                        <div className="flex-shrink-0">
                          {getServiceIcon(record.service)}
                        </div>

                        {/* Main Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between mb-3">
                            <div className="min-w-0 flex-1">
                              <h3
                                className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate"
                                title={mediaInfo.series}
                              >
                                {mediaInfo.series}
                              </h3>
                              <div className="mt-1">
                                <p className="text-slate-600 dark:text-slate-400 text-sm font-medium">
                                  {mediaInfo.episode}
                                  {mediaInfo.episodeName && (
                                    <span className="text-slate-500 dark:text-slate-500 font-normal">
                                      {' '}
                                      • {mediaInfo.episodeName}
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>

                            <div className="flex items-center gap-3 ml-4">
                              {/* Status Badge */}
                              <div
                                className={getStatusBadge(
                                  record.status as StatusType,
                                  'flex items-center gap-2'
                                )}
                              >
                                {getStatusIcon(record.status || '')}
                                <span className="capitalize">
                                  {record.status}
                                </span>
                              </div>

                              {/* Expand Button */}
                              <button
                                onClick={() => toggleRowExpansion(record.id)}
                                className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-5 h-5 text-slate-500" />
                                ) : (
                                  <ChevronRight className="w-5 h-5 text-slate-500" />
                                )}
                              </button>
                            </div>
                          </div>

                          {/* Metadata Row */}
                          <div className="flex items-center gap-6 text-sm text-slate-600 dark:text-slate-400">
                            <div className="flex items-center gap-2">
                              <Calendar className="w-4 h-4" />
                              <span>{formatDate(record.date || '')}</span>
                            </div>

                            <div className="flex items-center gap-2">
                              <HardDrive className="w-4 h-4" />
                              <span>{formatBytes(record.size || 0)}</span>
                            </div>

                            <div className="flex items-center gap-2">
                              <Zap className="w-4 h-4" />
                              <span>
                                {typeof record.quality === 'object'
                                  ? record.quality?.name ||
                                    record.quality?.quality?.name ||
                                    'N/A'
                                  : record.quality || 'N/A'}
                              </span>
                            </div>

                            {record.downloadClient !== 'N/A' && (
                              <div className="flex items-center gap-2">
                                <Download className="w-4 h-4" />
                                <span>{record.downloadClient}</span>
                              </div>
                            )}
                          </div>

                          {/* Expanded Details */}
                          {isExpanded && (
                            <div className="mt-4 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
                              <h4 className="font-medium text-slate-900 dark:text-slate-100 mb-3">
                                Additional Details
                              </h4>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                                <div>
                                  <span className="font-medium text-slate-700 dark:text-slate-300">
                                    Original Title:
                                  </span>
                                  <p className="text-slate-600 dark:text-slate-400 mt-1 break-all">
                                    {record.title}
                                  </p>
                                </div>

                                {record.downloadId && (
                                  <div>
                                    <span className="font-medium text-slate-700 dark:text-slate-300">
                                      Download ID:
                                    </span>
                                    <p className="text-slate-600 dark:text-slate-400 mt-1 font-mono text-xs">
                                      {record.downloadId}
                                    </p>
                                  </div>
                                )}

                                {record.indexer !== 'N/A' && (
                                  <div>
                                    <span className="font-medium text-slate-700 dark:text-slate-300">
                                      Indexer:
                                    </span>
                                    <p className="text-slate-600 dark:text-slate-400 mt-1">
                                      {record.indexer}
                                    </p>
                                  </div>
                                )}

                                {record.protocol !== 'N/A' && (
                                  <div>
                                    <span className="font-medium text-slate-700 dark:text-slate-300">
                                      Protocol:
                                    </span>
                                    <p className="text-slate-600 dark:text-slate-400 mt-1">
                                      {record.protocol}
                                    </p>
                                  </div>
                                )}

                                {record.reason && (
                                  <div className="md:col-span-2">
                                    <span className="font-medium text-slate-700 dark:text-slate-300">
                                      Release Group:
                                    </span>
                                    <p className="text-slate-600 dark:text-slate-400 mt-1">
                                      {record.reason}
                                    </p>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Empty State */}
          {!isLoading && processedData.records.length === 0 && (
            <Card className="border-2 border-dashed border-slate-300 dark:border-slate-700">
              <CardContent className="p-12 text-center">
                <div className="mx-auto w-24 h-24 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
                  <Database className="w-12 h-12 text-slate-400" />
                </div>
                <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
                  No History Records Found
                </h3>
                <p className="text-slate-600 dark:text-slate-400 max-w-md mx-auto">
                  {filters.search ||
                  filters.status ||
                  filters.dateFrom ||
                  filters.dateTo
                    ? 'No records match your current filters. Try adjusting your search criteria.'
                    : 'No download history available yet. Your downloads will appear here once you start using your *arr services.'}
                </p>
                {(filters.search ||
                  filters.status ||
                  filters.dateFrom ||
                  filters.dateTo) && (
                  <button
                    onClick={() =>
                      setFilters({
                        search: '',
                        service: 'downloads',
                        status: '',
                        protocol: '',
                        dateFrom: '',
                        dateTo: '',
                      })
                    }
                    className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                  >
                    Clear All Filters
                  </button>
                )}
              </CardContent>
            </Card>
          )}

          {/* Pagination Controls */}
          {processedData.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-8">
              <button
                onClick={() =>
                  setCurrentPageView(Math.max(1, currentPageView - 1))
                }
                disabled={currentPageView === 1}
                className="px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>

              {/* Page Numbers */}
              {[...Array(Math.min(5, processedData.totalPages))].map((_, i) => {
                let pageNum;
                if (processedData.totalPages <= 5) {
                  pageNum = i + 1;
                } else if (currentPageView <= 3) {
                  pageNum = i + 1;
                } else if (currentPageView >= processedData.totalPages - 2) {
                  pageNum = processedData.totalPages - 4 + i;
                } else {
                  pageNum = currentPageView - 2 + i;
                }

                return (
                  <button
                    key={pageNum}
                    onClick={() => setCurrentPageView(pageNum)}
                    className={`px-3 py-2 text-sm rounded-lg ${
                      currentPageView === pageNum
                        ? 'bg-blue-600 text-white'
                        : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
                    }`}
                  >
                    {pageNum}
                  </button>
                );
              })}

              <button
                onClick={() =>
                  setCurrentPageView(
                    Math.min(processedData.totalPages, currentPageView + 1)
                  )
                }
                disabled={currentPageView === processedData.totalPages}
                className="px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>

              <span className="ml-4 text-sm text-slate-600 dark:text-slate-400">
                Page {currentPageView} of {processedData.totalPages} •{' '}
                {processedData.totalRecords} total records
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
