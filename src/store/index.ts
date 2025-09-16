import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  AppConfig,
  SystemStatus,
  QueueItem,
  Indexer,
  SearchResult,
  FilterPreset,
  NotificationRule,
  Statistics,
  DownloadHistoryItem,
  CalendarItem,
} from '@/types';
import { ApiClientManager } from '@/services/api';
import { getFromStorage, setToStorage } from '@/utils';

interface AppState {
  // Configuration
  config: AppConfig;
  theme: 'light' | 'dark';

  // API clients
  apiManager?: ApiClientManager;

  // Status
  sonarrStatus: SystemStatus | null;
  radarrStatus: SystemStatus | null;
  prowlarrStatus: SystemStatus | null;

  // Queue data
  sonarrQueue: QueueItem[];
  radarrQueue: QueueItem[];

  // Prowlarr data
  indexers: Indexer[];
  searchResults: SearchResult[];

  // UI state
  loading: boolean;
  error: string | null;
  autoRefresh: boolean;
  refreshInterval: number;

  // Search state
  searchQuery: string;
  searchType: 'movie' | 'tv';
  selectedIndexers: Set<number>;
  isSearching: boolean;

  // Selection state
  selectedSonarrItems: Set<string | number>;
  selectedRadarrItems: Set<string | number>;

  // Filter state
  sonarrFilter: string;
  radarrFilter: string;
  filterPresets: FilterPreset[];

  // Sort state
  sortConfig: {
    key: string;
    direction: 'asc' | 'desc';
  };

  // Advanced features
  notifications: NotificationRule[];
  statistics: Statistics | null;
  downloadHistory: DownloadHistoryItem[];
  calendarItems: CalendarItem[];

  // Actions
  updateConfig: (config: Partial<AppConfig>) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  initializeApiManager: () => void;

  // Status actions
  updateStatus: (
    service: 'sonarr' | 'radarr' | 'prowlarr',
    status: SystemStatus
  ) => void;

  // Queue actions
  updateQueue: (service: 'sonarr' | 'radarr', queue: QueueItem[]) => void;
  clearQueues: () => void;

  // Selection actions
  toggleSelection: (service: 'sonarr' | 'radarr', id: string | number) => void;
  selectAll: (service: 'sonarr' | 'radarr', ids: (string | number)[]) => void;
  clearSelection: (service: 'sonarr' | 'radarr') => void;

  // Filter actions
  setFilter: (service: 'sonarr' | 'radarr', filter: string) => void;
  saveFilterPreset: (preset: FilterPreset) => void;
  deleteFilterPreset: (id: string) => void;

  // Search actions
  setSearchQuery: (query: string) => void;
  setSearchType: (type: 'movie' | 'tv') => void;
  toggleIndexer: (indexerId: number) => void;
  updateSearchResults: (results: SearchResult[]) => void;
  setSearching: (searching: boolean) => void;

  // Sort actions
  setSortConfig: (key: string, direction: 'asc' | 'desc') => void;

  // UI actions
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setAutoRefresh: (enabled: boolean) => void;
  setRefreshInterval: (interval: number) => void;

  // Advanced feature actions
  updateIndexers: (indexers: Indexer[]) => void;
  addNotificationRule: (rule: NotificationRule) => void;
  updateNotificationRule: (id: string, rule: Partial<NotificationRule>) => void;
  deleteNotificationRule: (id: string) => void;
  updateStatistics: (stats: Statistics) => void;
  updateDownloadHistory: (history: DownloadHistoryItem[]) => void;
  updateCalendarItems: (items: CalendarItem[]) => void;
}

