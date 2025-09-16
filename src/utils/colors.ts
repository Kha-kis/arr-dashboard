import { cn } from './index';

export type ServiceType = 'sonarr' | 'radarr' | 'prowlarr';
export type StatusType =
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'imported'
  | 'grabbed'
  | 'failed'
  | 'deleted';

/**
 * Get service-specific color classes
 */
export const getServiceColors = (
  service: ServiceType,
  variant: 'solid' | 'muted' | 'outline' = 'solid'
) => {
  const baseClasses = {
    sonarr: {
      solid: 'bg-sonarr text-sonarr-foreground',
      muted: 'bg-sonarr-muted text-sonarr border-sonarr/20',
      outline: 'border-sonarr text-sonarr hover:bg-sonarr-muted',
    },
    radarr: {
      solid: 'bg-radarr text-radarr-foreground',
      muted: 'bg-radarr-muted text-radarr border-radarr/20',
      outline: 'border-radarr text-radarr hover:bg-radarr-muted',
    },
    prowlarr: {
      solid: 'bg-prowlarr text-prowlarr-foreground',
      muted: 'bg-prowlarr-muted text-prowlarr border-prowlarr/20',
      outline: 'border-prowlarr text-prowlarr hover:bg-prowlarr-muted',
    },
  };

  return baseClasses[service][variant];
};

/**
 * Get status-specific color classes
 */
export const getStatusColors = (
  status: StatusType,
  variant: 'solid' | 'muted' | 'outline' = 'muted'
) => {
  // Map download statuses to semantic colors
  const statusMap: Record<
    StatusType,
    'success' | 'warning' | 'error' | 'info'
  > = {
    success: 'success',
    warning: 'warning',
    error: 'error',
    info: 'info',
    imported: 'success',
    grabbed: 'info',
    failed: 'error',
    deleted: 'warning',
  };

  const semanticStatus = statusMap[status] || 'info';

  const baseClasses = {
    success: {
      solid: 'bg-success text-success-foreground',
      muted: 'bg-success-muted text-success border-success/20',
      outline: 'border-success text-success hover:bg-success-muted',
    },
    warning: {
      solid: 'bg-warning text-warning-foreground',
      muted: 'bg-warning-muted text-warning border-warning/20',
      outline: 'border-warning text-warning hover:bg-warning-muted',
    },
    error: {
      solid: 'bg-error text-error-foreground',
      muted: 'bg-error-muted text-error border-error/20',
      outline: 'border-error text-error hover:bg-error-muted',
    },
    info: {
      solid: 'bg-info text-info-foreground',
      muted: 'bg-info-muted text-info border-info/20',
      outline: 'border-info text-info hover:bg-info-muted',
    },
  };

  return baseClasses[semanticStatus][variant];
};

/**
 * Get badge classes for services
 */
export const getServiceBadge = (service: ServiceType, className?: string) => {
  return cn(
    'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors',
    getServiceColors(service, 'muted'),
    className
  );
};

/**
 * Get badge classes for statuses
 */
export const getStatusBadge = (status: StatusType, className?: string) => {
  return cn(
    'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors',
    getStatusColors(status, 'muted'),
    className
  );
};

/**
 * Get text color for service
 */
export const getServiceTextColor = (service: ServiceType) => {
  const colors = {
    sonarr: 'text-sonarr',
    radarr: 'text-radarr',
    prowlarr: 'text-prowlarr',
  };
  return colors[service];
};

/**
 * Get text color for status
 */
export const getStatusTextColor = (status: StatusType) => {
  const statusMap: Record<StatusType, string> = {
    success: 'text-success',
    warning: 'text-warning',
    error: 'text-error',
    info: 'text-info',
    imported: 'text-success',
    grabbed: 'text-info',
    failed: 'text-error',
    deleted: 'text-warning',
  };

  return statusMap[status] || 'text-info';
};
