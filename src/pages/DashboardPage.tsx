import React from 'react';
import {
  Card,
  CardHeader,
  CardContent,
  StatusIndicator,
} from '@/components/ui';
import { useAppStore } from '@/store';
import {
  useSonarrStatus,
  useRadarrStatus,
  useProwlarrStatus,
  useSonarrQueue,
  useRadarrQueue,
} from '@/hooks';
import { QueueManager } from '@/components/queue/QueueManager';

export const DashboardPage: React.FC = () => {
  const { sonarrQueue, radarrQueue } = useAppStore();

  // Use hooks to fetch data
  const { data: sonarrStatusData, isLoading: sonarrLoading } =
    useSonarrStatus();
  const { data: radarrStatusData, isLoading: radarrLoading } =
    useRadarrStatus();
  const { data: prowlarrStatusData, isLoading: prowlarrLoading } =
    useProwlarrStatus();
  const { isLoading: sonarrQueueLoading } = useSonarrQueue();
  const { isLoading: radarrQueueLoading } = useRadarrQueue();

  const getServiceStatus = (status: any, loading: boolean) => {
    if (loading) return 'loading';
    return status ? 'online' : 'offline';
  };

  return (
    <div className="space-y-6">
      {/* Service Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Sonarr Status */}
        <Card>
          <CardHeader
            title="Sonarr"
            subtitle={
              sonarrStatusData?.version
                ? `Version ${sonarrStatusData.version}`
                : 'Not connected'
            }
            actions={
              <div className="flex items-center gap-2">
                <StatusIndicator
                  status={getServiceStatus(sonarrStatusData, sonarrLoading)}
                />
                <span className="text-xs text-muted-foreground">
                  {sonarrQueue.length} items
                </span>
              </div>
            }
          />
          {sonarrStatusData && (
            <CardContent>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">App:</span>
                  <span className="font-mono">{sonarrStatusData.appName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Branch:</span>
                  <span className="font-mono">{sonarrStatusData.branch}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Docker:</span>
                  <span className="font-mono">
                    {String(sonarrStatusData.isDocker)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">DB:</span>
                  <span className="font-mono">
                    {sonarrStatusData.databaseVersion}
                  </span>
                </div>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Radarr Status */}
        <Card>
          <CardHeader
            title="Radarr"
            subtitle={
              radarrStatusData?.version
                ? `Version ${radarrStatusData.version}`
                : 'Not connected'
            }
            actions={
              <div className="flex items-center gap-2">
                <StatusIndicator
                  status={getServiceStatus(radarrStatusData, radarrLoading)}
                />
                <span className="text-xs text-muted-foreground">
                  {radarrQueue.length} items
                </span>
              </div>
            }
          />
          {radarrStatusData && (
            <CardContent>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">App:</span>
                  <span className="font-mono">{radarrStatusData.appName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Branch:</span>
                  <span className="font-mono">{radarrStatusData.branch}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Docker:</span>
                  <span className="font-mono">
                    {String(radarrStatusData.isDocker)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">DB:</span>
                  <span className="font-mono">
                    {radarrStatusData.databaseVersion}
                  </span>
                </div>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Prowlarr Status */}
        <Card>
          <CardHeader
            title="Prowlarr"
            subtitle={
              prowlarrStatusData?.version
                ? `Version ${prowlarrStatusData.version}`
                : 'Not connected'
            }
            actions={
              <StatusIndicator
                status={getServiceStatus(prowlarrStatusData, prowlarrLoading)}
              />
            }
          />
          {prowlarrStatusData && (
            <CardContent>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">App:</span>
                  <span className="font-mono">
                    {prowlarrStatusData.appName}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Branch:</span>
                  <span className="font-mono">{prowlarrStatusData.branch}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Docker:</span>
                  <span className="font-mono">
                    {String(prowlarrStatusData.isDocker)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">DB:</span>
                  <span className="font-mono">
                    {prowlarrStatusData.databaseVersion}
                  </span>
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* Queue Management */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Sonarr Queue */}
        <Card>
          <CardHeader title="Sonarr Queue" subtitle="TV Shows download queue" />
          <CardContent>
            <QueueManager service="sonarr" loading={sonarrQueueLoading} />
          </CardContent>
        </Card>

        {/* Radarr Queue */}
        <Card>
          <CardHeader title="Radarr Queue" subtitle="Movies download queue" />
          <CardContent>
            <QueueManager service="radarr" loading={radarrQueueLoading} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
