import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, AlertTriangle, Info, X, ChevronDown, Search, Filter } from 'lucide-react';
import { cn } from '@/utils';
import { Button } from './index';

// Enhanced Toast Component with better animations
export interface EnhancedToastProps {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  duration?: number;
  onClose?: () => void;
}

export const EnhancedToast: React.FC<EnhancedToastProps> = React.memo(({
  type,
  title,
  message,
  duration = 5000,
  onClose
}) => {
  const [isVisible, setIsVisible] = useState(true);

  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(() => onClose?.(), 300);
  }, [onClose]);

  React.useEffect(() => {
    const timer = setTimeout(handleClose, duration);
    return () => clearTimeout(timer);
  }, [duration, handleClose]);

  const variants = {
    enter: { 
      opacity: 0, 
      x: 300, 
      scale: 0.9,
      transition: { type: "spring", stiffness: 300, damping: 30 }
    },
    center: { 
      opacity: 1, 
      x: 0, 
      scale: 1,
      transition: { type: "spring", stiffness: 300, damping: 30 }
    },
    exit: { 
      opacity: 0, 
      x: 300, 
      scale: 0.9,
      transition: { duration: 0.2 }
    }
  };

  const iconMap = {
    success: <Check className="w-5 h-5" />,
    error: <X className="w-5 h-5" />,
    warning: <AlertTriangle className="w-5 h-5" />,
    info: <Info className="w-5 h-5" />,
  };

  const colorMap = {
    success: 'bg-green-500 dark:bg-green-600',
    error: 'bg-red-500 dark:bg-red-600',
    warning: 'bg-yellow-500 dark:bg-yellow-600',
    info: 'bg-blue-500 dark:bg-blue-600',
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial="enter"
          animate="center"
          exit="exit"
          variants={variants}
          className="max-w-sm w-full bg-white dark:bg-gray-800 shadow-lg rounded-xl pointer-events-auto ring-1 ring-black ring-opacity-5 overflow-hidden"
        >
          <div className="p-4">
            <div className="flex items-start">
              <div className={cn("flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white", colorMap[type])}>
                {iconMap[type]}
              </div>
              <div className="ml-3 w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {title}
                </p>
                {message && (
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {message}
                  </p>
                )}
              </div>
              <div className="ml-4 flex-shrink-0 flex">
                <button
                  className="rounded-md inline-flex text-gray-400 hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                  onClick={handleClose}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
          <motion.div 
            className={cn("h-1", colorMap[type])}
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ duration: duration / 1000, ease: "linear" }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
});

// Enhanced Dropdown with better UX
export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: React.ReactNode;
}

interface EnhancedDropdownProps {
  options: DropdownOption[];
  value?: string;
  placeholder?: string;
  onSelect: (value: string) => void;
  className?: string;
  searchable?: boolean;
}

