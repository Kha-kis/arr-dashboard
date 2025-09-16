import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  CardHeader,
  CardContent,
  Button,
  LoadingState,
} from '@/components/ui';
import {
  SearchInput,
  SearchFilters,
  SearchResults,
  DownloadConfirmDialog,
  DownloadStatusTracker,
} from '@/components/search';
import { useSearch } from '@/hooks';
import { useAppStore, useSortedSearchResults } from '@/store';

import { SearchResult } from '@/types';
import { AlertCircle, Search as SearchIcon, Settings } from 'lucide-react';

export const ManualSearchPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    searchQuery,
    searchType,
    selectedIndexers,
    isSearching,
    indexers,
    isLoadingIndexers,
    setSearchQuery,
    setSearchType,
    toggleIndexer,
    performSearch,
    grabResult,
    canSearch,
    hasIndexers,
    isGrabbing,
  } = useSearch();

  const sortedResults = useSortedSearchResults();
  const { sortConfig, setSortConfig, apiManager } = useAppStore();

  const isProwlarrConfigured = apiManager?.isConfigured('prowlarr');

  // Download dialog state
  const [downloadDialogOpen, setDownloadDialogOpen] = React.useState(false);
  const [selectedResult, setSelectedResult] =
    React.useState<SearchResult | null>(null);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (query.trim()) {
      performSearch(query);
    }
  };

  const handleSort = (key: string) => {
    const direction =
      sortConfig.key === key && sortConfig.direction === 'asc' ? 'desc' : 'asc';
    setSortConfig(key, direction);
  };

  const handleDownload = (result: SearchResult) => {
    setSelectedResult(result);
    setDownloadDialogOpen(true);
  };

  const handleConfirmDownload = async (result: SearchResult) => {
    const downloadId = `${result.indexerId}-${result.guid || result.id || Date.now()}`;
    const downloadTitle = result.title || result.name || 'Unknown';

    // Add to download tracker
    if ((window as any).downloadTracker) {
      (window as any).downloadTracker.addDownload(downloadId, downloadTitle);
      (window as any).downloadTracker.updateDownloadStatus(
        downloadId,
        'downloading'
      );
    }

    try {
      await grabResult(result);

      // Update status to completed
      if ((window as any).downloadTracker) {
        (window as any).downloadTracker.updateDownloadStatus(
          downloadId,
          'completed'
        );
      }

      setDownloadDialogOpen(false);
      setSelectedResult(null);
    } catch (error) {
      console.error('Download failed:', error);

      // Update status to failed
      if ((window as any).downloadTracker) {
        const errorMessage =
          error instanceof Error ? error.message : 'Download failed';
        (window as any).downloadTracker.updateDownloadStatus(
          downloadId,
          'failed',
          errorMessage
        );
      }

      setDownloadDialogOpen(false);
      setSelectedResult(null);
    }
  };

  const handleCloseDialog = () => {
    if (!isGrabbing) {
      setDownloadDialogOpen(false);
      setSelectedResult(null);
    }
  };

  // Show configuration warning if Prowlarr is not configured
  if (!isProwlarrConfigured) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Manual Search</h1>
          <p className="text-muted-foreground mt-2">
            Advanced manual search across indexers for specific releases (via
            Prowlarr)
          </p>
        </div>

        <Card>
          <CardContent>
            <div className="flex items-center space-x-4 p-6">
              <div className="flex-shrink-0">
                <AlertCircle className="h-8 w-8 text-yellow-600" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Prowlarr Configuration Required
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  To use the search functionality, please configure Prowlarr in
                  your settings. Prowlarr acts as your indexer manager and
                  search proxy.
                </p>
                <div className="mt-4">
                  <Button
                    onClick={() => navigate('/settings')}
                    variant="default"
                  >
                    <Settings className="h-4 w-4 mr-2" />
                    Configure Prowlarr
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Show indexer loading or empty state
  if (isLoadingIndexers) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Manual Search</h1>
          <p className="text-muted-foreground mt-2">
            Advanced manual search across indexers for specific releases (via
            Prowlarr)
          </p>
        </div>

        <Card>
          <CardContent>
            <LoadingState
              variant="spinner"
              message="Loading indexers..."
              size="md"
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Manual Search</h1>
        <p className="text-muted-foreground mt-2">
          Advanced manual search across indexers for specific releases (via
          Prowlarr)
        </p>
        <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <p className="text-sm text-blue-800 dark:text-blue-200">
            💡 <strong>Tip:</strong> For adding content to your library, use the{' '}
            <a href="/discover" className="underline hover:no-underline">
              Discover
            </a>{' '}
            page instead. This manual search is for advanced users who need
            specific releases.
          </p>
        </div>
      </div>

      {/* Search Interface */}
      <Card>
        <CardHeader
          title="Search Content"
          subtitle={
            hasIndexers
              ? `Search across ${indexers.filter(i => i.enable).length} active indexers`
              : 'No active indexers found'
          }
        />
        <CardContent>
          <div className="space-y-6">
            {/* Search Input */}
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              onSearch={handleSearch}
              placeholder="Search for movies, TV shows, music..."
              disabled={!canSearch || !hasIndexers}
              isLoading={isSearching}
            />

            {/* Filters */}
            {hasIndexers && (
              <SearchFilters
                searchType={searchType}
                onSearchTypeChange={setSearchType}
                indexers={indexers}
                selectedIndexers={selectedIndexers}
                onIndexerToggle={toggleIndexer}
              />
            )}

            {/* No indexers warning */}
            {!hasIndexers && (
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                <div className="flex items-start space-x-3">
                  <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5" />
                  <div>
                    <h3 className="font-medium text-yellow-800 dark:text-yellow-200">
                      No Indexers Available
                    </h3>
                    <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                      No indexers are currently configured or enabled in
                      Prowlarr. Please configure indexers in Prowlarr to enable
                      search functionality.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Search Stats */}
            {hasIndexers && searchQuery && (
              <div className="text-sm text-gray-600 dark:text-gray-400">
                <div className="flex items-center space-x-4">
                  <span>Query: "{searchQuery}"</span>
                  <span>
                    Type: {searchType === 'movie' ? 'Movies' : 'TV Shows'}
                  </span>
                  <span>Indexers: {selectedIndexers.size} selected</span>
                  {sortedResults.length > 0 && (
                    <span>Results: {sortedResults.length}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Search Results */}
      {(isSearching ||
        sortedResults.length > 0 ||
        (searchQuery && !isSearching)) && (
        <SearchResults
          results={sortedResults}
          onDownload={handleDownload}
          onSort={handleSort}
          sortConfig={sortConfig}
          isLoading={isSearching}
        />
      )}

      {/* Quick Tips */}
      {!searchQuery && hasIndexers && (
        <Card>
          <CardHeader
            title="Search Tips"
            subtitle="Get the most out of your search experience"
          />
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
              <div className="flex items-start space-x-3">
                <SearchIcon className="h-5 w-5 text-blue-500 mt-0.5" />
                <div>
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">
                    Specific Searches
                  </h4>
                  <p className="text-gray-600 dark:text-gray-400">
                    Use specific titles for better results
                  </p>
                </div>
              </div>
              <div className="flex items-start space-x-3">
                <SearchIcon className="h-5 w-5 text-green-500 mt-0.5" />
                <div>
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">
                    Year Filtering
                  </h4>
                  <p className="text-gray-600 dark:text-gray-400">
                    Add year to narrow down results (e.g., "Movie 2023")
                  </p>
                </div>
              </div>
              <div className="flex items-start space-x-3">
                <SearchIcon className="h-5 w-5 text-purple-500 mt-0.5" />
                <div>
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">
                    Quality Tags
                  </h4>
                  <p className="text-gray-600 dark:text-gray-400">
                    Include quality terms like "1080p" or "4K"
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Download Confirmation Dialog */}
      <DownloadConfirmDialog
        result={selectedResult}
        isOpen={downloadDialogOpen}
        onClose={handleCloseDialog}
        onConfirm={handleConfirmDownload}
        isDownloading={isGrabbing}
      />

      {/* Download Status Tracker */}
      <DownloadStatusTracker />
    </div>
  );
};
