import React from 'react';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui';
import { useAppStore } from '@/store';
import { getPlaceholderImage } from '@/utils/images';
import {
  Film,
  Tv,
  Search,
  Eye,
  EyeOff,
  Calendar,
  Clock,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Settings,
  Filter,
  SortAsc,
  SortDesc,
  ChevronDown,
  ChevronUp,
  MoreVertical,
} from 'lucide-react';

// API Response Types
interface QualityProfile {
  id: number;
  name: string;
  quality?: {
    id: number;
    name: string;
    resolution: number;
  };
}

interface MovieFile {
  id: number;
  relativePath?: string;
  path?: string;
  quality?: {
    quality: {
      name: string;
      resolution: number;
    };
  };
  releaseGroup?: string;
  languages?: Array<{ name: string }>;
  mediaInfo?: {
    width?: number;
    height?: number;
    videoCodec?: string;
    audioCodec?: string;
    audioBitrate?: number;
    audioChannels?: number;
    audioLanguages?: string;
  };
  sceneName?: string;
}

interface SeriesStatistics {
  seasonCount: number;
  episodeCount: number;
  episodeFileCount: number;
  totalEpisodeCount: number;
  sizeOnDisk: number;
}

interface MovieApiResponse {
  id: number;
  title: string;
  year: number;
  status: string;
  monitored: boolean;
  hasFile: boolean;
  path: string;
  sizeOnDisk: number;
  genres: string[];
  overview: string;
  images: Array<{
    coverType: string;
    url?: string;
    remoteUrl?: string;
  }>;
  qualityProfileId: number;
  movieFile?: MovieFile;
  added: string;
  lastSearchTime?: string;
  tags: string[];
  minimumAvailability: string;
}

interface SeriesApiResponse {
  id: number;
  title: string;
  year: number;
  status: string;
  monitored: boolean;
  hasFile: boolean;
  path: string;
  genres: string[];
  overview: string;
  network: string;
  images: Array<{
    coverType: string;
    url?: string;
    remoteUrl?: string;
  }>;
  qualityProfileId: number;
  statistics?: SeriesStatistics;
  added: string;
  lastSearchTime?: string;
  tags: string[];
}

interface LibraryItem {
  id: number;
  title: string;
  year?: number;
  status: string;
  monitored: boolean;
  hasFile: boolean;
  poster?: string;
  overview?: string;
  qualityProfile?: {
    name: string;
    quality?: {
      name: string;
      resolution: number;
      id: number;
    };
  };
  path?: string;
  sizeOnDisk?: number;
  genres?: string[];
  network?: string;
  seasons?: number;
  episodes?: {
    total: number;
    available: number;
    missing: number;
  };
  movieFile?: any; // For movie files with quality and media info
  episodeFiles?: any[]; // For series episode files with quality and media info
  added?: string;
  lastSearchTime?: string;
  tags?: string[];
}

interface LibrarySectionProps {
  title: string;
  items: LibraryItem[];
  isLoading: boolean;
  onToggleMonitoring: (id: number, monitored: boolean) => void;
  onSearch: (id: number) => void;
  onRefresh: () => void;
  type: 'movie' | 'series';
  searchQuery: string;
  onSearchChange: (query: string) => void;
  statusFilter: string;
  onStatusFilterChange: (filter: string) => void;
  qualityFilter: string;
  onQualityFilterChange: (filter: string) => void;
  sortBy: string;
  sortDirection: 'asc' | 'desc';
  onSort: (field: string) => void;
  allItems: LibraryItem[];
  expandedItems: Set<number>;
  onToggleExpanded: (id: number) => void;
}

interface SearchAndFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  statusFilter: string;
  onStatusFilterChange: (filter: string) => void;
  qualityFilter: string;
  onQualityFilterChange: (filter: string) => void;
  sortBy: string;
  sortDirection: 'asc' | 'desc';
  onSort: (field: string) => void;
  allItems: LibraryItem[];
  type: 'movie' | 'series';
}

