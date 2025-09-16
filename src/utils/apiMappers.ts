import { ServiceType } from './colors';

/**
 * Standard mapped response interface for consistent data structure
 */
export interface MappedApiResponse {
  id: number;
  title: string;
  status: 'imported' | 'grabbed' | 'failed' | 'deleted' | 'unknown';
  date: string;
  size?: number;
  quality?: string;
  downloadClient?: string;
  indexer?: string;
  protocol?: string;
  reason?: string;
  service: ServiceType;
  originalData?: any; // Keep original for specific use cases
}

/**
 * Standard queue item interface
 */
export interface MappedQueueItem {
  id: number;
  title: string;
  status: string;
  progress?: number;
  size?: number;
  estimatedCompletionTime?: string;
  downloadClient?: string;
  indexer?: string;
  protocol?: string;
  service: ServiceType;
  originalData?: any;
}

/**
 * Map raw API response to standard format
 */
export const mapApiResponse = (
  response: any,
  service: ServiceType
): MappedApiResponse => {
  // Common field extraction
  const getId = () => response.id || response.queueItemId || 0;
  const getTitle = () =>
    response.title ||
    response.name ||
    response.sourceTitle ||
    response.data?.path ||
    response.series?.title ||
    response.movie?.title ||
    'Unknown';

  const getDate = () =>
    response.date || response.airDate || new Date().toISOString();

  const getSize = () => {
    if (response.size) return parseInt(response.size.toString()) || 0;
    if (response.data?.size)
      return parseInt(response.data.size.toString()) || 0;
    return 0;
  };

  const getQuality = () => {
    if (typeof response.quality === 'string') return response.quality;
    if (response.quality?.name) return response.quality.name;
    if (response.quality?.quality?.name) return response.quality.quality.name;
    return 'Unknown';
  };

  const getStatus = (): MappedApiResponse['status'] => {
    // Handle different status formats from different services
    if (response.status) {
      const status = response.status.toLowerCase();
      if (status.includes('imported') || status.includes('completed'))
        return 'imported';
      if (status.includes('grabbed') || status.includes('downloading'))
        return 'grabbed';
      if (status.includes('failed') || status.includes('error'))
        return 'failed';
      if (status.includes('deleted')) return 'deleted';
    }

    // Handle event types (for history)
    if (response.eventType) {
      const eventType = response.eventType;
      if (
        eventType === 'downloadFolderImported' ||
        eventType === 'movieFileImported'
      )
        return 'imported';
      if (eventType === 'downloadFailed' || eventType === 'movieFileDeleted')
        return 'failed';
      if (eventType === 'grabbed') return 'grabbed';
      if (eventType.includes('deleted') || eventType.includes('Delete'))
        return 'deleted';
    }

    // Handle boolean success (for Prowlarr)
    if (typeof response.successful === 'boolean') {
      return response.successful ? 'imported' : 'failed';
    }

    return 'unknown';
  };

  const getDownloadClient = () =>
    response.downloadClient ||
    response.data?.downloadClient ||
    response.data?.downloadClientName ||
    'N/A';

  const getIndexer = () =>
    response.indexer ||
    response.data?.indexer ||
    (response.indexerId ? `Indexer ID: ${response.indexerId}` : 'N/A');

  const getProtocol = () =>
    response.protocol ||
    response.data?.protocol ||
    response.downloadProtocol ||
    'N/A';

  const getReason = () =>
    response.reason ||
    response.data?.releaseGroup ||
    (response.data?.queryResults
      ? `${response.data.queryResults} results`
      : '');

  return {
    id: getId(),
    title: getTitle(),
    status: getStatus(),
    date: getDate(),
    size: getSize(),
    quality: getQuality(),
    downloadClient: getDownloadClient(),
    indexer: getIndexer(),
    protocol: getProtocol(),
    reason: getReason(),
    service,
    originalData: response,
  };
};

/**
 * Map queue item to standard format
 */
export const mapQueueItem = (
  item: any,
  service: ServiceType
): MappedQueueItem => {
  const getProgress = () => {
    if (item.size && item.sizeleft) {
      const downloaded = item.size - item.sizeleft;
      return Math.round((downloaded / item.size) * 100);
    }
    return undefined;
  };

  const getEstimatedTime = () => {
    if (item.timeleft) return item.timeleft;
    if (item.estimatedCompletionTime) return item.estimatedCompletionTime;
    return undefined;
  };

  return {
    id: item.id || item.queueItemId || 0,
    title: item.title || item.series?.title || item.movie?.title || 'Unknown',
    status: item.status || 'Unknown',
    progress: getProgress(),
    size: item.size || 0,
    estimatedCompletionTime: getEstimatedTime(),
    downloadClient: item.downloadClient || 'N/A',
    indexer: item.indexer || 'N/A',
    protocol: item.protocol || item.downloadProtocol || 'N/A',
    service,
    originalData: item,
  };
};

/**
 * Deduplicate mapped responses based on key criteria
 */
export const deduplicateResponses = (
  responses: MappedApiResponse[]
): MappedApiResponse[] => {
  const seen = new Map<string, MappedApiResponse>();

  return responses.filter(response => {
    // Create a unique key based on title, status, size, and date (to nearest minute)
    const date = new Date(response.date);
    const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
    const key = `${response.title}-${response.status}-${response.size}-${dateKey}`;

    if (seen.has(key)) {
      // Keep the record with more complete data
      const existing = seen.get(key)!;
      if (
        response.downloadClient !== 'N/A' &&
        existing.downloadClient === 'N/A'
      ) {
        seen.set(key, response);
        return true;
      }
      return false;
    }

    seen.set(key, response);
    return true;
  });
};

/**
 * Sort mapped responses by specified criteria
 */
export const sortMappedResponses = (
  responses: MappedApiResponse[],
  sortBy: keyof MappedApiResponse,
  direction: 'asc' | 'desc' = 'desc'
): MappedApiResponse[] => {
  return [...responses].sort((a, b) => {
    let aVal: any = a[sortBy];
    let bVal: any = b[sortBy];

    if (sortBy === 'date') {
      aVal = new Date(aVal).getTime();
      bVal = new Date(bVal).getTime();
    } else if (sortBy === 'size') {
      aVal = aVal || 0;
      bVal = bVal || 0;
    } else {
      aVal = String(aVal || '').toLowerCase();
      bVal = String(bVal || '').toLowerCase();
    }

    if (direction === 'asc') {
      return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
    } else {
      return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
    }
  });
};
