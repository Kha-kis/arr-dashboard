// MANUAL SEARCH - NO AUTO SEARCH
import React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/utils';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  isLoading?: boolean;
}

export const SearchInput: React.FC<SearchInputProps> = ({
  value,
  onChange,
  onSearch,
  placeholder = 'Search for movies, TV shows...',
  className,
  disabled = false,
  isLoading = false,
}) => {
  const [localValue, setLocalValue] = React.useState(value);

  // Sync with external value changes
  React.useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    onChange(newValue);
  };

  const handleSearch = () => {
    if (localValue.trim()) {
      onSearch(localValue);
    }
  };

  const handleClear = () => {
    setLocalValue('');
    onChange('');
    onSearch('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    }
  };

  return (
    <div className={cn('relative flex', className)}>
      <div className="relative flex-1">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <Search className="h-5 w-5 text-gray-400" />
        </div>

        <input
          type="text"
          value={localValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'block w-full pl-10 pr-10 py-3 border border-gray-300 rounded-l-lg',
            'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100',
            'placeholder-gray-500 dark:placeholder-gray-400',
            'focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600',
            'transition-colors duration-200',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        />

        {localValue && (
          <button
            onClick={handleClear}
            disabled={disabled}
            className={cn(
              'absolute inset-y-0 right-0 pr-3 flex items-center',
              'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200',
              'transition-colors duration-200',
              disabled && 'cursor-not-allowed'
            )}
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <button
        onClick={handleSearch}
        disabled={disabled || !localValue.trim() || isLoading}
        className={cn(
          'px-6 py-3 border border-l-0 border-gray-300 dark:border-gray-600 rounded-r-lg',
          'bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600',
          'text-white font-medium',
          'transition-colors duration-200',
          'focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
          disabled && 'cursor-not-allowed'
        )}
      >
        {isLoading ? (
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
        ) : (
          'Search'
        )}
      </button>
    </div>
  );
};
