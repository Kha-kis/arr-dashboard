import React, { forwardRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Check, ChevronDown } from 'lucide-react';
import { cn } from '@/utils';

// Button component with variants and loading state
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'ghost' | 'danger' | 'success';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  children: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'default',
      size = 'md',
      loading,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center rounded-xl font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

    const variants = {
      default:
        'bg-primary text-primary-foreground hover:bg-primary/90 focus:ring-primary',
      secondary:
        'bg-secondary text-secondary-foreground hover:bg-secondary/80 focus:ring-secondary',
      ghost:
        'bg-transparent hover:bg-accent hover:text-accent-foreground focus:ring-accent',
      danger:
        'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus:ring-destructive',
      success:
        'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500',
    };

    const sizes = {
      sm: 'h-8 px-3 text-sm',
      md: 'h-10 px-4 py-2',
      lg: 'h-12 px-6 text-lg',
    };

    return (
      <button
        ref={ref}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

// Input component with enhanced styling
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <div className="w-full">
        <input
          ref={ref}
          className={cn(
            'flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm ring-offset-background',
            'file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            error && 'border-destructive focus-visible:ring-destructive',
            className
          )}
          {...props}
        />
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-1 text-sm text-destructive"
          >
            {error}
          </motion.p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

// Card components
interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const Card = ({ className, children, ...props }: CardProps) => (
  <div
    className={cn(
      'rounded-2xl border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md',
      className
    )}
    {...props}
  >
    {children}
  </div>
);

interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

export const CardHeader = ({
  className,
  title,
  subtitle,
  actions,
  children,
  ...props
}: CardHeaderProps) => (
  <div
    className={cn('flex items-center justify-between p-6 pb-0', className)}
    {...props}
  >
    <div className="space-y-1.5">
      {title && (
        <h3 className="text-2xl font-semibold leading-none tracking-tight">
          {title}
        </h3>
      )}
      {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      {children}
    </div>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>
);

export const CardContent = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-6 pt-0', className)} {...props} />
);

// Badge component
interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'secondary' | 'success' | 'warning' | 'danger';
  children: React.ReactNode;
}

export const Badge = ({
  className,
  variant = 'default',
  children,
  ...props
}: BadgeProps) => {
  const variants = {
    default: 'bg-primary/10 text-primary border-primary/20',
    secondary: 'bg-secondary/10 text-secondary-foreground border-secondary/20',
    success:
      'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/20 dark:text-green-400',
    warning:
      'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-400',
    danger:
      'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/20 dark:text-red-400',
  };

  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

// Progress component
interface ProgressProps {
  value: number;
  max?: number;
  className?: string;
  showLabel?: boolean;
}

export const Progress = ({
  value,
  max = 100,
  className,
  showLabel = false,
}: ProgressProps) => {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);

  return (
    <div className={cn('w-full', className)}>
      <div className="flex items-center justify-between mb-1">
        {showLabel && (
          <span className="text-sm font-medium text-muted-foreground">
            {percentage.toFixed(0)}%
          </span>
        )}
      </div>
      <div className="w-full bg-secondary rounded-full h-2">
        <motion.div
          className="bg-primary h-2 rounded-full transition-all duration-300"
          initial={{ width: 0 }}
          animate={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
};

// Switch component
interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export const Switch = ({
  checked,
  onChange,
  disabled,
  label,
  className,
}: SwitchProps) => {
  return (
    <label
      className={cn(
        'inline-flex items-center gap-3 cursor-pointer select-none',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <div
        className={cn(
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-input',
          disabled && 'cursor-not-allowed'
        )}
      >
        <motion.div
          className="inline-block h-4 w-4 transform rounded-full bg-background shadow-lg ring-0 transition-transform"
          animate={{ x: checked ? 24 : 4 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      </div>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
      />
      {label && <span className="text-sm font-medium">{label}</span>}
    </label>
  );
};

// Select component
interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, placeholder, ...props }, ref) => {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(
            'flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm ring-offset-background',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'appearance-none pr-8',
            className
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-3 h-4 w-4 opacity-50 pointer-events-none" />
      </div>
    );
  }
);

Select.displayName = 'Select';

// Skeleton loader
interface SkeletonProps {
  className?: string;
}

export const Skeleton = ({ className }: SkeletonProps) => (
  <div className={cn('animate-pulse rounded-md bg-muted', className)} />
);

// Loading spinner
interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const LoadingSpinner = ({
  size = 'md',
  className,
}: LoadingSpinnerProps) => {
  const sizes = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-8 w-8',
  };

  return <Loader2 className={cn('animate-spin', sizes[size], className)} />;
};

// Status indicator
interface StatusIndicatorProps {
  status: 'online' | 'offline' | 'loading';
  label?: string;
  className?: string;
}

export const StatusIndicator = ({
  status,
  label,
  className,
}: StatusIndicatorProps) => {
  const statusColors = {
    online: 'bg-green-500',
    offline: 'bg-red-500',
    loading: 'bg-yellow-500',
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="relative">
        <div className={cn('h-2 w-2 rounded-full', statusColors[status])}>
          {status === 'loading' && (
            <div className="absolute inset-0 h-2 w-2 rounded-full bg-yellow-500 animate-pulse" />
          )}
        </div>
        {status === 'online' && (
          <div className="absolute inset-0 h-2 w-2 rounded-full bg-green-500 animate-ping opacity-75" />
        )}
      </div>
      {label && <span className="text-sm text-muted-foreground">{label}</span>}
    </div>
  );
};

// Checkbox component
interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  className?: string;
}

export const Checkbox = ({
  checked,
  onChange,
  disabled,
  indeterminate,
  className,
}: CheckboxProps) => {
  return (
    <div className={cn('relative flex items-center', className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        className="sr-only"
      />
      <div
        className={cn(
          'flex h-4 w-4 items-center justify-center rounded border-2 transition-colors',
          checked || indeterminate
            ? 'bg-primary border-primary text-primary-foreground'
            : 'border-input bg-background',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        onClick={() => !disabled && onChange(!checked)}
      >
        <AnimatePresence>
          {checked && !indeterminate && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
            >
              <Check className="h-3 w-3" />
            </motion.div>
          )}
          {indeterminate && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
            >
              <div className="h-0.5 w-2 bg-primary-foreground" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

// Re-export enhanced skeleton components
export * from './SkeletonComponents';

// Export new standardized components
export { LoadingState } from './LoadingState';
export type { LoadingStateProps } from './LoadingState';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { FormField } from './FormField';
export type { FormFieldProps } from './FormField';

export { Dialog } from './Dialog';
export type { DialogProps } from './Dialog';
