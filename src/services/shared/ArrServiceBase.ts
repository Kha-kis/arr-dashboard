import { BaseClient } from '../api';
import { QueueItem, SystemStatus } from '@/types';

/**
 * Shared base class for *arr service clients (Sonarr, Radarr)
 * Consolidates duplicate functionality between services
 */
export abstract class ArrServiceBase extends BaseClient {
  
  /**
   * Standard API endpoints - override in subclasses if needed
   */
  protected getApiVersion(): string {
    return 'v3';
  }

  protected getQueueEndpoint(): string {
    return `/api/${this.getApiVersion()}/queue?pageSize=1000&includeUnknownSeriesItems=true`;
  }

  protected getStatusEndpoint(): string {
    return `/api/${this.getApiVersion()}/system/status`;
  }

  /**
   * Consolidated getStatus method - identical across services
   */
  async getStatus(): Promise<SystemStatus> {
    return this.request<SystemStatus>(this.getStatusEndpoint());
  }

  /**
   * Consolidated getQueue method - identical across services
   */
  async getQueue(): Promise<QueueItem[]> {
    const response = await this.request<{ records?: QueueItem[] } | QueueItem[]>(
      this.getQueueEndpoint()
    );
    return Array.isArray(response) ? response : response.records || [];
  }

  /**
   * Consolidated queue management methods - identical across services
   */
  async retryQueueItem(id: string | number): Promise<void> {
    await this.request(`/api/${this.getApiVersion()}/queue/${id}/retry`, { method: 'POST' });
    this.clearCachePattern('queue');
  }

  async deleteQueueItem(
    id: string | number,
    removeFromClient = true,
    blocklist = false,
    changeCategory = false
  ): Promise<void> {
    const params = new URLSearchParams({
      removeFromClient: removeFromClient.toString(),
      blocklist: blocklist.toString(),
      changeCategory: changeCategory.toString(),
    });
    
    await this.request(
      `/api/${this.getApiVersion()}/queue/${id}?${params.toString()}`,
      { method: 'DELETE' }
    );
    this.clearCachePattern('queue');
  }

  async bulkQueueAction(
    ids: (string | number)[],
    action: 'delete' | 'retry',
    removeFromClient = true,
    blocklist = false,
    changeCategory = false
  ): Promise<void> {
    if (action === 'retry') {
      // Retry items individually as bulk retry might not be supported
      await Promise.all(ids.map(id => this.retryQueueItem(id)));
    } else {
      await this.request(`/api/${this.getApiVersion()}/queue/bulk`, {
        method: 'DELETE',
        body: JSON.stringify({
          ids,
          removeFromClient,
          blocklist,
          changeCategory,
        }),
      });
    }
    this.clearCachePattern('queue');
  }

  /**
   * Common utility methods used across services
   */
  protected async fetchCommonServiceData() {
    const [diskSpace, systemInfo, health, tags, commands] = await Promise.allSettled([
      this.getDiskSpace(),
      this.getSystemInfo(),
      this.getHealth(),
      this.getTags(),
      this.getCommands(),
    ]);

    return {
      diskSpace: diskSpace.status === 'fulfilled' ? diskSpace.value : [],
      systemInfo: systemInfo.status === 'fulfilled' ? systemInfo.value : {},
      health: health.status === 'fulfilled' ? health.value : [],
      tags: tags.status === 'fulfilled' ? tags.value : [],
      commands: commands.status === 'fulfilled' ? commands.value : [],
    };
  }

  /**
   * Consolidated disk space calculation
   */
  protected calculateDiskStats(diskSpace: any[]) {
    const totalSize = diskSpace.reduce(
      (acc: number, d: any) => acc + (d.totalSpace || 0),
      0
    );
    const freeSpace = diskSpace.reduce(
      (acc: number, d: any) => acc + (d.freeSpace || 0),
      0
    );

    return {
      totalDiskSpace: totalSize,
      freeDiskSpace: freeSpace,
      usedDiskSpace: totalSize - freeSpace,
      usedPercentage:
        totalSize > 0
          ? Math.round(((totalSize - freeSpace) / totalSize) * 100)
          : 0,
    };
  }

  /**
   * Consolidated quality distribution calculation
   */
  protected calculateQualityDistribution(items: any[]) {
    return items.reduce((acc: any, item: any) => {
      const qualityName = item.qualityProfile?.name || 'Unknown';
      acc[qualityName] = (acc[qualityName] || 0) + 1;
      return acc;
    }, {});
  }

  /**
   * Consolidated health issues calculation
   */
  protected calculateHealthIssues(health: any[]) {
    return (health || []).filter(
      (h: any) => h.type === 'error' || h.type === 'warning'
    ).length;
  }

  /**
   * Consolidated uptime calculation
   */
  protected calculateUptime(systemInfo: any) {
    return systemInfo?.startTime
      ? Math.round(
          (Date.now() - new Date(systemInfo.startTime).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : 0;
  }

  /**
   * Abstract methods - must be implemented by subclasses
   */
  abstract getDiskSpace(): Promise<any>;
  abstract getSystemInfo(): Promise<any>;
  abstract getHealth(): Promise<any>;
  abstract getTags(): Promise<any>;
  abstract getCommands(): Promise<any>;
}