const defaultConfig: AppConfig = {
  sonarr: { baseUrl: '', apiKey: '' },
  radarr: { baseUrl: '', apiKey: '' },
  prowlarr: { baseUrl: '', apiKey: '' },
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Initial state
      config: defaultConfig,
      theme: 'light',

      sonarrStatus: null,
      radarrStatus: null,
      prowlarrStatus: null,

      sonarrQueue: [],
      radarrQueue: [],

      indexers: [],
      searchResults: [],

      loading: false,
      error: null,
      autoRefresh: true,
      refreshInterval: 30,

      searchQuery: '',
      searchType: 'movie',
      selectedIndexers: new Set(),
      isSearching: false,

      selectedSonarrItems: new Set(),
      selectedRadarrItems: new Set(),

      sonarrFilter: '',
      radarrFilter: '',
      filterPresets: [],

      sortConfig: { key: '', direction: 'asc' },

      notifications: [],
      statistics: null,
      downloadHistory: [],
      calendarItems: [],

      // Actions
      updateConfig: newConfig => {
        set(state => {
          const updatedConfig = { ...state.config, ...newConfig };
          // Update nested objects properly
          if (newConfig.sonarr) {
            updatedConfig.sonarr = {
              ...state.config.sonarr,
              ...newConfig.sonarr,
            };
          }
          if (newConfig.radarr) {
            updatedConfig.radarr = {
              ...state.config.radarr,
              ...newConfig.radarr,
            };
          }
          if (newConfig.prowlarr) {
            updatedConfig.prowlarr = {
              ...state.config.prowlarr,
              ...newConfig.prowlarr,
            };
          }

          return { config: updatedConfig };
        });
        get().initializeApiManager();
      },

      setTheme: theme => {
        set({ theme });
        setToStorage('unified_arr_theme', theme);
      },

      initializeApiManager: () => {
        const { config } = get();
        set({ apiManager: new ApiClientManager(config) });
      },

      updateStatus: (service, status) => {
        set(() => ({
          [`${service}Status`]: status,
        }));
      },

      updateQueue: (service, queue) => {
        set({ [`${service}Queue`]: queue });
      },

      clearQueues: () => {
        set({ sonarrQueue: [], radarrQueue: [] });
      },

      toggleSelection: (service, id) => {
        set(state => {
          const key =
            `selected${service.charAt(0).toUpperCase() + service.slice(1)}Items` as keyof AppState;
          const currentSet = new Set(state[key] as Set<string | number>);

          if (currentSet.has(id)) {
            currentSet.delete(id);
          } else {
            currentSet.add(id);
          }

          return { [key]: currentSet };
        });
      },

      selectAll: (service, ids) => {
        set(state => {
          const key =
            `selected${service.charAt(0).toUpperCase() + service.slice(1)}Items` as keyof AppState;
          const currentSet = new Set(state[key] as Set<string | number>);
          const allSelected = ids.every(id => currentSet.has(id));

          if (allSelected) {
            ids.forEach(id => currentSet.delete(id));
          } else {
            ids.forEach(id => currentSet.add(id));
          }

          return { [key]: currentSet };
        });
      },

      clearSelection: service => {
        const key =
          `selected${service.charAt(0).toUpperCase() + service.slice(1)}Items` as keyof AppState;
        set({ [key]: new Set() });
      },

      setFilter: (service, filter) => {
        const key = `${service}Filter` as keyof AppState;
        set({ [key]: filter });
      },

      saveFilterPreset: preset => {
        set(state => ({
          filterPresets: [...state.filterPresets, preset],
        }));
      },

      deleteFilterPreset: id => {
        set(state => ({
          filterPresets: state.filterPresets.filter(p => p.id !== id),
        }));
      },

      setSearchQuery: query => set({ searchQuery: query }),
      setSearchType: type => set({ searchType: type }),

      toggleIndexer: indexerId => {
        set(state => {
          const newSet = new Set(state.selectedIndexers);
          if (newSet.has(indexerId)) {
            newSet.delete(indexerId);
          } else {
            newSet.add(indexerId);
          }
          return { selectedIndexers: newSet };
        });
      },

      updateSearchResults: results => set({ searchResults: results }),
      setSearching: searching => set({ isSearching: searching }),

      setSortConfig: (key, direction) => {
        set({ sortConfig: { key, direction } });
      },

      setLoading: loading => set({ loading }),
      setError: error => set({ error }),
      setAutoRefresh: enabled => set({ autoRefresh: enabled }),
      setRefreshInterval: interval => set({ refreshInterval: interval }),

      updateIndexers: indexers => set({ indexers }),

      addNotificationRule: rule => {
        set(state => ({
          notifications: [...state.notifications, rule],
        }));
      },

      updateNotificationRule: (id, updates) => {
        set(state => ({
          notifications: state.notifications.map(rule =>
            rule.id === id ? { ...rule, ...updates } : rule
          ),
        }));
      },

      deleteNotificationRule: id => {
        set(state => ({
          notifications: state.notifications.filter(rule => rule.id !== id),
        }));
      },

      updateStatistics: stats => set({ statistics: stats }),
      updateDownloadHistory: history => set({ downloadHistory: history }),
      updateCalendarItems: items => set({ calendarItems: items }),
    }),
    {
      name: 'unified-arr-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({
        config: state.config,
        theme: state.theme,
        autoRefresh: state.autoRefresh,
        refreshInterval: state.refreshInterval,
        filterPresets: state.filterPresets,
        notifications: state.notifications,
        sortConfig: state.sortConfig,
      }),
      onRehydrateStorage: () => state => {
        if (state) {
          // Initialize API manager after rehydration
          state.initializeApiManager();
          // Convert Sets that may have been serialized as arrays
          state.selectedIndexers = new Set(state.selectedIndexers);
          state.selectedSonarrItems = new Set(state.selectedSonarrItems);
          state.selectedRadarrItems = new Set(state.selectedRadarrItems);
        }
      },
    }
  )
);

