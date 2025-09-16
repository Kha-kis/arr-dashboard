import React from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { Toaster } from 'sonner';

// Pages
import { DashboardPage } from '@/pages/DashboardPage';
import { DiscoverPage } from '@/pages/DiscoverPage';
import { LibraryPage } from '@/pages/LibraryPage';
import { ManualSearchPage } from '@/pages/SearchPage';
import { IndexerPage } from '@/pages/IndexerPage';
import { CalendarPage } from '@/pages/CalendarPage';
import { StatisticsPage } from '@/pages/StatisticsPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { NotificationsPage } from '@/pages/NotificationsPage';
import { SettingsPage } from '@/pages/SettingsPage';

// Layout components
import { Header } from '@/components/layout/Header';
import { Sidebar } from '@/components/layout/Sidebar';
import { MobileNav } from '@/components/layout/MobileNav';
import { ErrorFallback } from '@/components/ErrorFallback';
import { ThemeToggle } from '@/components/ThemeToggle';

// Hooks
import { useAppStore } from '@/store';
import { useAutoRefresh, useConfigValidation } from '@/hooks';

// Utils
import { cn } from '@/utils';

// Icons
import {
  Home,
  Search,
  Compass,
  Library,
  Calendar,
  BarChart3,
  History,
  Bell,
  Settings,
  Radar,
} from 'lucide-react';

// Navigation configuration
const navigation = [
  {
    name: 'Dashboard',
    href: '/',
    icon: Home,
    shortcut: '1',
  },
  {
    name: 'Discover',
    href: '/discover',
    icon: Compass,
    shortcut: '2',
  },
  {
    name: 'Library',
    href: '/library',
    icon: Library,
    shortcut: '3',
  },
  {
    name: 'Calendar',
    href: '/calendar',
    icon: Calendar,
    shortcut: '4',
  },
  {
    name: 'Statistics',
    href: '/statistics',
    icon: BarChart3,
    shortcut: '5',
  },
  {
    name: 'History',
    href: '/history',
    icon: History,
    shortcut: '6',
  },
  {
    name: 'Notifications',
    href: '/notifications',
    icon: Bell,
    shortcut: '7',
  },
  {
    name: 'Manual Search',
    href: '/manual-search',
    icon: Search,
    shortcut: '8',
  },
  {
    name: 'Indexers',
    href: '/indexers',
    icon: Radar,
    shortcut: '9',
  },
  {
    name: 'Settings',
    href: '/settings',
    icon: Settings,
    shortcut: '0',
  },
];

// Create an optimized query client with intelligent caching and error handling
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000, // 2 minutes - shorter for more dynamic data
      cacheTime: 10 * 60 * 1000, // 10 minutes - keep cached longer
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      refetchIntervalInBackground: false,
      retry: (failureCount, error: any) => {
        // Don't retry on authentication errors
        if (error?.status === 401 || error?.status === 403) return false;
        // Don't retry on client errors (4xx) except for 408, 429
        if (
          error?.status >= 400 &&
          error?.status < 500 &&
          error?.status !== 408 &&
          error?.status !== 429
        )
          return false;
        // Retry up to 2 times for other errors
        return failureCount < 2;
      },
      retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
      // Enable background refetch for important data
      refetchInterval: (_, query) => {
        // Refresh queue data every 30 seconds
        if (query.queryKey.includes('queue')) return 30 * 1000;
        // Refresh status every 5 minutes
        if (query.queryKey.includes('status')) return 5 * 60 * 1000;
        // Don't auto-refresh other queries
        return false;
      },
    },
    mutations: {
      retry: (failureCount, error: any) => {
        // Don't retry mutations on client errors
        if (error?.status >= 400 && error?.status < 500) return false;
        return failureCount < 1; // Only retry mutations once
      },
      retryDelay: 1000,
    },
  },
});

function AppContent() {
  const { theme, loading, error, setError, initializeApiManager } =
    useAppStore();

  const {} = useAutoRefresh();
  const { getConfigurationStatus } = useConfigValidation();

  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);

  // Initialize API manager on app start
  React.useEffect(() => {
    initializeApiManager();
  }, [initializeApiManager]);

  // Handle responsive layout
  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Apply theme to document
  React.useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  const configStatus = getConfigurationStatus();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Mobile backdrop */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <Sidebar
        navigation={navigation}
        isOpen={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main content */}
      <div
        className={cn(
          'transition-all duration-300 ease-in-out',
          isMobile ? 'ml-0' : sidebarOpen ? 'ml-64' : 'ml-16'
        )}
      >
        {/* Header */}
        <Header
          onMenuClick={() => setSidebarOpen(!sidebarOpen)}
          isMobile={isMobile}
        />

        {/* Page content */}
        <main className="p-6">
          {/* Configuration warning */}
          {!configStatus.hasAnyService && (
            <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <div className="flex items-start gap-3">
                <Settings className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5" />
                <div>
                  <h3 className="font-medium text-yellow-800 dark:text-yellow-200">
                    Configuration Required
                  </h3>
                  <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                    Please configure at least one service (Sonarr, Radarr, or
                    Prowlarr) to get started.
                  </p>
                  <button
                    className="mt-2 px-3 py-1.5 text-sm bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors"
                    onClick={() => (window.location.href = '/settings')}
                  >
                    Go to Settings
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Global error display */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <h3 className="font-medium text-red-800 dark:text-red-200">
                    Error
                  </h3>
                  <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                    {error}
                  </p>
                </div>
                <button
                  className="p-1 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200"
                  onClick={() => setError(null)}
                >
                  ×
                </button>
              </div>
            </div>
          )}

          {/* Loading indicator */}
          {loading && (
            <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600" />
                <p className="text-sm text-blue-700 dark:text-blue-300">
                  Loading data...
                </p>
              </div>
            </div>
          )}

          {/* Routes */}
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/manual-search" element={<ManualSearchPage />} />
            <Route path="/indexers" element={<IndexerPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/statistics" element={<StatisticsPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      {/* Mobile bottom navigation */}
      {isMobile && <MobileNav navigation={navigation} />}

      {/* Theme toggle (can be accessed via keyboard shortcut) */}
      <ThemeToggle />
    </div>
  );
}

// Error Boundary component
class AppErrorBoundary extends React.Component<
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
    console.error('Application Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          resetErrorBoundary={() =>
            this.setState({ hasError: false, error: undefined })
          }
        />
      );
    }

    return this.props.children;
  }
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <AppErrorBoundary>
          <AppContent />
        </AppErrorBoundary>
        <Toaster position="top-right" expand={false} richColors closeButton />
        {process.env.NODE_ENV === 'development' && (
          <ReactQueryDevtools initialIsOpen={false} />
        )}
      </Router>
    </QueryClientProvider>
  );
}
