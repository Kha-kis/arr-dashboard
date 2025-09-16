import React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/utils';
import { Button } from './index';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
    variant?: 'default' | 'secondary' | 'ghost';
  };
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  className,
  size = 'md',
}) => {
  const sizeClasses = {
    sm: {
      container: 'py-8',
      icon: 'h-8 w-8 mb-3',
      title: 'text-base font-medium',
      description: 'text-sm',
    },
    md: {
      container: 'py-12',
      icon: 'h-12 w-12 mb-4',
      title: 'text-lg font-semibold',
      description: 'text-sm',
    },
    lg: {
      container: 'py-16',
      icon: 'h-16 w-16 mb-6',
      title: 'text-xl font-semibold',
      description: 'text-base',
    },
  };

  const classes = sizeClasses[size];

  return (
    <div
      className={cn(
        'text-center flex flex-col items-center justify-center',
        classes.container,
        className
      )}
    >
      <Icon className={cn('text-muted-foreground mx-auto', classes.icon)} />
      <h3 className={cn('text-foreground mb-2', classes.title)}>{title}</h3>
      <p
        className={cn(
          'text-muted-foreground max-w-sm mx-auto',
          classes.description
        )}
      >
        {description}
      </p>
      {action && (
        <Button
          onClick={action.onClick}
          variant={action.variant || 'default'}
          className="mt-6"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
};
