import React from 'react';
import { cn } from '@/utils';

export interface FormFieldProps {
  label?: string;
  description?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const FormField: React.FC<FormFieldProps> = ({
  label,
  description,
  error,
  required,
  className,
  children,
}) => {
  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </label>
      )}

      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}

      <div className="relative">{children}</div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
};