export const EnhancedDropdown: React.FC<EnhancedDropdownProps> = React.memo(({
  options,
  value,
  placeholder = "Select an option",
  onSelect,
  className,
  searchable = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const filteredOptions = searchable 
    ? options.filter(option => 
        option.label.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : options;

  const selectedOption = options.find(option => option.value === value);

  const handleSelect = useCallback((optionValue: string) => {
    onSelect(optionValue);
    setIsOpen(false);
    setSearchTerm('');
  }, [onSelect]);

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        className={cn(
          "relative w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600",
          "rounded-xl shadow-sm pl-3 pr-10 py-3 text-left cursor-pointer",
          "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
          "hover:border-gray-400 dark:hover:border-gray-500 transition-colors duration-200"
        )}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="flex items-center">
          {selectedOption?.icon && (
            <span className="mr-2">{selectedOption.icon}</span>
          )}
          <span className="block truncate">
            {selectedOption?.label || placeholder}
          </span>
        </span>
        <span className="ml-3 absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
          <motion.div
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <ChevronDown className="h-5 w-5 text-gray-400" />
          </motion.div>
        </span>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg max-h-60 rounded-xl py-1 text-base ring-1 ring-black ring-opacity-5 overflow-auto focus:outline-none"
          >
            {searchable && (
              <div className="sticky top-0 z-10 bg-white dark:bg-gray-800 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    className="w-full pl-9 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Search options..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
              </div>
            )}
            
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                No options found
              </div>
            ) : (
              filteredOptions.map((option) => (
                <motion.button
                  key={option.value}
                  type="button"
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700",
                    "focus:outline-none focus:bg-gray-100 dark:focus:bg-gray-700",
                    option.disabled && "opacity-50 cursor-not-allowed",
                    value === option.value && "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"
                  )}
                  onClick={() => !option.disabled && handleSelect(option.value)}
                  disabled={option.disabled}
                  whileHover={{ backgroundColor: option.disabled ? undefined : "rgba(0,0,0,0.05)" }}
                  whileTap={{ scale: 0.98 }}
                >
                  <span className="flex items-center">
                    {option.icon && (
                      <span className="mr-2">{option.icon}</span>
                    )}
                    {option.label}
                  </span>
                </motion.button>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

// Enhanced Loading Skeleton with better animations
interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'circular' | 'rectangular';
  animation?: 'pulse' | 'wave';
}

export const EnhancedSkeleton: React.FC<SkeletonProps> = React.memo(({
  className,
  variant = 'rectangular',
  animation = 'pulse'
}) => {
  const baseClasses = "bg-gray-200 dark:bg-gray-700";
  
  const variantClasses = {
    text: "h-4 w-full rounded",
    circular: "rounded-full",
    rectangular: "rounded-md"
  };

  const animationClasses = {
    pulse: "animate-pulse",
    wave: "relative overflow-hidden before:absolute before:inset-0 before:-translate-x-full before:bg-gradient-to-r before:from-transparent before:via-white/10 before:to-transparent before:animate-[shimmer_2s_infinite]"
  };

  return (
    <div className={cn(
      baseClasses,
      variantClasses[variant],
      animationClasses[animation],
      className
    )} />
  );
});

// Enhanced Filter Pills Component
interface FilterPill {
  id: string;
  label: string;
  count?: number;
  active?: boolean;
}

interface FilterPillsProps {
  filters: FilterPill[];
  onFilterChange: (filterId: string) => void;
  className?: string;
}

export const FilterPills: React.FC<FilterPillsProps> = React.memo(({
  filters,
  onFilterChange,
  className
}) => {
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {filters.map((filter) => (
        <motion.button
          key={filter.id}
          onClick={() => onFilterChange(filter.id)}
          className={cn(
            "inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
            filter.active 
              ? "bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border-2 border-blue-200 dark:border-blue-700"
              : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-2 border-transparent hover:bg-gray-200 dark:hover:bg-gray-700"
          )}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          layout
        >
          <Filter className="w-3 h-3 mr-1" />
          {filter.label}
          {filter.count !== undefined && (
            <span className={cn(
              "ml-1 px-1.5 py-0.5 rounded-full text-xs",
              filter.active 
                ? "bg-blue-200 dark:bg-blue-800 text-blue-800 dark:text-blue-200"
                : "bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400"
            )}>
              {filter.count}
            </span>
          )}
        </motion.button>
      ))}
    </div>
  );
});

// Enhanced Card with hover effects and better shadows
interface EnhancedCardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
}

export const EnhancedCard: React.FC<EnhancedCardProps> = React.memo(({
  children,
  className,
  hover = true,
  onClick
}) => {
  return (
    <motion.div
      className={cn(
        "bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700",
        hover && "transition-shadow duration-200 hover:shadow-lg hover:shadow-gray-200/50 dark:hover:shadow-gray-900/50",
        onClick && "cursor-pointer",
        className
      )}
      whileHover={hover ? { y: -2 } : undefined}
      whileTap={onClick ? { scale: 0.98 } : undefined}
      onClick={onClick}
    >
      {children}
    </motion.div>
  );
});