const SearchAndFilters: React.FC<SearchAndFiltersProps> = React.memo(
  ({
    searchQuery,
    onSearchChange,
    statusFilter,
    onStatusFilterChange,
    qualityFilter,
    onQualityFilterChange,
    sortBy,
    sortDirection,
    onSort,
    allItems,
    type,
  }) => {
    // Extract unique quality profiles from all items
    const qualityProfiles = React.useMemo(() => {
      const profiles = new Set(
        allItems.map(item => item.qualityProfile?.name).filter(Boolean)
      );
      return Array.from(profiles).sort();
    }, [allItems]);

    return (
      <div className="space-y-4">
        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder={`Search ${type === 'movie' ? 'movies' : 'TV shows'}...`}
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Filters and Sort */}
        <div className="flex flex-wrap gap-4">
          {/* Status Filter */}
          <div className="flex items-center space-x-2">
            <Filter className="h-4 w-4 text-gray-500" />
            <select
              value={statusFilter}
              onChange={e => onStatusFilterChange(e.target.value)}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="all">All Status</option>
              <option value="downloaded">Downloaded</option>
              <option value="missing">Missing</option>
              <option value="monitored">Monitored</option>
              <option value="unmonitored">Unmonitored</option>
            </select>
          </div>

          {/* Quality Filter */}
          {qualityProfiles.length > 0 && (
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-500">Quality:</span>
              <select
                value={qualityFilter}
                onChange={e => onQualityFilterChange(e.target.value)}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Qualities</option>
                {qualityProfiles.map(profile => (
                  <option key={profile} value={profile}>
                    {profile}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Sort */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-500">Sort:</span>
            <select
              value={sortBy}
              onChange={e => onSort(e.target.value)}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="title">Title</option>
              <option value="year">Year</option>
              <option value="size">Size</option>
              <option value="quality">Quality</option>
              <option value="status">Status</option>
            </select>
            <button
              onClick={() => onSort(sortBy)}
              className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              title={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
            >
              {sortDirection === 'asc' ? (
                <SortAsc className="h-4 w-4" />
              ) : (
                <SortDesc className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }
);

const LibrarySection: React.FC<LibrarySectionProps> = React.memo(
  ({
    title,
    items,
    isLoading,
    onToggleMonitoring,
    onSearch,
    onRefresh,
    type,
    searchQuery,
    onSearchChange,
    statusFilter,
    onStatusFilterChange,
    qualityFilter,
    onQualityFilterChange,
    sortBy,
    sortDirection,
    onSort,
    allItems,
    expandedItems,
    onToggleExpanded,
  }) => {
    const getStatusColor = (status: string, hasFile: boolean) => {
      if (hasFile) return 'text-green-600';
      if (status === 'wanted' || status === 'missing') return 'text-yellow-600';
      if (status === 'announced') return 'text-blue-600';
      return 'text-gray-600';
    };

    const getStatusIcon = (status: string, hasFile: boolean) => {
      if (hasFile) return <CheckCircle className="h-4 w-4" />;
      if (status === 'wanted' || status === 'missing')
        return <Clock className="h-4 w-4" />;
      if (status === 'announced') return <Calendar className="h-4 w-4" />;
      return <AlertCircle className="h-4 w-4" />;
    };

    const formatFileSize = (bytes?: number) => {
      if (!bytes) return 'N/A';
      const gb = bytes / (1024 * 1024 * 1024);
      return `${gb.toFixed(1)} GB`;
    };

    return (
      <Card>
        <CardHeader
          title={title}
          subtitle={`${items.length} ${type === 'movie' ? 'movies' : 'series'} in library`}
          actions={
            <button
              onClick={onRefresh}
              disabled={isLoading}
              className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-5 w-5 ${isLoading ? 'animate-spin' : ''}`}
              />
            </button>
          }
        />
        <CardContent>
          {/* Search and Filters */}
          <SearchAndFilters
            searchQuery={searchQuery}
            onSearchChange={onSearchChange}
            statusFilter={statusFilter}
            onStatusFilterChange={onStatusFilterChange}
            qualityFilter={qualityFilter}
            onQualityFilterChange={onQualityFilterChange}
            sortBy={sortBy}
            sortDirection={sortDirection}
            onSort={onSort}
            allItems={allItems}
            type={type}
          />

          <div className="mt-6">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3" />
                <span className="text-gray-600 dark:text-gray-400">
                  Loading {type === 'movie' ? 'movies' : 'series'}...
                </span>
              </div>
            ) : allItems.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-gray-400 mb-4">
                  {type === 'movie' ? (
                    <Film className="h-12 w-12 mx-auto" />
                  ) : (
                    <Tv className="h-12 w-12 mx-auto" />
                  )}
                </div>
                <p className="text-gray-600 dark:text-gray-400">
                  No {type === 'movie' ? 'movies' : 'series'} in library yet
                </p>
              </div>
            ) : items.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-gray-400 mb-4">
                  <Search className="h-12 w-12 mx-auto" />
                </div>
                <p className="text-gray-600 dark:text-gray-400">
                  No {type === 'movie' ? 'movies' : 'series'} match your current
                  filters
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-500 mt-1">
                  Try adjusting your search or filter criteria
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {items.map(item => (
                  <div
                    key={item.id}
                    className="bg-gray-50 dark:bg-gray-800 rounded-lg overflow-hidden"
                  >
                    <div className="flex items-start space-x-4 p-4">
                      <div className="flex-shrink-0">
                        {item.poster ? (
                          <img
                            src={item.poster}
                            alt={item.title}
                            className="w-16 h-24 object-cover rounded"
                          />
                        ) : (
                          <div className="w-16 h-24 bg-gray-200 dark:bg-gray-700 rounded flex items-center justify-center">
                            {type === 'movie' ? (
                              <Film className="h-6 w-6 text-gray-400" />
                            ) : (
                              <Tv className="h-6 w-6 text-gray-400" />
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center space-x-2">
                              <h3 className="font-medium text-gray-900 dark:text-gray-100 truncate">
                                {item.title} {item.year && `(${item.year})`}
                              </h3>
                              <button
                                onClick={() => onToggleExpanded(item.id)}
                                className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                              >
                                {expandedItems.has(item.id) ? (
                                  <ChevronUp className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </button>
                            </div>

                            <div className="flex items-center space-x-4 mt-2 text-sm">
                              <div
                                className={`flex items-center space-x-1 ${getStatusColor(item.status, item.hasFile)}`}
                              >
                                {getStatusIcon(item.status, item.hasFile)}
                                <span className="capitalize">
                                  {item.hasFile ? 'Downloaded' : item.status}
                                </span>
                              </div>

                              {item.qualityProfile && (
                                <span className="px-2 py-1 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 rounded">
                                  {item.qualityProfile.name}
                                </span>
                              )}

                              {item.sizeOnDisk && item.sizeOnDisk > 0 && (
                                <span className="text-gray-600 dark:text-gray-400">
                                  {formatFileSize(item.sizeOnDisk)}
                                </span>
                              )}

                              {type === 'series' && item.episodes && (
                                <span className="text-gray-600 dark:text-gray-400">
                                  {item.episodes.available}/
                                  {item.episodes.total} episodes
                                  {item.episodes.missing > 0 && (
                                    <span className="text-yellow-600 ml-1">
                                      ({item.episodes.missing} missing)
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center space-x-4 mt-1 text-xs text-gray-500 dark:text-gray-400">
                              {item.genres && item.genres.length > 0 && (
                                <span>
                                  {item.genres.slice(0, 3).join(', ')}
                                </span>
                              )}
                              {item.network && <span>• {item.network}</span>}
                              {item.path && (
                                <span>• {item.path.split('/').pop()}</span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center space-x-2 ml-4">
                            <button
                              onClick={() =>
                                onToggleMonitoring(item.id, !item.monitored)
                              }
                              className={`p-2 rounded-lg transition-colors ${
                                item.monitored
                                  ? 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20'
                                  : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                              }`}
                              title={
                                item.monitored
                                  ? 'Stop monitoring'
                                  : 'Start monitoring'
                              }
                            >
                              {item.monitored ? (
                                <Eye className="h-4 w-4" />
                              ) : (
                                <EyeOff className="h-4 w-4" />
                              )}
                            </button>

                            <button
                              onClick={() => onSearch(item.id)}
                              className="p-2 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                              title={`Search for ${item.title}`}
                            >
                              <Search className="h-4 w-4" />
                            </button>

                            <button className="p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
                              <MoreVertical className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    {expandedItems.has(item.id) && (
                      <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-25 dark:bg-gray-750 p-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                          <div>
                            <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                              File Information
                            </h4>
                            <div className="space-y-1 text-gray-600 dark:text-gray-400">
                              <p>
                                <strong>Path:</strong>{' '}
                                <span className="break-all text-xs">
                                  {item.path || 'Not set'}
                                </span>
                              </p>
                              {item.sizeOnDisk && item.sizeOnDisk > 0 ? (
                                <p>
                                  <strong>Size:</strong>{' '}
                                  {formatFileSize(item.sizeOnDisk)}
                                </p>
                              ) : (
                                <p>
                                  <strong>Size:</strong> No files
                                </p>
                              )}
                              <p>
                                <strong>Quality Profile:</strong>{' '}
                                {item.qualityProfile?.name || 'Not configured'}
                              </p>
                              {item.qualityProfile?.quality && (
                                <p>
                                  <strong>Target Quality:</strong>{' '}
                                  {item.qualityProfile.quality.name} (
                                  {item.qualityProfile.quality.resolution}p)
                                </p>
                              )}
                              {(item as any).movieFile?.quality && (
                                <>
                                  <p>
                                    <strong>File Quality:</strong>{' '}
                                    {
                                      (item as any).movieFile.quality.quality
                                        .name
                                    }
                                  </p>
                                  {(item as any).movieFile.customFormatScore !==
                                    undefined && (
                                    <p>
                                      <strong>Custom Format Score:</strong>
                                      <span
                                        className={`ml-1 px-2 py-1 text-xs rounded ${
                                          (item as any).movieFile
                                            .customFormatScore > 0
                                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                            : 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200'
                                        }`}
                                      >
                                        {
                                          (item as any).movieFile
                                            .customFormatScore
                                        }
                                      </span>
                                    </p>
                                  )}
                                  {(item as any).movieFile.customFormats &&
                                    (item as any).movieFile.customFormats
                                      .length > 0 && (
                                      <p>
                                        <strong>Custom Formats:</strong>
                                        <div className="flex flex-wrap gap-1 mt-1">
                                          {(
                                            item as any
                                          ).movieFile.customFormats.map(
                                            (format: any, index: number) => (
                                              <span
                                                key={index}
                                                className="px-2 py-1 text-xs bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 rounded"
                                              >
                                                {format.name}
                                              </span>
                                            )
                                          )}
                                        </div>
                                      </p>
                                    )}
                                  {(item as any).movieFile.releaseGroup && (
                                    <p>
                                      <strong>Release Group:</strong>{' '}
                                      {(item as any).movieFile.releaseGroup}
                                    </p>
                                  )}
                                  {(item as any).movieFile.languages &&
                                    (item as any).movieFile.languages.length >
                                      0 && (
                                      <p>
                                        <strong>Languages:</strong>{' '}
                                        {(item as any).movieFile.languages
                                          .map((lang: any) => lang.name)
                                          .join(', ')}
                                      </p>
                                    )}
                                  {(item as any).movieFile.sceneName && (
                                    <p>
                                      <strong>Scene Name:</strong>{' '}
                                      <span className="text-xs break-all">
                                        {(item as any).movieFile.sceneName}
                                      </span>
                                    </p>
                                  )}
                                  {(item as any).movieFile.mediaInfo && (
                                    <>
                                      {(item as any).movieFile.mediaInfo
                                        .width &&
                                      (item as any).movieFile.mediaInfo
                                        .height ? (
                                        <p>
                                          <strong>Resolution:</strong>{' '}
                                          {
                                            (item as any).movieFile.mediaInfo
                                              .width
                                          }
                                          x
                                          {
                                            (item as any).movieFile.mediaInfo
                                              .height
                                          }
                                        </p>
                                      ) : (
                                        <p>
                                          <strong>Resolution:</strong>{' '}
                                          {
                                            (item as any).movieFile.quality
                                              .quality.resolution
                                          }
                                          p
                                        </p>
                                      )}
                                      {(item as any).movieFile.mediaInfo
                                        .videoCodec && (
                                        <p>
                                          <strong>Video Codec:</strong>{' '}
                                          {
                                            (item as any).movieFile.mediaInfo
                                              .videoCodec
                                          }
                                        </p>
                                      )}
                                      {(item as any).movieFile.mediaInfo
                                        .audioCodec && (
                                        <p>
                                          <strong>Audio Codec:</strong>{' '}
                                          {
                                            (item as any).movieFile.mediaInfo
                                              .audioCodec
                                          }
                                        </p>
                                      )}
                                      {(item as any).movieFile.mediaInfo
                                        .audioBitrate && (
                                        <p>
                                          <strong>Audio Bitrate:</strong>{' '}
                                          {(
                                            (item as any).movieFile.mediaInfo
                                              .audioBitrate / 1000
                                          ).toFixed(0)}{' '}
                                          kbps
                                        </p>
                                      )}
                                      {(item as any).movieFile.mediaInfo
                                        .audioChannels && (
                                        <p>
                                          <strong>Audio Channels:</strong>{' '}
                                          {
                                            (item as any).movieFile.mediaInfo
                                              .audioChannels
                                          }
                                        </p>
                                      )}
                                      {(item as any).movieFile.mediaInfo
                                        .audioLanguages && (
                                        <p>
                                          <strong>Audio Languages:</strong>{' '}
                                          {
                                            (item as any).movieFile.mediaInfo
                                              .audioLanguages
                                          }
                                        </p>
                                      )}
                                    </>
                                  )}
                                </>
                              )}
                              <p>
                                <strong>Status:</strong>{' '}
                                <span className="capitalize">
                                  {item.hasFile ? 'Downloaded' : item.status}
                                </span>
                              </p>
                            </div>
                          </div>

                          {type === 'series' && (
                            <div>
                              <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                                Series Information
                              </h4>
                              <div className="space-y-1 text-gray-600 dark:text-gray-400">
                                <p>
                                  <strong>Network:</strong>{' '}
                                  {item.network || 'Unknown'}
                                </p>
                                <p>
                                  <strong>Seasons:</strong> {item.seasons || 0}
                                </p>
                                {item.episodes && (
                                  <>
                                    <p>
                                      <strong>Episodes:</strong>{' '}
                                      {item.episodes.total}
                                    </p>
                                    <p>
                                      <strong>Downloaded:</strong>{' '}
                                      {item.episodes.available}
                                    </p>
                                    <p>
                                      <strong>Missing:</strong>{' '}
                                      {item.episodes.missing}
                                    </p>
                                  </>
                                )}
                                {(item as any).episodeFiles &&
                                  (item as any).episodeFiles.length > 0 && (
                                    <>
                                      <p>
                                        <strong>Episode Files:</strong>{' '}
                                        {(item as any).episodeFiles.length}
                                      </p>
                                      {(() => {
                                        const firstFile = (item as any)
                                          .episodeFiles[0];
                                        const avgScore = (
                                          item as any
                                        ).episodeFiles
                                          .filter(
                                            (f: any) =>
                                              f.customFormatScore !== undefined
                                          )
                                          .reduce(
                                            (
                                              sum: number,
                                              f: any,
                                              _: any,
                                              arr: any[]
                                            ) =>
                                              sum +
                                              f.customFormatScore / arr.length,
                                            0
                                          );

                                        return (
                                          <>
                                            {firstFile?.quality && (
                                              <p>
                                                <strong>Quality:</strong>{' '}
                                                {firstFile.quality.quality.name}
                                              </p>
                                            )}
                                            {avgScore > 0 && (
                                              <p>
                                                <strong>
                                                  Avg Custom Format Score:
                                                </strong>
                                                <span
                                                  className={`ml-1 px-2 py-1 text-xs rounded ${
                                                    avgScore > 0
                                                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                                      : 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200'
                                                  }`}
                                                >
                                                  {Math.round(avgScore)}
                                                </span>
                                              </p>
                                            )}
                                          </>
                                        );
                                      })()}
                                    </>
                                  )}
                              </div>
                            </div>
                          )}

                          <div>
                            <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                              Management
                            </h4>
                            <div className="space-y-1 text-gray-600 dark:text-gray-400">
                              <p>
                                <strong>Monitored:</strong>{' '}
                                {item.monitored ? 'Yes' : 'No'}
                              </p>
                              {(() => {
                                const addedDate = (item as any).added;
                                if (addedDate) {
                                  try {
                                    const date = new Date(addedDate);
                                    return (
                                      <p>
                                        <strong>Added:</strong>{' '}
                                        {date.toLocaleDateString()}{' '}
                                        {date.toLocaleTimeString([], {
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </p>
                                    );
                                  } catch (e) {
                                    return (
                                      <p>
                                        <strong>Added:</strong> {addedDate}
                                      </p>
                                    );
                                  }
                                }
                                return (
                                  <p>
                                    <strong>Added:</strong> Unknown
                                  </p>
                                );
                              })()}
                              {(() => {
                                const lastSearch = (item as any).lastSearchTime;
                                if (lastSearch) {
                                  try {
                                    const date = new Date(lastSearch);
                                    return (
                                      <p>
                                        <strong>Last Search:</strong>{' '}
                                        {date.toLocaleDateString()}{' '}
                                        {date.toLocaleTimeString([], {
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </p>
                                    );
                                  } catch (e) {
                                    return (
                                      <p>
                                        <strong>Last Search:</strong>{' '}
                                        {lastSearch}
                                      </p>
                                    );
                                  }
                                }
                                return null;
                              })()}
                              {(item as any).tags &&
                                (item as any).tags.length > 0 && (
                                  <p>
                                    <strong>Tags:</strong>{' '}
                                    {(item as any).tags.join(', ')}
                                  </p>
                                )}
                              {(item as any).minimumAvailability && (
                                <p>
                                  <strong>Minimum Availability:</strong>{' '}
                                  {(item as any).minimumAvailability}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
);

// Error Boundary Component
class LibraryErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('LibraryPage error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 text-center">
          <div className="text-red-600 mb-4">
            <AlertCircle className="h-12 w-12 mx-auto mb-2" />
            <h3 className="text-lg font-medium">Something went wrong</h3>
          </div>
          <p className="text-gray-600 mb-4">
            There was an error loading the library. Please try refreshing the
            page.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Refresh Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

const constructImageUrl = (
  images: any[],
  type: 'movie' | 'series',
  baseUrl: string
): string => {
  let posterUrl = getPlaceholderImage(type);

  if (images && images.length > 0) {
    const posterImage = images.find((img: any) => img.coverType === 'poster');
    if (posterImage) {
      if (posterImage.remoteUrl && posterImage.remoteUrl.startsWith('http')) {
        posterUrl = posterImage.remoteUrl;
      } else if (posterImage.url) {
        const cleanBaseUrl = baseUrl.replace(/\/$/, '');
        const imageUrl = posterImage.url;

        const servicePath = type === 'movie' ? '/radarr/' : '/sonarr/';
        if (imageUrl.includes(servicePath)) {
          const serverUrl = cleanBaseUrl.replace(servicePath.slice(0, -1), '');
          posterUrl = `http://localhost:3001/api/proxy?url=${encodeURIComponent(serverUrl + imageUrl)}`;
        } else {
          posterUrl = `http://localhost:3001/api/proxy?url=${encodeURIComponent(cleanBaseUrl + imageUrl)}`;
        }
      }
    }
  }

  return posterUrl;
};

const constructFilePath = (basePath: string, movieFile?: any): string => {
  if (!basePath) return 'Not set';

  if (movieFile && movieFile.relativePath) {
    return `${basePath}/${movieFile.relativePath}`;
  } else if (movieFile && movieFile.path) {
    return movieFile.path;
  }

  return basePath;
};

export const LibraryPage: React.FC = () => {
  const { apiManager, config } = useAppStore();
  const [movies, setMovies] = React.useState<LibraryItem[]>([]);
  const [series, setSeries] = React.useState<LibraryItem[]>([]);
  const [isLoadingMovies, setIsLoadingMovies] = React.useState(false);
  const [isLoadingSeries, setIsLoadingSeries] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'movies' | 'series'>(
    'movies'
  );
  const [searchQuery, setSearchQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [qualityFilter, setQualityFilter] = React.useState<string>('all');
  const [monitoredFilter] = React.useState<string>('all');
  const [sortBy, setSortBy] = React.useState<string>('title');
  const [sortDirection, setSortDirection] = React.useState<'asc' | 'desc'>(
    'asc'
  );
  const [_selectedItems] = React.useState<Set<number>>(new Set());
  const [expandedItems, setExpandedItems] = React.useState<Set<number>>(
    new Set()
  );

  const filterAndSortItems = React.useCallback(
    (items: LibraryItem[]): LibraryItem[] => {
      let filtered = [...items];

      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        filtered = filtered.filter(
          item =>
            item.title.toLowerCase().includes(query) ||
            item.genres?.some(genre => genre.toLowerCase().includes(query)) ||
            item.network?.toLowerCase().includes(query)
        );
      }

      if (statusFilter !== 'all') {
        filtered = filtered.filter(item => {
          switch (statusFilter) {
            case 'downloaded':
              return item.hasFile;
            case 'missing':
              return !item.hasFile;
            case 'monitored':
              return item.monitored;
            case 'unmonitored':
              return !item.monitored;
            default:
              return true;
          }
        });
      }

      if (qualityFilter !== 'all') {
        filtered = filtered.filter(
          item => item.qualityProfile?.name === qualityFilter
        );
      }

      if (monitoredFilter !== 'all') {
        filtered = filtered.filter(item => {
          return monitoredFilter === 'monitored'
            ? item.monitored
            : !item.monitored;
        });
      }

      filtered.sort((a, b) => {
        let aValue: string | number;
        let bValue: string | number;

        switch (sortBy) {
          case 'title':
            aValue = a.title.toLowerCase();
            bValue = b.title.toLowerCase();
            break;
          case 'year':
            aValue = a.year || 0;
            bValue = b.year || 0;
            break;
          case 'size':
            aValue = a.sizeOnDisk || 0;
            bValue = b.sizeOnDisk || 0;
            break;
          case 'quality':
            aValue = a.qualityProfile?.name || '';
            bValue = b.qualityProfile?.name || '';
            break;
          case 'status':
            aValue = a.hasFile ? 'downloaded' : 'missing';
            bValue = b.hasFile ? 'downloaded' : 'missing';
            break;
          default:
            aValue = a.title.toLowerCase();
            bValue = b.title.toLowerCase();
        }

        if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
        if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });

      return filtered;
    },
    [
      searchQuery,
      statusFilter,
      qualityFilter,
      monitoredFilter,
      sortBy,
      sortDirection,
    ]
  );

  const filteredMovies = React.useMemo(
    () => filterAndSortItems(movies),
    [movies, filterAndSortItems]
  );

  const filteredSeries = React.useMemo(
    () => filterAndSortItems(series),
    [series, filterAndSortItems]
  );

  const handleSort = React.useCallback(
    (field: string): void => {
      if (sortBy === field) {
        setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortBy(field);
        setSortDirection('asc');
      }
    },
    [sortBy, sortDirection]
  );

  const handleToggleExpanded = React.useCallback((id: number): void => {
    setExpandedItems(prev => {
      const newExpanded = new Set(prev);
      if (newExpanded.has(id)) {
        newExpanded.delete(id);
      } else {
        newExpanded.add(id);
      }
      return newExpanded;
    });
  }, []);

  const canManageMovies = React.useMemo(
    () => apiManager?.isConfigured('radarr') ?? false,
    [apiManager]
  );

  const canManageSeries = React.useMemo(
    () => apiManager?.isConfigured('sonarr') ?? false,
    [apiManager]
  );

  React.useEffect(() => {
    if (canManageMovies) {
      loadMovies();
    }
    if (canManageSeries) {
      loadSeries();
    }
  }, [canManageMovies, canManageSeries]);

  const loadMovies = async (): Promise<void> => {
    if (!apiManager?.isConfigured('radarr')) return;

    setIsLoadingMovies(true);
    try {
      const [moviesData, qualityProfiles] = await Promise.all([
        apiManager.radarr.getMovies() as Promise<MovieApiResponse[]>,
        apiManager.radarr.getQualityProfiles() as Promise<QualityProfile[]>,
      ]);

      if (!moviesData || !qualityProfiles) {
        throw new Error('Failed to fetch movie data or quality profiles');
      }

      const transformedMovies: LibraryItem[] = moviesData.map(
        (movie: MovieApiResponse) => {
          const qualityProfile = qualityProfiles.find(
            qp => qp.id === movie.qualityProfileId
          );
          const posterUrl = constructImageUrl(
            movie.images,
            'movie',
            config.radarr.baseUrl
          );
          const fullPath = constructFilePath(movie.path, movie.movieFile);

          return {
            id: movie.id,
            title: movie.title,
            year: movie.year,
            status: movie.status,
            monitored: movie.monitored,
            hasFile: movie.hasFile,
            poster: posterUrl,
            overview: movie.overview,
            qualityProfile,
            path: fullPath,
            sizeOnDisk: movie.sizeOnDisk,
            genres: movie.genres,
            movieFile: movie.movieFile,
            added: movie.added,
            lastSearchTime: movie.lastSearchTime,
            tags: movie.tags,
            minimumAvailability: movie.minimumAvailability,
          };
        }
      );

      setMovies(transformedMovies);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      toast.error(`Failed to load movies: ${errorMessage}`);
      console.error('Load movies error:', error);
    } finally {
      setIsLoadingMovies(false);
    }
  };

  const loadSeries = async (): Promise<void> => {
    if (!apiManager?.isConfigured('sonarr')) return;

    setIsLoadingSeries(true);
    try {
      const [seriesData, qualityProfiles] = await Promise.all([
        apiManager.sonarr.getSeries() as Promise<SeriesApiResponse[]>,
        apiManager.sonarr.getQualityProfiles() as Promise<QualityProfile[]>,
      ]);

      if (!seriesData || !qualityProfiles) {
        throw new Error('Failed to fetch series data or quality profiles');
      }

      const transformedSeries: LibraryItem[] = seriesData.map(
        (show: SeriesApiResponse) => {
          const qualityProfile = qualityProfiles.find(
            qp => qp.id === show.qualityProfileId
          );
          const posterUrl = constructImageUrl(
            show.images,
            'series',
            config.sonarr.baseUrl
          );

          const statistics = show.statistics;
          const episodeData = statistics
            ? {
                total: statistics.episodeCount,
                available: statistics.episodeFileCount,
                missing: Math.max(
                  0,
                  statistics.episodeCount - statistics.episodeFileCount
                ),
              }
            : undefined;

          return {
            id: show.id,
            title: show.title,
            year: show.year,
            status: show.status,
            monitored: show.monitored,
            hasFile: show.hasFile || (statistics?.episodeFileCount || 0) > 0,
            poster: posterUrl,
            overview: show.overview,
            qualityProfile,
            path: show.path,
            sizeOnDisk: statistics?.sizeOnDisk,
            genres: show.genres,
            network: show.network,
            seasons: statistics?.seasonCount || 0,
            episodes: episodeData,
            added: show.added,
            lastSearchTime: show.lastSearchTime,
            tags: show.tags,
          };
        }
      );

      setSeries(transformedSeries);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      toast.error(`Failed to load series: ${errorMessage}`);
      console.error('Load series error:', error);
    } finally {
      setIsLoadingSeries(false);
    }
  };

  const handleToggleMovieMonitoring = async (
    _id: number,
    monitored: boolean
  ): Promise<void> => {
    try {
      toast.info(
        `${monitored ? 'Enabled' : 'Disabled'} monitoring for movie (API implementation needed)`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to update movie monitoring: ${errorMessage}`);
      console.error('Movie monitoring error:', error);
    }
  };

  const handleToggleSeriesMonitoring = async (
    _id: number,
    monitored: boolean
  ): Promise<void> => {
    try {
      toast.info(
        `${monitored ? 'Enabled' : 'Disabled'} monitoring for series (API implementation needed)`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to update series monitoring: ${errorMessage}`);
      console.error('Series monitoring error:', error);
    }
  };

  const handleSearchMovie = async (_id: number): Promise<void> => {
    try {
      toast.success('Movie search triggered (API implementation needed)');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to search movie: ${errorMessage}`);
      console.error('Movie search error:', error);
    }
  };

  const handleSearchSeries = async (_id: number): Promise<void> => {
    try {
      toast.success('Series search triggered (API implementation needed)');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to search series: ${errorMessage}`);
      console.error('Series search error:', error);
    }
  };

  // Show configuration warning if neither service is configured
  if (!canManageMovies && !canManageSeries) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Library</h1>
          <p className="text-muted-foreground mt-2">
            Manage your movie and TV show library
          </p>
        </div>

        <Card>
          <CardContent>
            <div className="flex items-center space-x-4 p-6">
              <Settings className="h-8 w-8 text-yellow-600" />
              <div className="flex-1">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Configuration Required
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  Please configure Radarr (for movies) and/or Sonarr (for TV
                  shows) to view and manage your library.
                </p>
                <button
                  onClick={() => (window.location.href = '/settings')}
                  className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  <Settings className="h-4 w-4 mr-2" />
                  Go to Settings
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <LibraryErrorBoundary>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Library</h1>
          <p className="text-muted-foreground mt-2">
            Manage your movie and TV show library
          </p>
        </div>

        {/* Tab Navigation */}
        {canManageMovies && canManageSeries && (
          <div className="flex space-x-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
            <button
              onClick={() => setActiveTab('movies')}
              className={`flex-1 flex items-center justify-center space-x-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'movies'
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
              }`}
            >
              <Film className="h-4 w-4" />
              <span>Movies ({movies.length})</span>
            </button>
            <button
              onClick={() => setActiveTab('series')}
              className={`flex-1 flex items-center justify-center space-x-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'series'
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
              }`}
            >
              <Tv className="h-4 w-4" />
              <span>TV Shows ({series.length})</span>
            </button>
          </div>
        )}

        {/* Movies Section */}
        {canManageMovies && (!canManageSeries || activeTab === 'movies') && (
          <LibrarySection
            title="Movies"
            items={filteredMovies}
            isLoading={isLoadingMovies}
            onToggleMonitoring={handleToggleMovieMonitoring}
            onSearch={handleSearchMovie}
            onRefresh={loadMovies}
            type="movie"
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            qualityFilter={qualityFilter}
            onQualityFilterChange={setQualityFilter}
            sortBy={sortBy}
            sortDirection={sortDirection}
            onSort={handleSort}
            allItems={movies}
            expandedItems={expandedItems}
            onToggleExpanded={handleToggleExpanded}
          />
        )}

        {/* Series Section */}
        {canManageSeries && (!canManageMovies || activeTab === 'series') && (
          <LibrarySection
            title="TV Shows"
            items={filteredSeries}
            isLoading={isLoadingSeries}
            onToggleMonitoring={handleToggleSeriesMonitoring}
            onSearch={handleSearchSeries}
            onRefresh={loadSeries}
            type="series"
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            qualityFilter={qualityFilter}
            onQualityFilterChange={setQualityFilter}
            sortBy={sortBy}
            sortDirection={sortDirection}
            onSort={handleSort}
            allItems={series}
            expandedItems={expandedItems}
            onToggleExpanded={handleToggleExpanded}
          />
        )}
      </div>
    </LibraryErrorBoundary>
  );
};
