import React from 'react';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui';
import { useAppStore } from '@/store';
import {
  Settings,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Search,
  Download,
  Rss,
  Globe,
  Activity,
  TestTube,
  Eye,
  EyeOff,
} from 'lucide-react';
import { Indexer } from '@/types';

interface IndexerCardProps {
  indexer: Indexer;
  onTest: (id: number) => void;
  onToggle: (id: number, enabled: boolean) => void;
  isLoading: boolean;
}

const IndexerCard: React.FC<IndexerCardProps> = ({
  indexer,
  onTest,
  onToggle,
  isLoading,
}) => {
  const getProtocolIcon = (protocol: string) => {
    return protocol === 'torrent' ? Download : Globe;
  };

  const getProtocolColor = (protocol: string) => {
    return protocol === 'torrent' ? 'text-green-600' : 'text-blue-600';
  };

  const getStatusColor = (enabled: boolean) => {
    return enabled ? 'text-green-600' : 'text-gray-400';
  };

  return (
    <div
      className={`p-4 border rounded-lg ${
        indexer.enable
          ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10'
          : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center space-x-3 mb-2">
            <h3 className="font-medium text-gray-900 dark:text-gray-100">
              {indexer.name}
            </h3>
            <div
              className={`flex items-center space-x-1 text-sm ${getStatusColor(indexer.enable)}`}
            >
              {indexer.enable ? (
                <CheckCircle className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              <span>{indexer.enable ? 'Enabled' : 'Disabled'}</span>
            </div>
          </div>

          <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
            <div className="flex items-center space-x-4">
              <div
                className={`flex items-center space-x-1 ${getProtocolColor(indexer.protocol)}`}
              >
                {React.createElement(getProtocolIcon(indexer.protocol), {
                  className: 'h-4 w-4',
                })}
                <span className="capitalize">{indexer.protocol}</span>
              </div>
              <div className="flex items-center space-x-1">
                <Activity className="h-4 w-4" />
                <span>Priority: {indexer.priority}</span>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              {indexer.supportsSearch && (
                <div className="flex items-center space-x-1 text-green-600">
                  <Search className="h-4 w-4" />
                  <span>Search</span>
                </div>
              )}
              {indexer.supportsRss && (
                <div className="flex items-center space-x-1 text-blue-600">
                  <Rss className="h-4 w-4" />
                  <span>RSS</span>
                </div>
              )}
            </div>

            <p className="text-xs">
              Implementation: {indexer.implementation} •{' '}
              {indexer.definitionName}
            </p>
          </div>

          {indexer.tags && indexer.tags.length > 0 && (
            <div className="mt-2">
              <div className="flex flex-wrap gap-1">
                {indexer.tags.map(tagId => (
                  <span
                    key={tagId}
                    className="px-2 py-1 text-xs bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded"
                  >
                    Tag {tagId}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center space-x-2 ml-4">
          <button
            onClick={() => onToggle(indexer.id, !indexer.enable)}
            disabled={isLoading}
            className={`p-2 rounded-lg ${
              indexer.enable
                ? 'text-green-600 hover:bg-green-100 dark:hover:bg-green-900/20'
                : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            } disabled:opacity-50`}
            title={indexer.enable ? 'Disable indexer' : 'Enable indexer'}
          >
            {indexer.enable ? (
              <Eye className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
          </button>

          <button
            onClick={() => onTest(indexer.id)}
            disabled={isLoading}
            className="p-2 text-blue-600 hover:bg-blue-100 dark:hover:bg-blue-900/20 rounded-lg disabled:opacity-50"
            title="Test indexer"
          >
            <TestTube className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export const IndexerPage: React.FC = () => {
  const { apiManager } = useAppStore();
  const [indexers, setIndexers] = React.useState<Indexer[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [testingIndexer, setTestingIndexer] = React.useState<number | null>(
    null
  );
  const [stats, setStats] = React.useState({
    total: 0,
    enabled: 0,
    torrent: 0,
    usenet: 0,
    searchEnabled: 0,
    rssEnabled: 0,
  });

  const isProwlarrConfigured = apiManager?.isConfigured('prowlarr');

  React.useEffect(() => {
    if (isProwlarrConfigured) {
      loadIndexers();
    }
  }, [isProwlarrConfigured]);

  React.useEffect(() => {
    // Calculate stats when indexers change
    const newStats = {
      total: indexers.length,
      enabled: indexers.filter(i => i.enable).length,
      torrent: indexers.filter(i => i.protocol === 'torrent').length,
      usenet: indexers.filter(i => i.protocol === 'usenet').length,
      searchEnabled: indexers.filter(i => i.supportsSearch && i.enable).length,
      rssEnabled: indexers.filter(i => i.supportsRss && i.enable).length,
    };
    setStats(newStats);
  }, [indexers]);

  const loadIndexers = async () => {
    if (!apiManager?.isConfigured('prowlarr')) return;

    setIsLoading(true);
    try {
      const indexersData = await apiManager.prowlarr.getIndexers();
      setIndexers(indexersData);
    } catch (error) {
      toast.error('Failed to load indexers');
      console.error('Load indexers error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestIndexer = async (id: number) => {
    if (!apiManager?.isConfigured('prowlarr')) return;

    setTestingIndexer(id);
    try {
      const result = await apiManager.prowlarr.testIndexer(id);
      if (result.isValid) {
        toast.success('Indexer test passed');
      } else {
        toast.error(`Indexer test failed: ${result.errors.join(', ')}`);
      }
    } catch (error) {
      toast.error('Failed to test indexer');
      console.error('Test indexer error:', error);
    } finally {
      setTestingIndexer(null);
    }
  };

  const handleToggleIndexer = async (_id: number, enabled: boolean) => {
    // This would require an API endpoint to update indexer settings
    toast.info(`${enabled ? 'Enable' : 'Disable'} indexer (API update needed)`);
  };

  // Show configuration warning if Prowlarr is not configured
  if (!isProwlarrConfigured) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Indexers</h1>
          <p className="text-muted-foreground mt-2">
            Manage your indexers and search providers
          </p>
        </div>

        <Card>
          <CardContent>
            <div className="flex items-center space-x-4 p-6">
              <AlertTriangle className="h-8 w-8 text-yellow-600" />
              <div className="flex-1">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Prowlarr Configuration Required
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  Please configure Prowlarr to manage your indexers and search
                  providers. Prowlarr centralizes indexer management for Sonarr
                  and Radarr.
                </p>
                <button
                  onClick={() => (window.location.href = '/settings')}
                  className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  <Settings className="h-4 w-4 mr-2" />
                  Configure Prowlarr
                </button>
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
        <h1 className="text-3xl font-bold">Indexers</h1>
        <p className="text-muted-foreground mt-2">
          Manage your indexers and search providers via Prowlarr
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Total</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {stats.total}
              </p>
            </div>
            <Globe className="h-8 w-8 text-gray-400" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Enabled
              </p>
              <p className="text-2xl font-bold text-green-600">
                {stats.enabled}
              </p>
            </div>
            <CheckCircle className="h-8 w-8 text-green-400" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Torrent
              </p>
              <p className="text-2xl font-bold text-green-600">
                {stats.torrent}
              </p>
            </div>
            <Download className="h-8 w-8 text-green-400" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Usenet</p>
              <p className="text-2xl font-bold text-blue-600">{stats.usenet}</p>
            </div>
            <Globe className="h-8 w-8 text-blue-400" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Search</p>
              <p className="text-2xl font-bold text-purple-600">
                {stats.searchEnabled}
              </p>
            </div>
            <Search className="h-8 w-8 text-purple-400" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">RSS</p>
              <p className="text-2xl font-bold text-orange-600">
                {stats.rssEnabled}
              </p>
            </div>
            <Rss className="h-8 w-8 text-orange-400" />
          </div>
        </div>
      </div>

      {/* Indexers List */}
      <Card>
        <CardHeader
          title="Indexers"
          subtitle={`Manage ${indexers.length} indexers`}
          actions={
            <button
              onClick={loadIndexers}
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
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3" />
              <span className="text-gray-600 dark:text-gray-400">
                Loading indexers...
              </span>
            </div>
          ) : indexers.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-gray-400 mb-4">
                <Globe className="h-12 w-12 mx-auto" />
              </div>
              <p className="text-gray-600 dark:text-gray-400">
                No indexers configured in Prowlarr
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-500 mt-1">
                Configure indexers in Prowlarr to see them here
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {indexers.map(indexer => (
                <IndexerCard
                  key={indexer.id}
                  indexer={indexer}
                  onTest={handleTestIndexer}
                  onToggle={handleToggleIndexer}
                  isLoading={testingIndexer === indexer.id}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      {indexers.length > 0 && (
        <Card>
          <CardHeader
            title="Quick Actions"
            subtitle="Bulk operations and utilities"
          />
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <button className="flex items-center space-x-3 p-4 text-left bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                <TestTube className="h-6 w-6 text-blue-500" />
                <div>
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">
                    Test All Indexers
                  </h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Verify all indexers are working
                  </p>
                </div>
              </button>

              <button className="flex items-center space-x-3 p-4 text-left bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                <RefreshCw className="h-6 w-6 text-green-500" />
                <div>
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">
                    Sync with Apps
                  </h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Push indexers to Sonarr/Radarr
                  </p>
                </div>
              </button>

              <a
                href="/manual-search"
                className="flex items-center space-x-3 p-4 text-left bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <Search className="h-6 w-6 text-purple-500" />
                <div>
                  <h4 className="font-medium text-gray-900 dark:text-gray-100">
                    Manual Search
                  </h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Search across all indexers
                  </p>
                </div>
              </a>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
