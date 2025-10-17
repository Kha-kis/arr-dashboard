/**
 * Recyclarr-style Quality Profile Implementation
 * Based on actual recyclarr config templates and approach
 */

export interface RecyclarrQualityProfile {
  name: string;
  upgrade?: {
    allowed: boolean;
    until_quality?: string;
    until_score?: number;
  };
  min_format_score?: number;
  quality_sort?: 'top' | 'bottom';
  qualities: RecyclarrQualityDefinition[];
}

export interface RecyclarrQualityDefinition {
  name: string;
  enabled?: boolean;
  qualities?: RecyclarrQualityDefinition[];
}

/**
 * Built-in quality profile templates matching TRaSH-Guides recommendations
 * These are based on the actual recyclarr config templates
 */
export const QUALITY_PROFILE_TEMPLATES: Record<string, RecyclarrQualityProfile> = {
  'HD-Bluray+WEB': {
    name: 'HD-Bluray+WEB',
    upgrade: {
      allowed: true,
      until_quality: 'Remux-1080p',
    },
    min_format_score: 0,
    quality_sort: 'top',
    qualities: [
      {
        name: 'Remux-1080p',
        enabled: true,
      },
      {
        name: 'Bluray-1080p',
        enabled: true,
      },
      {
        name: 'WEB 1080p',
        enabled: true,
        qualities: [
          { name: 'WEBDL-1080p', enabled: true },
          { name: 'WEBRip-1080p', enabled: true },
        ],
      },
      {
        name: 'Bluray-720p',
        enabled: true,
      },
      {
        name: 'WEB 720p',
        enabled: true,
        qualities: [
          { name: 'WEBDL-720p', enabled: true },
          { name: 'WEBRip-720p', enabled: true },
        ],
      },
    ],
  },
  
  'UHD-Bluray+WEB': {
    name: 'UHD-Bluray+WEB',
    upgrade: {
      allowed: true,
      until_quality: 'Remux-2160p',
    },
    min_format_score: 0,
    quality_sort: 'top',
    qualities: [
      {
        name: 'Remux-2160p',
        enabled: true,
      },
      {
        name: 'Bluray-2160p',
        enabled: true,
      },
      {
        name: 'WEB 2160p',
        enabled: true,
        qualities: [
          { name: 'WEBDL-2160p', enabled: true },
          { name: 'WEBRip-2160p', enabled: true },
        ],
      },
    ],
  },

  'WEB-1080p': {
    name: 'WEB-1080p',
    upgrade: {
      allowed: true,
      until_quality: 'WEBDL-1080p',
    },
    min_format_score: 0,
    quality_sort: 'top',
    qualities: [
      {
        name: 'WEB 1080p',
        enabled: true,
        qualities: [
          { name: 'WEBDL-1080p', enabled: true },
          { name: 'WEBRip-1080p', enabled: true },
        ],
      },
      {
        name: 'WEB 720p',
        enabled: true,
        qualities: [
          { name: 'WEBDL-720p', enabled: true },
          { name: 'WEBRip-720p', enabled: true },
        ],
      },
    ],
  },
};

/**
 * Get available quality profile templates
 */
export function getAvailableTemplates(): Array<{ name: string; description: string }> {
  return [
    {
      name: 'HD-Bluray+WEB',
      description: 'HD quality profile with Bluray and WEB sources (1080p/720p)',
    },
    {
      name: 'UHD-Bluray+WEB', 
      description: 'UHD quality profile with Bluray and WEB sources (2160p)',
    },
    {
      name: 'WEB-1080p',
      description: 'WEB-only quality profile (1080p/720p)',
    },
  ];
}

/**
 * Get a quality profile template by name
 */
export function getQualityProfileTemplate(templateName: string): RecyclarrQualityProfile | null {
  return QUALITY_PROFILE_TEMPLATES[templateName] || null;
}

/**
 * Convert a recyclarr-style profile to our internal format
 */
export function convertRecyclarrProfile(profile: RecyclarrQualityProfile) {
  return {
    name: profile.name,
    upgrade: {
      allowed: profile.upgrade?.allowed ?? true,
      until_quality: profile.upgrade?.until_quality,
      until_score: profile.upgrade?.until_score,
    },
    min_format_score: profile.min_format_score ?? 0,
    quality_sort: profile.quality_sort ?? 'top',
    qualities: profile.qualities || [],
  };
}