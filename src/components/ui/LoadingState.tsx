import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/utils';
import { LoadingSpinner, Skeleton } from './index';

export interface LoadingStateProps {
  variant?: 'spinner' | 'skeleton' | 'inline' | 'overlay';
  size?: 'sm' | 'md' | 'lg';
  message?: string;
  className?: string;
  count?: number; // For skeleton variant
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  variant = 'spinner',
  size = 'md',
  message,
  className,
  count = 3,
}) => {
  if (variant === 'skeleton') {
    return (
      <div className={cn('space-y-3', className)}>
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="animate-pulse">
            <div className="flex items-center space-x-4">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-[250px]" />
                <Skeleton className="h-4 w-[200px]" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'inline') {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <LoadingSpinner size={size} />
        {message && (
          <span
            className={cn(
              'text-muted-foreground',
              size === 'sm'
                ? 'text-sm'
                : size === 'lg'
                  ? 'text-lg'
                  : 'text-base'
            )}
          >
            {message}
          </span>
        )}
      </div>
    );
  }

  if (variant === 'overlay') {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className={cn(
          'absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm z-50',
          className
        )}
      >
        <div className="flex flex-col items-center gap-4">
          <LoadingSpinner size={size} />
          {message && (
            <p
              className={cn(
                'text-muted-foreground text-center',
                size === 'sm'
                  ? 'text-sm'
                  : size === 'lg'
                    ? 'text-lg'
                    : 'text-base'
              )}
            >
              {message}
            </p>
          )}
        </div>
      </motion.div>
    );
  }

  // Default spinner variant
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 py-8',
        className
      )}
    >
      <LoadingSpinner size={size} />
      {message && (
        <p
          className={cn(
            'text-muted-foreground text-center',
            size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-lg' : 'text-base'
          )}
        >
          {message}
        </p>
      )}
    </div>
  );
};
