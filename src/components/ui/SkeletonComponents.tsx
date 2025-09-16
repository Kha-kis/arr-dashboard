import React from 'react';
import { cn } from '@/utils';

interface SkeletonProps {
  className?: string;
  variant?: 'default' | 'circular' | 'rounded';
  animate?: boolean;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  className,
  variant = 'default',
  animate = true,
}) => {
  const baseClasses = 'bg-gray-200 dark:bg-gray-700';
  const animationClasses = animate ? 'animate-pulse' : '';

  const variantClasses = {
    default: 'rounded',
    circular: 'rounded-full',
    rounded: 'rounded-lg',
  };

  return (
    <div
      className={cn(
        baseClasses,
        animationClasses,
        variantClasses[variant],
        className
      )}
    />
  );
};

interface SkeletonCardProps {
  variant?: 'queue' | 'history' | 'search' | 'statistics' | 'calendar';
  className?: string;
  count?: number;
}

export const SkeletonCard: React.FC<SkeletonCardProps> = ({
  variant = 'queue',
  className,
  count = 1,
}) => {
  const skeletons: Record<string, JSX.Element> = {
    queue: (
      <div className="animate-pulse space-y-3 p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
        <div className="flex items-center space-x-3">
          <Skeleton className="w-4 h-4" variant="default" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <div className="flex space-x-1">
            <Skeleton className="w-16 h-6 rounded-md" />
            <Skeleton className="w-16 h-6 rounded-md" />
          </div>
        </div>
        <div className="flex items-center space-x-2 text-sm">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-1" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-1" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    ),

    history: (
      <div className="animate-pulse p-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg">
        <div className="flex items-start gap-4">
          <Skeleton className="w-6 h-6 rounded-lg" />
          <div className="flex-1 space-y-3">
            <div className="space-y-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
            </div>
            <div className="flex items-center gap-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-18" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="w-20 h-6 rounded-full" />
            <Skeleton className="w-4 h-4" />
          </div>
        </div>
      </div>
    ),

    search: (
      <div className="animate-pulse">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>

          {/* Table header */}
          <div className="bg-gray-50 dark:bg-gray-900 px-6 py-3">
            <div className="grid grid-cols-6 gap-4">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 w-8" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 w-8" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>

          {/* Table rows */}
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="px-6 py-4">
                <div className="grid grid-cols-6 gap-4 items-center">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <div className="flex space-x-2">
                      <Skeleton className="h-5 w-16 rounded-full" />
                      <Skeleton className="h-5 w-12 rounded-full" />
                    </div>
                  </div>
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="w-20 h-8 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),

    statistics: (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="animate-pulse">
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="w-8 h-8" variant="circular" />
                  <Skeleton className="h-5 w-20" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
              <div className="space-y-3">
                {[...Array(4)].map((_, j) => (
                  <div key={j} className="flex justify-between">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-12" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    ),

    calendar: (
      <div className="animate-pulse space-y-4">
        {/* Calendar header */}
        <div className="flex items-center justify-between p-4">
          <Skeleton className="h-6 w-40" />
          <div className="flex space-x-2">
            <Skeleton className="w-8 h-8" variant="circular" />
            <Skeleton className="w-8 h-8" variant="circular" />
          </div>
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1 p-4">
          {/* Day headers */}
          {[...Array(7)].map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}

          {/* Calendar days */}
          {[...Array(35)].map((_, i) => (
            <div key={i} className="h-20 p-1">
              <Skeleton className="w-full h-6 mb-1" />
              {Math.random() > 0.7 && (
                <div className="space-y-1">
                  <Skeleton className="h-2 w-full rounded" />
                  <Skeleton className="h-2 w-3/4 rounded" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    ),
  };

  const SkeletonComponent = skeletons[variant] || skeletons.queue;

  return (
    <div className={className}>
      {[...Array(count)].map((_, i) => (
        <div key={i} className={i > 0 ? 'mt-4' : ''}>
          {SkeletonComponent}
        </div>
      ))}
    </div>
  );
};

interface SkeletonListProps {
  variant?: 'queue' | 'history' | 'search';
  count?: number;
  className?: string;
}

export const SkeletonList: React.FC<SkeletonListProps> = ({
  variant = 'queue',
  count = 3,
  className,
}) => {
  return (
    <div className={cn('space-y-3', className)}>
      {[...Array(count)].map((_, i) => (
        <SkeletonCard key={i} variant={variant} />
      ))}
    </div>
  );
};

interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  className?: string;
}

export const SkeletonTable: React.FC<SkeletonTableProps> = ({
  rows = 5,
  columns = 4,
  className,
}) => {
  return (
    <div className={cn('animate-pulse', className)}>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
        {/* Header */}
        <div className="bg-gray-50 dark:bg-gray-900 px-6 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className={`grid grid-cols-${columns} gap-4`}>
            {[...Array(columns)].map((_, i) => (
              <Skeleton key={i} className="h-4 w-20" />
            ))}
          </div>
        </div>

        {/* Rows */}
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {[...Array(rows)].map((_, i) => (
            <div key={i} className="px-6 py-4">
              <div className={`grid grid-cols-${columns} gap-4 items-center`}>
                {[...Array(columns)].map((_, j) => (
                  <Skeleton
                    key={j}
                    className={cn(
                      'h-4',
                      j === 0 ? 'w-32' : j === columns - 1 ? 'w-20' : 'w-16'
                    )}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
