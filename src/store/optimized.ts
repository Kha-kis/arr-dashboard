import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { shallow } from 'zustand/shallow';
import {
  AppConfig,
  ServiceConfig,
  SystemStatus,
  QueueItem,
  Indexer,
  SearchResult,
} from '@/types';
import { ApiClientManager } from '@/services/api';

// Optimized state slices
interface ConfigState {
  config: AppConfig;
  theme: 'light' | 'dark';
  apiManager?: ApiClientManager;
}

interface ServiceState {
  sonarrStatus: SystemStatus | null;
  radarrStatus: SystemStatus | null;
  prowlarrStatus: SystemStatus | null;
  sonarrQueue: QueueItem[];
  radarrQueue: QueueItem[];
  indexers: Indexer[];
}

interface UIState {
  loading: boolean;
  error: string | null;
  autoRefresh: boolean;
  refreshInterval: number;
}

interface SearchState {
  searchQuery: string;
  searchType: 'movie' | 'tv';
  selectedIndexers: Set<number>;
  isSearching: boolean;
  searchResults: SearchResult[];
}

interface SelectionState {
  selectedSonarrItems: Set<string | number>;
  selectedRadarrItems: Set<string | number>;
}

// Combined state type
type AppState = ConfigState & ServiceState & UIState & SearchState & SelectionState & {
  // Config actions
  updateConfig: (config: Partial<AppConfig>) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  initializeApiManager: () => void;
  
  // Service actions (optimized)
  updateStatus: (service: 'sonarr' | 'radarr' | 'prowlarr', status: SystemStatus) => void;
  updateQueue: (service: 'sonarr' | 'radarr', queue: QueueItem[]) => void;
  updateIndexers: (indexers: Indexer[]) => void;
  
  // UI actions (optimized)
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setAutoRefresh: (enabled: boolean) => void;
  
  // Search actions (optimized)
  setSearchQuery: (query: string) => void;
  setSearchType: (type: 'movie' | 'tv') => void;
  toggleIndexer: (indexerId: number) => void;
  updateSearchResults: (results: SearchResult[]) => void;
  setSearching: (searching: boolean) => void;
  
  // Selection actions (optimized)
  toggleSelection: (service: 'sonarr' | 'radarr', id: string | number) => void;
  selectAll: (service: 'sonarr' | 'radarr', ids: (string | number)[]) => void;
  clearSelection: (service: 'sonarr' | 'radarr') => void;
};

const defaultConfig: AppConfig = {
  sonarr: [],
  radarr: [],
  prowlarr: [],
};

