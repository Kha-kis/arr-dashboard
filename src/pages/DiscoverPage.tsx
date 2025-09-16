import React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Card,
  CardHeader,
  CardContent,
  Button,
  Dialog,
  FormField,
  Select,
  Switch,
} from '@/components/ui';
import { SearchInput } from '@/components/search';
import { useAppStore } from '@/store';
import { getPlaceholderImage } from '@/utils/images';
import { Plus, Star, Settings, Film, Tv, CheckCircle } from 'lucide-react';

interface SearchResult {
  title: string;
  year?: number;
  overview?: string;
  poster?: string;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  status?: string;
  network?: string;
  genres?: string[];
  runtime?: number;
  rating?: number;
  seasons?: number;
  type: 'movie' | 'series';
  isAlreadyAdded?: boolean;
}

interface AddContentDialogProps {
  result: SearchResult | null;
  isOpen: boolean;
  onClose: () => void;
  onAdd: (result: SearchResult, options: any) => Promise<void>;
  isAdding: boolean;
}

const AddContentDialog: React.FC<AddContentDialogProps> = ({
  result,
  isOpen,
  onClose,
  onAdd,
  isAdding,
}) => {
  const { apiManager } = useAppStore();
  const [qualityProfiles, setQualityProfiles] = React.useState<any[]>([]);
  const [rootFolders, setRootFolders] = React.useState<any[]>([]);
  const [selectedQualityProfile, setSelectedQualityProfile] = React.useState<
    number | null
  >(null);
  const [selectedRootFolder, setSelectedRootFolder] =
    React.useState<string>('');
  const [monitored, setMonitored] = React.useState(true);
  const [searchOnAdd, setSearchOnAdd] = React.useState(true);

  React.useEffect(() => {
    if (isOpen && result) {
      loadProfiles();
    }
  }, [isOpen, result]);

  const loadProfiles = async () => {
    try {
      if (result?.type === 'movie' && apiManager?.isConfigured('radarr')) {
        const [profiles, folders] = await Promise.all([
          apiManager.radarr.getQualityProfiles(),
          apiManager.radarr.getRootFolders(),
        ]);
        setQualityProfiles(profiles);
        setRootFolders(folders);
        if (profiles.length > 0) setSelectedQualityProfile(profiles[0].id);
        if (folders.length > 0) setSelectedRootFolder(folders[0].path);
      } else if (
        result?.type === 'series' &&
        apiManager?.isConfigured('sonarr')
      ) {
        const [profiles, folders] = await Promise.all([
          apiManager.sonarr.getQualityProfiles(),
          apiManager.sonarr.getRootFolders(),
        ]);
        setQualityProfiles(profiles);
        setRootFolders(folders);
        if (profiles.length > 0) setSelectedQualityProfile(profiles[0].id);
        if (folders.length > 0) setSelectedRootFolder(folders[0].path);
      }
    } catch (error) {
      toast.error('Failed to load profiles and folders');
    }
  };

  const handleAdd = async () => {
    if (!result || !selectedQualityProfile || !selectedRootFolder) return;

    const options = {
      qualityProfileId: selectedQualityProfile,
      rootFolderPath: selectedRootFolder,
      monitored,
      searchOnAdd,
    };

    await onAdd(result, options);
  };

  if (!isOpen || !result) return null;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={`${result.title} ${result.year ? `(${result.year})` : ''}`}
      description={`Add to ${result.type === 'movie' ? 'Radarr' : 'Sonarr'}`}
      size="md"
    >
      <div className="space-y-6">
        {/* Poster and info */}
        {result.poster && (
          <div className="flex items-start space-x-4">
            <img
              src={result.poster}
              alt={result.title}
              className="w-16 h-24 object-cover rounded-lg"
            />
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-card-foreground truncate">
                {result.title}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                {result.type === 'movie' ? 'Movie' : 'TV Series'}
                {result.year && ` • ${result.year}`}
              </p>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <FormField
            label="Quality Profile"
            description="Select the quality profile for this content"
            required
          >
            <Select
              value={selectedQualityProfile?.toString() || ''}
              onChange={e => setSelectedQualityProfile(Number(e.target.value))}
              options={qualityProfiles.map(profile => ({
                value: profile.id.toString(),
                label: profile.name,
              }))}
              placeholder="Select quality profile"
            />
          </FormField>

          <FormField
            label="Root Folder"
            description="Choose where to store the downloaded content"
            required
          >
            <Select
              value={selectedRootFolder}
              onChange={e => setSelectedRootFolder(e.target.value)}
              options={rootFolders.map(folder => ({
                value: folder.path,
                label: folder.path,
              }))}
              placeholder="Select root folder"
            />
          </FormField>

          <div className="space-y-4">
            <Switch
              checked={monitored}
              onChange={setMonitored}
              label="Monitor for new releases"
            />

            <Switch
              checked={searchOnAdd}
              onChange={setSearchOnAdd}
              label="Search immediately after adding"
            />
          </div>
        </div>

        {/* Dialog Actions */}
        <div className="flex justify-end gap-3 pt-6 border-t border-border">
          <Button variant="ghost" onClick={onClose} disabled={isAdding}>
            Cancel
          </Button>
          <Button
            onClick={handleAdd}
            disabled={
              isAdding || !selectedQualityProfile || !selectedRootFolder
            }
            loading={isAdding}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add {result.type === 'movie' ? 'Movie' : 'Series'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export const DiscoverPage: React.FC = () => {
  const navigate = useNavigate();
  const { apiManager, config } = useAppStore();
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchType, setSearchType] = React.useState<'movie' | 'series'>(
    'movie'
  );
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const [selectedResult, setSelectedResult] =
    React.useState<SearchResult | null>(null);
  const [showAddDialog, setShowAddDialog] = React.useState(false);
  const [isAdding, setIsAdding] = React.useState(false);
  const [existingMovies, setExistingMovies] = React.useState<any[]>([]);
  const [existingSeries, setExistingSeries] = React.useState<any[]>([]);
  const [, setIsLoadingExisting] = React.useState(false);

  const canSearchMovies = apiManager?.isConfigured('radarr');
  const canSearchSeries = apiManager?.isConfigured('sonarr');
  const canSearch =
    (searchType === 'movie' && canSearchMovies) ||
    (searchType === 'series' && canSearchSeries);

  // Load existing content on component mount and when services change
  React.useEffect(() => {
    loadExistingContent();
  }, [canSearchMovies, canSearchSeries]);

  const loadExistingContent = async () => {
    setIsLoadingExisting(true);
    try {
      const promises = [];

      if (canSearchMovies && apiManager) {
        promises.push(
          apiManager.radarr.getMovies().then(movies => {
            setExistingMovies(movies);
            return movies;
          })
        );
      }

      if (canSearchSeries && apiManager) {
        promises.push(
          apiManager.sonarr.getSeries().then(series => {
            setExistingSeries(series);
            return series;
          })
        );
      }

      await Promise.all(promises);
    } catch (error) {
      console.error('Failed to load existing content:', error);
    } finally {
      setIsLoadingExisting(false);
    }
  };

  const isContentAlreadyAdded = (
    item: any,
    type: 'movie' | 'series'
  ): boolean => {
    if (type === 'movie') {
      return existingMovies.some(
        movie =>
          movie.tmdbId === item.tmdbId ||
          (movie.imdbId && item.imdbId && movie.imdbId === item.imdbId)
      );
    } else {
      return existingSeries.some(
        show =>
          show.tvdbId === item.tvdbId ||
          (show.imdbId && item.imdbId && show.imdbId === item.imdbId)
      );
    }
  };

  const performSearch = async (query: string) => {
    if (!query.trim() || !canSearch) return;

    setIsSearching(true);
    try {
      let searchResults: any[] = [];

      if (searchType === 'movie' && apiManager?.isConfigured('radarr')) {
        searchResults = await apiManager.radarr.searchMovies(query);
      } else if (
        searchType === 'series' &&
        apiManager?.isConfigured('sonarr')
      ) {
        searchResults = await apiManager.sonarr.searchSeries(query);
      }

      // Transform results to common format and check if already added
      const transformedResults: SearchResult[] = searchResults.map(item => {
        const isAlreadyAdded = isContentAlreadyAdded(item, searchType);

        return {
          title: item.title || item.name,
          year:
            item.year ||
            (item.firstAired
              ? new Date(item.firstAired).getFullYear()
              : undefined),
          overview: item.overview,
          // Handle images with same logic as Library page
          poster: (() => {
            if (item.images && item.images.length > 0) {
              const posterImage = item.images.find(
                (img: any) => img.coverType === 'poster'
              );
              if (posterImage) {
                // First try to use the remote URL (TMDB/TVDb) if available
                if (
                  posterImage.remoteUrl &&
                  posterImage.remoteUrl.startsWith('http')
                ) {
                  return posterImage.remoteUrl;
                } else if (posterImage.url) {
                  // Handle local image URL - need to construct proper URL
                  const baseUrl = (
                    searchType === 'movie'
                      ? config.radarr.baseUrl
                      : config.sonarr.baseUrl
                  ).replace(/\/$/, '');
                  const servicePath =
                    searchType === 'movie' ? '/radarr/' : '/sonarr/';
                  const imageUrl = posterImage.url;

                  // If the image URL already contains the service path, use base server URL only
                  if (imageUrl.includes(servicePath)) {
                    const serverUrl = baseUrl.replace(
                      servicePath.slice(0, -1),
                      ''
                    ); // Remove service path from base URL
                    return `http://localhost:3001/api/proxy?url=${encodeURIComponent(serverUrl + imageUrl)}`;
                  } else {
                    return `http://localhost:3001/api/proxy?url=${encodeURIComponent(baseUrl + imageUrl)}`;
                  }
                }
              }
            }
            return getPlaceholderImage(
              searchType === 'movie' ? 'movie' : 'series'
            );
          })(),
          tmdbId: item.tmdbId,
          tvdbId: item.tvdbId,
          imdbId: item.imdbId,
          status: item.status,
          network: item.network,
          genres: item.genres,
          runtime: item.runtime,
          rating: item.ratings?.imdb?.value,
          seasons: item.seasons?.length,
          type: searchType,
          isAlreadyAdded: isAlreadyAdded,
        };
      });

      setResults(transformedResults);
    } catch (error) {
      toast.error(
        `Failed to search ${searchType === 'movie' ? 'movies' : 'series'}`
      );
      console.error('Search error:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleAddContent = async (result: SearchResult, options: any) => {
    setIsAdding(true);
    try {
      // We need to find the original search result to get all required fields
      let originalResult: any = null;

      if (result.type === 'movie' && apiManager?.isConfigured('radarr')) {
        // Re-search to get the complete data structure
        const searchResults = await apiManager.radarr.searchMovies(
          result.title
        );
        originalResult = searchResults.find(
          (item: any) =>
            item.tmdbId === result.tmdbId ||
            (item.imdbId && result.imdbId && item.imdbId === result.imdbId)
        );
      } else if (
        result.type === 'series' &&
        apiManager?.isConfigured('sonarr')
      ) {
        const searchResults = await apiManager.sonarr.searchSeries(
          result.title
        );
        originalResult = searchResults.find(
          (item: any) =>
            item.tvdbId === result.tvdbId ||
            (item.imdbId && result.imdbId && item.imdbId === result.imdbId)
        );
      }

      if (!originalResult) {
        throw new Error('Could not find original search result');
      }

      // Use the original result with our selected options
      const contentData = {
        ...originalResult,
        qualityProfileId: options.qualityProfileId,
        rootFolderPath: options.rootFolderPath,
        monitored: options.monitored,
        addOptions: {
          searchForMovie: options.searchOnAdd, // For Radarr
          searchForMissingEpisodes: options.searchOnAdd, // For Sonarr
        },
      };

      if (result.type === 'movie' && apiManager?.isConfigured('radarr')) {
        await apiManager.radarr.addMovie(contentData);

        // Show appropriate success message based on search option
        if (options.searchOnAdd) {
          toast.success(`${result.title} added to Radarr and search started`);
        } else {
          toast.success(`${result.title} added to Radarr`);
        }
      } else if (
        result.type === 'series' &&
        apiManager?.isConfigured('sonarr')
      ) {
        await apiManager.sonarr.addSeries(contentData);

        // Show appropriate success message based on search option
        if (options.searchOnAdd) {
          toast.success(`${result.title} added to Sonarr and search started`);
        } else {
          toast.success(`${result.title} added to Sonarr`);
        }
      }

      // Refresh existing content to update duplicate detection
      await loadExistingContent();

      setShowAddDialog(false);
      setSelectedResult(null);
    } catch (error) {
      console.error('Add error:', error);

      // Handle specific error cases
      if (error instanceof Error && error.message.includes('400 Bad Request')) {
        if (error.message.includes('already been added')) {
          toast.error(`${result.title} is already in your library`);
        } else {
          toast.error(`Failed to add ${result.title}: ${error.message}`);
        }
      } else {
        toast.error(`Failed to add ${result.title}`);
      }
    } finally {
      setIsAdding(false);
    }
  };

  const handleAddClick = (result: SearchResult) => {
    setSelectedResult(result);
    setShowAddDialog(true);
  };

  // Show configuration warning if neither service is configured
  if (!canSearchMovies && !canSearchSeries) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Discover Content</h1>
          <p className="text-muted-foreground mt-2">
            Add movies and TV shows to your library
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
                  shows) to discover and add content to your library.
                </p>
                <Button onClick={() => navigate('/settings')} variant="default">
                  <Settings className="h-4 w-4 mr-2" />
                  Go to Settings
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Discover Content</h1>
        <p className="text-muted-foreground mt-2">
          Search and add movies and TV shows to your library
        </p>
      </div>

      <Card>
        <CardHeader
          title="Content Search"
          subtitle="Search for movies and TV shows to add to your library"
        />
        <CardContent>
          <div className="space-y-4">
            {/* Search Type Toggle */}
            <div className="flex space-x-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
              <button
                onClick={() => setSearchType('movie')}
                disabled={!canSearchMovies}
                className={`flex-1 flex items-center justify-center space-x-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                  searchType === 'movie'
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                } ${!canSearchMovies ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Film className="h-4 w-4" />
                <span>Movies</span>
              </button>
              <button
                onClick={() => setSearchType('series')}
                disabled={!canSearchSeries}
                className={`flex-1 flex items-center justify-center space-x-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                  searchType === 'series'
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                } ${!canSearchSeries ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Tv className="h-4 w-4" />
                <span>TV Shows</span>
              </button>
            </div>

            {/* Search Input */}
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              onSearch={performSearch}
              placeholder={`Search for ${searchType === 'movie' ? 'movies' : 'TV shows'}...`}
              disabled={!canSearch}
              isLoading={isSearching}
            />
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {results.length > 0 && (
        <Card>
          <CardHeader
            title="Search Results"
            subtitle={`Found ${results.length} ${searchType === 'movie' ? 'movies' : 'TV shows'}`}
          />
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {results.map((result, index) => (
                <div
                  key={index}
                  className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  <div className="flex space-x-3">
                    {result.poster && (
                      <img
                        src={result.poster}
                        alt={result.title}
                        className="w-16 h-24 object-cover rounded"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-gray-900 dark:text-gray-100 truncate">
                        {result.title}
                      </h3>
                      {result.year && (
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {result.year}
                        </p>
                      )}
                      {result.rating && (
                        <div className="flex items-center mt-1">
                          <Star className="h-4 w-4 text-yellow-400 mr-1" />
                          <span className="text-sm text-gray-600 dark:text-gray-400">
                            {result.rating.toFixed(1)}
                          </span>
                        </div>
                      )}

                      {/* Show status based on whether already added */}
                      {result.isAlreadyAdded ? (
                        <div className="mt-2 inline-flex items-center px-3 py-1 text-sm bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          In Library
                        </div>
                      ) : (
                        <button
                          onClick={() => handleAddClick(result)}
                          className="mt-2 inline-flex items-center px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                          <Plus className="h-3 w-3 mr-1" />
                          Add
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add Content Dialog */}
      <AddContentDialog
        result={selectedResult}
        isOpen={showAddDialog}
        onClose={() => {
          setShowAddDialog(false);
          setSelectedResult(null);
        }}
        onAdd={handleAddContent}
        isAdding={isAdding}
      />
    </div>
  );
};
