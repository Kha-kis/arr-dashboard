import { useAppStore } from '@/store';

export interface ImageData {
  coverType: string;
  url: string;
  remoteUrl?: string;
}

export const getImageUrl = (
  images: ImageData[] | undefined,
  coverType: 'poster' | 'banner' | 'fanart' = 'poster',
  baseUrl?: string,
  itemId?: number
): string | undefined => {
  if (!images || images.length === 0) return undefined;

  const image = images.find(img => img.coverType === coverType);
  if (!image) return undefined;

  // If it's already a full URL (starts with http), return as-is
  if (image.url?.startsWith('http') || image.remoteUrl?.startsWith('http')) {
    return image.url || image.remoteUrl;
  }

  // If we have an image URL from Radarr/Sonarr, it needs to go through our backend proxy
  if (baseUrl && image.url) {
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const imageUrl = `${cleanBaseUrl}${image.url}`;
    // Route through our backend proxy to avoid CORS issues
    return `http://localhost:3001/api/proxy?url=${encodeURIComponent(imageUrl)}`;
  }

  // For mediacover API approach (fallback)
  if (baseUrl && itemId) {
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const imageUrl = `${cleanBaseUrl}/api/v3/mediacover/${itemId}/${coverType}.jpg`;
    return `http://localhost:3001/api/proxy?url=${encodeURIComponent(imageUrl)}`;
  }

  // Fallback: return the relative URL (might not work but better than nothing)
  return image.url;
};

export const useImageUrl = (
  images: ImageData[] | undefined,
  coverType: 'poster' | 'banner' | 'fanart' = 'poster',
  service: 'sonarr' | 'radarr'
): string | undefined => {
  const { config } = useAppStore();

  const baseUrl =
    service === 'sonarr' ? config?.sonarr?.baseUrl : config?.radarr?.baseUrl;

  return getImageUrl(images, coverType, baseUrl);
};

// Fallback placeholder URLs for when images are missing
export const getPlaceholderImage = (type: 'movie' | 'series'): string => {
  // Create a simple SVG placeholder without Unicode characters
  const svg = `<svg width="300" height="450" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="450" fill="#374151"/>
    <circle cx="150" cy="200" r="30" fill="#6B7280"/>
    <rect x="130" y="180" width="40" height="40" fill="#374151" rx="5"/>
    <text x="150" y="260" font-family="Arial" font-size="14" fill="#9CA3AF" text-anchor="middle">
      ${type === 'movie' ? 'Movie' : 'TV Show'}
    </text>
    <text x="150" y="280" font-family="Arial" font-size="12" fill="#6B7280" text-anchor="middle">
      No Image
    </text>
  </svg>`;

  return `data:image/svg+xml;base64,${btoa(svg)}`;
};