export const useAppStore = create<AppState>()(
  persist(
    subscribeWithSelector(
      immer((set, get) => ({
        // Initial state
        config: defaultConfig,
        theme: 'light',
        
        sonarrStatus: null,
        radarrStatus: null,
        prowlarrStatus: null,
        sonarrQueue: [],
        radarrQueue: [],
        indexers: [],
        
        loading: false,
        error: null,
        autoRefresh: true,
        refreshInterval: 30,
        
        searchQuery: '',
        searchType: 'movie',
        selectedIndexers: new Set(),
        isSearching: false,
        searchResults: [],
        
        selectedSonarrItems: new Set(),
        selectedRadarrItems: new Set(),
        
        // Optimized actions using immer
        updateConfig: (newConfig) => {
          set((state) => {
            state.config = { ...state.config, ...newConfig };
          });
          get().initializeApiManager();
        },
        
        setTheme: (theme) => {
          set((state) => {
            state.theme = theme;
          });
        },
        
        initializeApiManager: () => {
          const { config } = get();
          const apiManager = new ApiClientManager(config);
          set((state) => {
            state.apiManager = apiManager;
          });
        },
        
        updateStatus: (service, status) => {
          set((state) => {
            switch (service) {
              case 'sonarr':
                state.sonarrStatus = status;
                break;
              case 'radarr':
                state.radarrStatus = status;
                break;
              case 'prowlarr':
                state.prowlarrStatus = status;
                break;
            }
          });
        },
        
        updateQueue: (service, queue) => {
          set((state) => {
            if (service === 'sonarr') {
              state.sonarrQueue = queue;
            } else {
              state.radarrQueue = queue;
            }
          });
        },
        
        updateIndexers: (indexers) => {
          set((state) => {
            state.indexers = indexers;
          });
        },
        
        setLoading: (loading) => {
          set((state) => {
            state.loading = loading;
          });
        },
        
        setError: (error) => {
          set((state) => {
            state.error = error;
          });
        },
        
        setAutoRefresh: (enabled) => {
          set((state) => {
            state.autoRefresh = enabled;
          });
        },
        
        setSearchQuery: (query) => {
          set((state) => {
            state.searchQuery = query;
          });
        },
        
        setSearchType: (type) => {
          set((state) => {
            state.searchType = type;
          });
        },
        
        toggleIndexer: (indexerId) => {
          set((state) => {
            const newSet = new Set(state.selectedIndexers);
            if (newSet.has(indexerId)) {
              newSet.delete(indexerId);
            } else {
              newSet.add(indexerId);
            }
            state.selectedIndexers = newSet;
          });
        },
        
        updateSearchResults: (results) => {
          set((state) => {
            state.searchResults = results;
          });
        },
        
        setSearching: (searching) => {
          set((state) => {
            state.isSearching = searching;
          });
        },
        
        toggleSelection: (service, id) => {
          set((state) => {
            const selectionSet = service === 'sonarr' ? state.selectedSonarrItems : state.selectedRadarrItems;
            const newSet = new Set(selectionSet);
            if (newSet.has(id)) {
              newSet.delete(id);
            } else {
              newSet.add(id);
            }
            
            if (service === 'sonarr') {
              state.selectedSonarrItems = newSet;
            } else {
              state.selectedRadarrItems = newSet;
            }
          });
        },
        
        selectAll: (service, ids) => {
          set((state) => {
            if (service === 'sonarr') {
              state.selectedSonarrItems = new Set(ids);
            } else {
              state.selectedRadarrItems = new Set(ids);
            }
          });
        },
        
        clearSelection: (service) => {
          set((state) => {
            if (service === 'sonarr') {
              state.selectedSonarrItems = new Set();
            } else {
              state.selectedRadarrItems = new Set();
            }
          });
        },
      }))
    ),
    {
      name: 'unified-arr-dashboard',
      partialize: (state) => ({
        config: state.config,
        theme: state.theme,
        autoRefresh: state.autoRefresh,
        refreshInterval: state.refreshInterval,
      }),
    }
  )
);

// Optimized selectors to prevent unnecessary re-renders
export const useConfig = () => useAppStore((state) => state.config);
export const useTheme = () => useAppStore((state) => state.theme);
export const useApiManager = () => useAppStore((state) => state.apiManager);

export const useServiceStatus = (service: 'sonarr' | 'radarr' | 'prowlarr') => {
  return useAppStore((state) => {
    switch (service) {
      case 'sonarr':
        return state.sonarrStatus;
      case 'radarr':
        return state.radarrStatus;
      case 'prowlarr':
        return state.prowlarrStatus;
    }
  });
};

export const useServiceQueue = (service: 'sonarr' | 'radarr') => {
  return useAppStore((state) => service === 'sonarr' ? state.sonarrQueue : state.radarrQueue);
};

export const useUIState = () => {
  return useAppStore(
    (state) => ({
      loading: state.loading,
      error: state.error,
      autoRefresh: state.autoRefresh,
      refreshInterval: state.refreshInterval,
    }),
    shallow
  );
};

export const useSearchState = () => {
  return useAppStore(
    (state) => ({
      searchQuery: state.searchQuery,
      searchType: state.searchType,
      selectedIndexers: state.selectedIndexers,
      isSearching: state.isSearching,
      searchResults: state.searchResults,
    }),
    shallow
  );
};

export const useSelectionState = (service: 'sonarr' | 'radarr') => {
  return useAppStore((state) => 
    service === 'sonarr' ? state.selectedSonarrItems : state.selectedRadarrItems
  );
};

// Combined selectors for performance
export const useServiceData = (service: 'sonarr' | 'radarr') => {
  return useAppStore(
    (state) => ({
      status: service === 'sonarr' ? state.sonarrStatus : state.radarrStatus,
      queue: service === 'sonarr' ? state.sonarrQueue : state.radarrQueue,
      selected: service === 'sonarr' ? state.selectedSonarrItems : state.selectedRadarrItems,
    }),
    shallow
  );
};