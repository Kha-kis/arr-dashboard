import { type ClassValue, clsx } from 'clsx';
import { QualityProfile, QueueItem } from '@/types';

// Tailwind CSS class utilities
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

// Quality formatting
export function formatQuality(
  quality: QualityProfile | null | undefined
): string {
  if (!quality) return '—';
  if (typeof quality === 'string') return quality;

  const name = quality.quality?.name ?? quality.name ?? '—';
  const version = Number(quality.revision?.version) || 0;
  const real = Number(quality.revision?.real) || 0;

  return (
    name + (version > 1 ? ` r${version}` : '') + (real > 0 ? ` p${real}` : '')
  );
}

// Extract reasons from queue item
export function reasonsFrom(item: QueueItem): string[] {
  const reasons: string[] = [];

  if (Array.isArray(item.statusMessages)) {
    for (const sm of item.statusMessages) {
      if (Array.isArray(sm.messages)) {
        reasons.push(...sm.messages);
      } else if (sm.title) {
        reasons.push(sm.title);
      }
    }
  }

  if (item.errorMessage) reasons.push(item.errorMessage);
  if (item.trackedDownloadState) reasons.push(item.trackedDownloadState);
  if (
    item.trackedDownloadStatus &&
    item.trackedDownloadStatus !== item.trackedDownloadState
  ) {
    reasons.push(item.trackedDownloadStatus);
  }

  return [...new Set(reasons.filter(Boolean))];
}

// Get item ID
export function getItemId(item: QueueItem | any): string | number | null {
  return item?.id ?? item?.queueItemId ?? item?._id ?? item?.downloadId ?? null;
}

// Check if protocol is torrent
export function isTorrent(item: QueueItem | any): boolean {
  return String(item?.protocol ?? item?.downloadProtocol ?? '')
    .toLowerCase()
    .includes('torrent');
}

// Format file sizes
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Format duration
export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// Format date for display
export function formatDate(date: Date | string): string {
  const target = typeof date === 'string' ? new Date(date) : date;

  if (isNaN(target.getTime())) {
    return 'Invalid date';
  }

  return target.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Format relative time
export function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const target = typeof date === 'string' ? new Date(date) : date;
  const diffMs = now.getTime() - target.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return target.toLocaleDateString();
}

// Progress calculation
export function calculateProgress(item: QueueItem): {
  percentage: number;
  display: string;
} {
  if (
    typeof item.sizeleft === 'number' &&
    typeof item.size === 'number' &&
    item.size > 0
  ) {
    const percentage = Math.max(
      0,
      Math.min(100, Math.round(((item.size - item.sizeleft) / item.size) * 100))
    );
    return {
      percentage,
      display: `${percentage}%`,
    };
  }
  return {
    percentage: 0,
    display: item.status || '—',
  };
}

// Clipboard utilities
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers that don't support clipboard API
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textArea);
      return success;
    } catch {
      return false;
    }
  }
}

// Extract URLs from search results
export function getMagnetUrl(result: any): string {
  const magnetFields = ['magnetUrl', 'MagnetUri', 'magnetURI', 'magnet'];

  for (const field of magnetFields) {
    const url = result[field];
    if (typeof url === 'string' && url.startsWith('magnet:')) {
      return url;
    }
  }

  const downloadUrl = result.downloadUrl || result.link || '';
  return typeof downloadUrl === 'string' && downloadUrl.startsWith('magnet:')
    ? downloadUrl
    : '';
}

export function getDownloadUrl(result: any): string {
  return (
    result.downloadUrl || result.link || result.guid || result.infoUrl || ''
  );
}

export function getInfoUrl(result: any): string {
  const infoUrl = result.infoUrl;
  if (typeof infoUrl === 'string' && /^https?:\/\//i.test(infoUrl)) {
    return infoUrl;
  }

  const guid = result.guid;
  if (typeof guid === 'string' && /^https?:\/\//i.test(guid)) {
    return guid;
  }

  return '';
}

// Debounce function
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

// Local storage helpers with error handling
export function getFromStorage<T>(key: string, defaultValue: T): T {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setToStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error('Failed to save to localStorage:', error);
  }
}


// Export new utility modules
export * from './colors';
export * from './apiMappers';
export * from './errorHandlers';