// Selectors for common data transformations
export const useFilteredQueue = (service: 'sonarr' | 'radarr') => {
  return useAppStore(state => {
    const queue = service === 'sonarr' ? state.sonarrQueue : state.radarrQueue;
    const filter =
      service === 'sonarr' ? state.sonarrFilter : state.radarrFilter;

    if (!filter) return queue;

    return queue.filter(item => {
      const title = item.title || item.series?.title || item.movie?.title || '';
      return title.toLowerCase().includes(filter.toLowerCase());
    });
  });
};

export const useSelectedItems = (service: 'sonarr' | 'radarr') => {
  return useAppStore(state => {
    return service === 'sonarr'
      ? state.selectedSonarrItems
      : state.selectedRadarrItems;
  });
};

export const useSortedSearchResults = () => {
  return useAppStore(state => {
    const { searchResults, sortConfig, indexers } = state;

    if (!sortConfig.key) return searchResults;

    const indexerScoreMap = new Map();
    indexers.forEach(indexer => {
      if (typeof indexer.priority === 'number') {
        indexerScoreMap.set(indexer.id, indexer.priority);
      }
    });

    return [...searchResults].sort((a, b) => {
      let aVal: any, bVal: any;

      switch (sortConfig.key) {
        case 'title':
          aVal = (a.title || a.name || '').toLowerCase();
          bVal = (b.title || b.name || '').toLowerCase();
          break;
        case 'indexer':
          aVal = (a.indexer || '').toLowerCase();
          bVal = (b.indexer || '').toLowerCase();
          break;
        case 'protocol':
          aVal = (a.protocol || '').toLowerCase();
          bVal = (b.protocol || '').toLowerCase();
          break;
        case 'size':
          aVal = Number(a.size) || 0;
          bVal = Number(b.size) || 0;
          break;
        case 'seeders':
          aVal = Number(a.seeders) || 0;
          bVal = Number(b.seeders) || 0;
          break;
        case 'score':
          const aIndexerId = a.indexerId;
          const bIndexerId = b.indexerId;
          aVal = indexerScoreMap.get(aIndexerId) || 0;
          bVal = indexerScoreMap.get(bIndexerId) || 0;
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  });
};

// Initialize theme from localStorage on module load
const savedTheme = getFromStorage('unified_arr_theme', 'light');
useAppStore.getState().setTheme(savedTheme);
