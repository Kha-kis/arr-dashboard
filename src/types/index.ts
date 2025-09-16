export interface ServiceConfig {
  baseUrl: string;
  apiKey: string;
}

export interface AppConfig {
  sonarr: ServiceConfig;
  radarr: ServiceConfig;
  prowlarr: ServiceConfig;
}

export interface SystemStatus {
  appName?: string;
  version?: string;
  branch?: string;
  isDocker?: boolean;
  databaseVersion?: string;
  startTime?: string;
  urlBase?: string;
}

export interface QualityProfile {
  name?: string;
  quality?: {
    name?: string;
  };
  revision?: {
    version?: number;
    real?: number;
  };
}

export interface StatusMessage {
  title?: string;
  messages?: string[];
}

export interface QueueItem {
  id?: number;
  queueItemId?: number;
  downloadId?: string;
  title?: string;
  series?: {
    title?: string;
  };
  movie?: {
    title?: string;
  };
  quality?: QualityProfile;
  qualityCutoff?: QualityProfile;
  protocol?: string;
  downloadProtocol?: string;
  status?: string;
  size?: number;
  sizeleft?: number;
  statusMessages?: StatusMessage[];
  errorMessage?: string;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  // Indexer information
  indexer?: string;
  indexerId?: number;
  downloadClient?: string;
  downloadClientType?: string;
}

export interface Indexer {
  id: number;
  name: string;
  implementation: string;
  definitionName: string;
  enable: boolean;
  protocol: 'torrent' | 'usenet';
  priority: number;
  supportsRss: boolean;
  supportsSearch: boolean;
  supportsRedirect: boolean;
  appProfileId?: number;
  configContract: string;
  infoLink?: string;
  tags?: number[];
  fields?: Array<{
    order: number;
    name: string;
    label: string;
    value?: any;
    type: string;
    advanced: boolean;
    privacy: string;
  }>;
}

export interface SearchResult {
  id?: string;
  guid?: string;
  title: string;
  name?: string;
  size: number;
  link?: string;
  magnetUrl?: string;
  infoUrl?: string;
  downloadUrl?: string;
  indexer: string;
  indexerId: number;
  indexerFlags?: number[];
  categories?: number[];
  seeders?: number;
  leechers?: number;
  peers?: number;
  protocol: 'torrent' | 'usenet';
  publishDate?: string;
  age?: number;
  ageHours?: number;
  ageDays?: number;
  commentUrl?: string;
  downloadVolumeFactor?: number;
  uploadVolumeFactor?: number;
  minimumRatio?: number;
  minimumSeedTime?: number;
  downloadClientId?: number;
  downloadClient?: string;
  indexerPriority?: number;
  imdbId?: number;
  tmdbId?: number;
  tvdbId?: number;
  tvMazeId?: number;
  rejected?: boolean;
  rejections?: string[];
  languages?: Array<{
    id: number;
    name: string;
  }>;
  quality?: {
    quality: {
      id: number;
      name: string;
      source: string;
      resolution: number;
    };
    revision: {
      version: number;
      real: number;
      isRepack: boolean;
    };
  };
}

export interface DownloadHistoryItem {
  id: number;
  downloadId: string;
  title: string;
  size: number;
  quality: QualityProfile;
  status:
    | 'completed'
    | 'failed'
    | 'deleted'
    | 'imported'
    | 'grabbed'
    | 'unknown';
  downloadClient: string;
  indexer: string;
  protocol: string;
  date: string;
  reason?: string;
  // Additional properties from API responses
  eventType?: string;
  sourceTitle?: string;
  seriesId?: number;
  episodeId?: number;
  movieId?: number;
  data?: {
    size?: string;
    path?: string;
    downloadClientName?: string;
    downloadClient?: string;
    indexer?: string;
    protocol?: string;
    releaseGroup?: string;
    query?: string;
    source?: string;
    queryType?: string;
    queryResults?: number;
  };
}

export interface Statistics {
  totalDownloads: number;
  successfulDownloads: number;
  failedDownloads: number;
  averageDownloadTime: number;
  totalDataDownloaded: number;
  downloadsToday: number;
  downloadsThisWeek: number;
  downloadsThisMonth: number;
  topIndexers: Array<{
    name: string;
    count: number;
    successRate: number;
  }>;
  qualityDistribution: Array<{
    quality: string;
    count: number;
  }>;
}

export interface CalendarItem {
  id: number;
  title: string;
  type: 'movie' | 'episode';
  airDate: string;
  airDateUtc: string;
  status: 'announced' | 'inCinemas' | 'released' | 'aired' | 'upcoming';
  monitored: boolean;
  hasFile: boolean;
  overview?: string;
  poster?: string;
  season?: number;
  episode?: number;
  episodeNumber?: number;
  seasonNumber?: number;
  episodeTitle?: string;
  absoluteEpisodeNumber?: number;
  runtime?: number;
  year?: number;
  releaseDate?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  inCinemas?: string;
  genres?: string[];
  ratings?: {
    imdb?: { value: number; votes: number };
    tmdb?: { value: number; votes: number };
    rottenTomatoes?: { value: number; votes: number };
  };
  network?: string;
  seriesType?: string;
  certification?: string;
  studio?: string;
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
  unverifiedSceneNumbering?: boolean;
  grabbed?: boolean;
  qualityCutoffNotMet?: boolean;
  // Series/Movie info
  series?: {
    id: number;
    title: string;
    year: number;
    path: string;
    profileId: number;
    seasonFolder: boolean;
    monitored: boolean;
    seriesType: string;
    cleanTitle: string;
    imdbId: string;
    tmdbId: number;
    tvdbId: number;
    tvRageId: number;
    status: string;
    overview: string;
    network: string;
    airTime: string;
    seasons: any[];
    genres: string[];
    certification: string;
    runtime: number;
    images: any[];
  };
  movie?: {
    id: number;
    title: string;
    sortTitle: string;
    sizeOnDisk: number;
    status: string;
    overview: string;
    inCinemas: string;
    physicalRelease: string;
    digitalRelease: string;
    images: any[];
    website: string;
    year: number;
    hasFile: boolean;
    youTubeTrailerId: string;
    studio: string;
    path: string;
    profileId: number;
    monitored: boolean;
    runtime: number;
    lastInfoSync: string;
    cleanTitle: string;
    imdbId: string;
    tmdbId: number;
    titleSlug: string;
    certification: string;
    genres: string[];
    tags: number[];
    added: string;
    ratings: any;
    qualityProfileId: number;
  };
}

export interface NotificationRule {
  id: string;
  name: string;
  events: string[];
  conditions: Array<{
    field: string;
    operator: string;
    value: string;
  }>;
  actions: Array<{
    type: 'webhook' | 'email' | 'toast';
    config: Record<string, any>;
  }>;
  enabled: boolean;
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: Record<string, any>;
  service: 'sonarr' | 'radarr' | 'prowlarr';
}

export interface KeyboardShortcut {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  action: string;
  description: string;
}
