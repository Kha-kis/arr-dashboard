import React, { useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  CardHeader,
  CardContent,
  Button,
  LoadingState,
} from '@/components/ui';
import { useStatistics } from '@/hooks';
import { useAppStore } from '@/store';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Tv, Film, AlertTriangle, Monitor } from 'lucide-react';

interface HealthIssue {
  type: 'error' | 'warning' | 'info';
  source: string;
  message: string;
  wikiUrl?: string;
}

interface SystemAlert {
  type: 'error' | 'warning';
  service: string;
  serviceName: 'sonarr' | 'radarr' | 'prowlarr';
  message: string;
  action: string;
  healthIssues?: HealthIssue[];
  healthUrl: string;
}

interface IndexerData {
  name: string;
  queries: number;
  grabs: number;
  successRate: number;
}

const DISK_WARNING_THRESHOLD = 75;
const DISK_CRITICAL_THRESHOLD = 90;
const SUCCESS_RATE_WARNING = 70;
const MIN_INDEXER_ACTIVITY = 10;
const MAX_INDEXERS_DISPLAYED = 8;
const MAX_INDEXER_NAME_LENGTH = 12;

const formatStorageSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, unitIndex);
  return `${value.toFixed(1)} ${units[unitIndex]}`;
};

export const StatisticsPage: React.FC = () => {
  const navigate = useNavigate();
  const { apiManager } = useAppStore();

  const {
    data: sonarrData,
    isLoading: isSonarrLoading,
    error: sonarrError,
  } = useStatistics('sonarr');
  const {
    data: radarrData,
    isLoading: isRadarrLoading,
    error: radarrError,
  } = useStatistics('radarr');
  const {
    data: prowlarrData,
    isLoading: isProwlarrLoading,
    error: prowlarrError,
  } = useStatistics('prowlarr');

  // All hooks must be called before any conditional returns
  const getServiceHealthUrl = useCallback(
    (service: 'sonarr' | 'radarr' | 'prowlarr'): string => {
      if (!apiManager?.isConfigured(service)) return '#';

      // For now, we'll use a placeholder URL since we don't have direct config access
      // This would need to be implemented properly in the ApiClientManager
      return '#';
    },
    [apiManager]
  );

  const systemAlerts = useMemo((): SystemAlert[] => {
    const alerts: SystemAlert[] = [];

    if (sonarrData?.healthIssues > 0 && sonarrData?.health) {
      const healthIssues = sonarrData.health
        .filter((h: any) => h.type === 'error' || h.type === 'warning')
        .slice(0, 3); // Show top 3 issues

      alerts.push({
        type: 'error',
        service: 'Sonarr',
        serviceName: 'sonarr',
        message: `${sonarrData.healthIssues} health issue${sonarrData.healthIssues > 1 ? 's' : ''} detected`,
        action: 'Click to view details',
        healthIssues,
        healthUrl: getServiceHealthUrl('sonarr'),
      });
    }

    if (radarrData?.healthIssues > 0 && radarrData?.health) {
      const healthIssues = radarrData.health
        .filter((h: any) => h.type === 'error' || h.type === 'warning')
        .slice(0, 3);

      alerts.push({
        type: 'error',
        service: 'Radarr',
        serviceName: 'radarr',
        message: `${radarrData.healthIssues} health issue${radarrData.healthIssues > 1 ? 's' : ''} detected`,
        action: 'Click to view details',
        healthIssues,
        healthUrl: getServiceHealthUrl('radarr'),
      });
    }

    if (prowlarrData?.healthIssues > 0 && prowlarrData?.health) {
      const healthIssues = prowlarrData.health
        .filter((h: any) => h.type === 'error' || h.type === 'warning')
        .slice(0, 3);

      alerts.push({
        type: 'error',
        service: 'Prowlarr',
        serviceName: 'prowlarr',
        message: `${prowlarrData.healthIssues} health issue${prowlarrData.healthIssues > 1 ? 's' : ''} detected`,
        action: 'Click to view details',
        healthIssues,
        healthUrl: getServiceHealthUrl('prowlarr'),
      });
    }

    if (sonarrData?.usedPercentage > DISK_CRITICAL_THRESHOLD) {
      alerts.push({
        type: 'error',
        service: 'Sonarr',
        serviceName: 'sonarr',
        message: `Critical disk usage: ${sonarrData.usedPercentage}%`,
        action: 'Free up disk space immediately',
        healthUrl: getServiceHealthUrl('sonarr'),
      });
    }

    if (radarrData?.usedPercentage > DISK_CRITICAL_THRESHOLD) {
      alerts.push({
        type: 'error',
        service: 'Radarr',
        serviceName: 'radarr',
        message: `Critical disk usage: ${radarrData.usedPercentage}%`,
        action: 'Free up disk space immediately',
        healthUrl: getServiceHealthUrl('radarr'),
      });
    }

    if (
      prowlarrData?.successRate < SUCCESS_RATE_WARNING &&
      prowlarrData?.successRate > 0
    ) {
      alerts.push({
        type: 'warning',
        service: 'Prowlarr',
        serviceName: 'prowlarr',
        message: `Low success rate: ${prowlarrData.successRate}%`,
        action: 'Review indexer configuration',
        healthUrl: getServiceHealthUrl('prowlarr'),
      });
    }

    return alerts.slice(0, 5);
  }, [sonarrData, radarrData, prowlarrData, getServiceHealthUrl]);

  const activeIndexersData = useMemo((): IndexerData[] => {
    if (!prowlarrData?.indexerStats) return [];

    return prowlarrData.indexerStats
      .filter((indexer: any) => indexer.queries > MIN_INDEXER_ACTIVITY)
      .slice(0, MAX_INDEXERS_DISPLAYED)
      .map((indexer: any) => {
        const name = indexer.name || 'Unknown';
        const truncatedName =
          name.length > MAX_INDEXER_NAME_LENGTH
            ? `${name.substring(0, MAX_INDEXER_NAME_LENGTH)}...`
            : name;

        return {
          name: truncatedName,
          queries: Math.max(0, indexer.queries || 0),
          grabs: Math.max(0, indexer.grabs || 0),
          successRate:
            indexer.queries > 0
              ? Math.min(
                  100,
                  Math.max(
                    0,
                    Math.round((indexer.grabs / indexer.queries) * 100)
                  )
                )
              : 0,
        };
      });
  }, [prowlarrData]);

  // Computed values based on hook data
  const isLoading = isSonarrLoading || isRadarrLoading || isProwlarrLoading;
  const hasError = Boolean(sonarrError || radarrError || prowlarrError);
  const hasAnyService =
    apiManager?.isConfigured('sonarr') ||
    apiManager?.isConfigured('radarr') ||
    apiManager?.isConfigured('prowlarr');

  // Early return for unconfigured services
  if (!hasAnyService) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">System Status</h1>
          <p className="text-muted-foreground mt-2">
            Analytics and performance metrics for your media services
          </p>
        </div>

        <Card>
          <CardContent>
            <div className="flex items-center space-x-4 p-6">
              <AlertTriangle className="h-8 w-8 text-yellow-600" />
              <div className="flex-1">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Configuration Required
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  Configure at least one service (Sonarr, Radarr, or Prowlarr)
                  to view analytics.
                </p>
                <Button onClick={() => navigate('/settings')} variant="default">
                  Configure Services
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const renderServiceHealthCard = useCallback(
    (data: any, service: 'sonarr' | 'radarr' | 'prowlarr') => {
      if (!data) return null;

      const configs = {
        sonarr: {
          title: 'Sonarr',
          icon: Tv,
          color: 'text-blue-500',
          metrics: [
            { label: 'Series', value: data.totalSeries },
            {
              label: 'Episodes',
              value: `${data.downloadedEpisodes}/${data.totalEpisodes}`,
            },
            { label: 'Completion', value: `${data.downloadedPercentage}%` },
          ],
        },
        radarr: {
          title: 'Radarr',
          icon: Film,
          color: 'text-purple-500',
          metrics: [
            { label: 'Movies', value: data.totalMovies },
            { label: 'Downloaded', value: data.downloadedMovies },
            { label: 'Completion', value: `${data.downloadedPercentage}%` },
          ],
        },
        prowlarr: {
          title: 'Prowlarr',
          icon: Monitor,
          color: 'text-orange-500',
          metrics: [
            { label: 'Active Indexers', value: data.activeIndexers },
            { label: 'Success Rate', value: `${data.successRate}%` },
            {
              label: 'Total Queries',
              value: data.totalQueries?.toLocaleString(),
            },
          ],
        },
      };

      const config = configs[service];
      const IconComponent = config.icon;
      const isHealthy = data.healthIssues === 0;
      const hasStorageIssue = data.usedPercentage > DISK_WARNING_THRESHOLD;

      return (
        <Card key={service}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <IconComponent className={`h-8 w-8 ${config.color}`} />
                <h3 className="text-xl font-semibold">{config.title}</h3>
              </div>
              <div
                className={`text-sm font-medium ${
                  isHealthy ? 'text-green-600' : 'text-red-600'
                }`}
              >
                {isHealthy ? '✓ Healthy' : `⚠ ${data.healthIssues} Issues`}
              </div>
            </div>
            <div className="space-y-3">
              {config.metrics.map((metric, index) => (
                <div key={index} className="flex justify-between">
                  <span className="text-muted-foreground">{metric.label}</span>
                  <span
                    className={`font-medium ${
                      metric.label.includes('Success Rate') &&
                      data.successRate < SUCCESS_RATE_WARNING
                        ? 'text-yellow-600'
                        : metric.label.includes('Disk Usage') && hasStorageIssue
                          ? 'text-red-600'
                          : ''
                    }`}
                  >
                    {metric.value}
                  </span>
                </div>
              ))}
              {data.usedPercentage && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Disk Usage</span>
                  <span
                    className={`font-medium ${
                      data.usedPercentage > DISK_WARNING_THRESHOLD
                        ? 'text-red-600'
                        : 'text-green-600'
                    }`}
                  >
                    {data.usedPercentage}%
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      );
    },
    []
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">System Status</h1>
        <p className="text-muted-foreground mt-2">
          Health monitoring and performance insights for your media services
        </p>
      </div>

      {isLoading && (
        <LoadingState
          variant="spinner"
          message="Loading system status..."
          size="md"
        />
      )}

      {hasError && (
        <Card className="border-red-200 dark:border-red-800">
          <CardContent>
            <div className="flex items-center space-x-4 p-6">
              <AlertTriangle className="h-8 w-8 text-red-600" />
              <div className="flex-1">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Error Loading Data
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  Unable to load system statistics. Please verify your service
                  configurations.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {!isLoading && !hasError && (
        <>
          {systemAlerts.length > 0 && (
            <Card className="border-l-4 border-red-500 bg-red-50/50 dark:bg-red-900/10">
              <CardContent className="pt-6">
                <div className="flex items-center gap-3 mb-4">
                  <AlertTriangle className="h-6 w-6 text-red-600" />
                  <h3 className="text-lg font-semibold text-red-800 dark:text-red-200">
                    System Alerts ({systemAlerts.length})
                  </h3>
                </div>
                <div className="space-y-4">
                  {systemAlerts.map((alert, index) => (
                    <div
                      key={`${alert.service}-${index}`}
                      className="bg-white dark:bg-gray-800 rounded-lg border p-4"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <span
                            className={`px-2 py-1 text-xs font-medium rounded ${
                              alert.type === 'error'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-yellow-100 text-yellow-800'
                            }`}
                          >
                            {alert.service}
                          </span>
                          <span className="font-medium">{alert.message}</span>
                        </div>
                        <a
                          href={alert.healthUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-blue-600 hover:text-blue-800 underline flex items-center gap-1"
                          onClick={e => {
                            if (alert.healthUrl === '#') {
                              e.preventDefault();
                            }
                          }}
                        >
                          {alert.action}
                          <svg
                            className="h-3 w-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                            />
                          </svg>
                        </a>
                      </div>
                      {alert.healthIssues && alert.healthIssues.length > 0 && (
                        <div className="space-y-2">
                          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Issues:
                          </h4>
                          {alert.healthIssues.map((issue, issueIndex) => (
                            <div
                              key={issueIndex}
                              className="flex items-start gap-2 p-2 bg-gray-50 dark:bg-gray-700 rounded text-sm"
                            >
                              <span
                                className={`inline-block w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                                  issue.type === 'error'
                                    ? 'bg-red-500'
                                    : issue.type === 'warning'
                                      ? 'bg-yellow-500'
                                      : 'bg-blue-500'
                                }`}
                              ></span>
                              <div className="flex-1">
                                <div className="font-medium text-gray-900 dark:text-gray-100">
                                  {issue.source}
                                </div>
                                <div className="text-gray-600 dark:text-gray-400 mt-1">
                                  {issue.message}
                                </div>
                                {issue.wikiUrl && (
                                  <a
                                    href={issue.wikiUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:text-blue-800 text-xs underline mt-1 inline-block"
                                  >
                                    Learn more →
                                  </a>
                                )}
                              </div>
                            </div>
                          ))}
                          {alert.healthIssues.length <
                            (alert.service === 'Sonarr'
                              ? sonarrData?.healthIssues
                              : alert.service === 'Radarr'
                                ? radarrData?.healthIssues
                                : prowlarrData?.healthIssues) && (
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                              +{' '}
                              {(alert.service === 'Sonarr'
                                ? sonarrData?.healthIssues
                                : alert.service === 'Radarr'
                                  ? radarrData?.healthIssues
                                  : prowlarrData?.healthIssues) -
                                alert.healthIssues.length}{' '}
                              more issue
                              {(alert.service === 'Sonarr'
                                ? sonarrData?.healthIssues
                                : alert.service === 'Radarr'
                                  ? radarrData?.healthIssues
                                  : prowlarrData?.healthIssues) -
                                alert.healthIssues.length >
                              1
                                ? 's'
                                : ''}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div>
            <h2 className="text-xl font-semibold mb-6">Service Health</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {renderServiceHealthCard(sonarrData, 'sonarr')}
              {renderServiceHealthCard(radarrData, 'radarr')}
              {renderServiceHealthCard(prowlarrData, 'prowlarr')}
            </div>
          </div>

          {activeIndexersData.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold mb-6">Search Performance</h2>
              <Card>
                <CardHeader
                  title="Most Active Indexers"
                  subtitle={`Top ${activeIndexersData.length} indexers with significant activity (${MIN_INDEXER_ACTIVITY}+ queries)`}
                />
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart
                      data={activeIndexersData}
                      margin={{ top: 5, right: 30, left: 20, bottom: 60 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis
                        dataKey="name"
                        angle={-45}
                        textAnchor="end"
                        height={80}
                        fontSize={11}
                        interval={0}
                      />
                      <YAxis fontSize={11} />
                      <Tooltip
                        formatter={(value, name) => [value, name]}
                        labelFormatter={label => `Indexer: ${label}`}
                      />
                      <Bar
                        dataKey="queries"
                        fill="#3b82f6"
                        name="Total Queries"
                        radius={[2, 2, 0, 0]}
                      />
                      <Bar
                        dataKey="grabs"
                        fill="#10b981"
                        name="Successful Grabs"
                        radius={[2, 2, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          )}

          {prowlarrData?.timeBasedStats?.lastDay?.queries > 0 && (
            <div>
              <h2 className="text-xl font-semibold mb-6">Recent Activity</h2>
              <Card>
                <CardHeader
                  title="Last 24 Hours Performance"
                  subtitle={
                    prowlarrData.totalHistoryRecords >= 45000
                      ? `⚠️ Data limited by API (${prowlarrData.totalHistoryRecords?.toLocaleString()} records)`
                      : `${prowlarrData.totalHistoryRecords?.toLocaleString()} records analyzed`
                  }
                />
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {[
                      {
                        label: 'Total Queries',
                        value: prowlarrData.timeBasedStats.lastDay.queries,
                        color: 'blue',
                      },
                      {
                        label: 'Successful',
                        value: prowlarrData.timeBasedStats.lastDay.successful,
                        color: 'green',
                      },
                      {
                        label: 'Success Rate',
                        value: `${prowlarrData.timeBasedStats.lastDay.successRate}%`,
                        color: 'purple',
                      },
                    ].map(metric => (
                      <div
                        key={metric.label}
                        className={`text-center p-4 bg-${metric.color}-50 dark:bg-${metric.color}-900/20 rounded-lg`}
                      >
                        <h4
                          className={`font-semibold text-${metric.color}-800 dark:text-${metric.color}-200`}
                        >
                          {metric.label}
                        </h4>
                        <p
                          className={`text-3xl font-bold text-${metric.color}-600 mt-2`}
                        >
                          {typeof metric.value === 'number'
                            ? metric.value.toLocaleString()
                            : metric.value}
                        </p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {(sonarrData?.usedPercentage > DISK_WARNING_THRESHOLD ||
            radarrData?.usedPercentage > DISK_WARNING_THRESHOLD) && (
            <div>
              <h2 className="text-xl font-semibold mb-6">Storage Warnings</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {[sonarrData, radarrData].map((serviceData, index) => {
                  if (
                    !serviceData?.usedPercentage ||
                    serviceData.usedPercentage <= DISK_WARNING_THRESHOLD
                  )
                    return null;

                  const serviceName = index === 0 ? 'Sonarr' : 'Radarr';
                  const isCritical =
                    serviceData.usedPercentage > DISK_CRITICAL_THRESHOLD;
                  const cardClass = isCritical
                    ? 'border-red-200 bg-red-50/50'
                    : 'border-amber-200 bg-amber-50/50';
                  const barColor = isCritical ? 'bg-red-500' : 'bg-amber-500';

                  return (
                    <Card key={serviceName} className={cardClass}>
                      <CardHeader
                        title={`${serviceName} Storage ${isCritical ? 'Critical' : 'Warning'}`}
                      />
                      <CardContent>
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">
                              Used Space
                            </span>
                            <span className="font-bold text-lg">
                              {serviceData.usedPercentage}%
                            </span>
                          </div>
                          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4">
                            <div
                              className={`h-4 rounded-full transition-all duration-300 ${barColor}`}
                              style={{
                                width: `${Math.min(100, Math.max(0, serviceData.usedPercentage))}%`,
                              }}
                            />
                          </div>
                          <div className="flex justify-between text-sm">
                            <span>
                              Free:{' '}
                              {formatStorageSize(
                                serviceData.freeDiskSpace || 0
                              )}
                            </span>
                            <span>
                              Total:{' '}
                              {formatStorageSize(
                                serviceData.totalDiskSpace || 0
                              )}
                            </span>
                          </div>
                          {isCritical && (
                            <div className="text-red-600 font-medium text-sm">
                              ⚠️ Critical: Immediate cleanup required
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
