import React from 'react';
import { Filter, ChevronDown, Check } from 'lucide-react';
import { Indexer } from '@/types';
import { cn } from '@/utils';

interface SearchFiltersProps {
  searchType: 'movie' | 'tv';
  onSearchTypeChange: (type: 'movie' | 'tv') => void;
  indexers: Indexer[];
  selectedIndexers: Set<number>;
  onIndexerToggle: (indexerId: number) => void;
  className?: string;
}

export const SearchFilters: React.FC<SearchFiltersProps> = ({
  searchType,
  onSearchTypeChange,
  indexers,
  selectedIndexers,
  onIndexerToggle,
  className,
}) => {
  const [isIndexerDropdownOpen, setIsIndexerDropdownOpen] =
    React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsIndexerDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const enabledIndexers = indexers.filter(indexer => indexer.enable);
  const selectedCount = selectedIndexers.size;
  const allSelected = selectedCount === enabledIndexers.length;
  const someSelected =
    selectedCount > 0 && selectedCount < enabledIndexers.length;

  const handleSelectAll = () => {
    if (allSelected) {
      // Deselect all
      enabledIndexers.forEach(indexer => {
        if (selectedIndexers.has(indexer.id)) {
          onIndexerToggle(indexer.id);
        }
      });
    } else {
      // Select all
      enabledIndexers.forEach(indexer => {
        if (!selectedIndexers.has(indexer.id)) {
          onIndexerToggle(indexer.id);
        }
      });
    }
  };

  return (
    <div className={cn('flex flex-col sm:flex-row gap-4', className)}>
      {/* Search Type Toggle */}
      <div className="flex items-center space-x-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
        <button
          onClick={() => onSearchTypeChange('movie')}
          className={cn(
            'px-4 py-2 rounded-md text-sm font-medium transition-all duration-200',
            searchType === 'movie'
              ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          )}
        >
          Movies
        </button>
        <button
          onClick={() => onSearchTypeChange('tv')}
          className={cn(
            'px-4 py-2 rounded-md text-sm font-medium transition-all duration-200',
            searchType === 'tv'
              ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          )}
        >
          TV Shows
        </button>
      </div>

      {/* Indexer Selection Dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setIsIndexerDropdownOpen(!isIndexerDropdownOpen)}
          className={cn(
            'flex items-center justify-between min-w-48 px-4 py-2 border border-gray-300 dark:border-gray-600',
            'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg',
            'hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors duration-200',
            'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
          )}
        >
          <div className="flex items-center space-x-2">
            <Filter className="h-4 w-4" />
            <span className="text-sm">
              {selectedCount === 0
                ? 'Select indexers'
                : selectedCount === enabledIndexers.length
                  ? 'All indexers'
                  : `${selectedCount} indexers`}
            </span>
          </div>
          <ChevronDown
            className={cn(
              'h-4 w-4 transition-transform duration-200',
              isIndexerDropdownOpen && 'transform rotate-180'
            )}
          />
        </button>

        {isIndexerDropdownOpen && (
          <div className="absolute z-50 mt-2 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-h-64 overflow-y-auto">
            {/* Select All Option */}
            <div
              onClick={handleSelectAll}
              className="flex items-center space-x-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer border-b border-gray-200 dark:border-gray-700"
            >
              <div
                className={cn(
                  'flex items-center justify-center w-4 h-4 border-2 rounded',
                  allSelected
                    ? 'bg-blue-600 border-blue-600'
                    : someSelected
                      ? 'bg-blue-600 border-blue-600'
                      : 'border-gray-300 dark:border-gray-600'
                )}
              >
                {allSelected && <Check className="h-3 w-3 text-white" />}
                {someSelected && !allSelected && (
                  <div className="w-2 h-2 bg-white rounded-sm" />
                )}
              </div>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Select All ({enabledIndexers.length})
              </span>
            </div>

            {/* Individual Indexers */}
            {enabledIndexers.map(indexer => {
              const isSelected = selectedIndexers.has(indexer.id);
              return (
                <div
                  key={indexer.id}
                  onClick={() => onIndexerToggle(indexer.id)}
                  className="flex items-center space-x-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                >
                  <div
                    className={cn(
                      'flex items-center justify-center w-4 h-4 border-2 rounded',
                      isSelected
                        ? 'bg-blue-600 border-blue-600'
                        : 'border-gray-300 dark:border-gray-600'
                    )}
                  >
                    {isSelected && <Check className="h-3 w-3 text-white" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
                      {indexer.name}
                    </span>
                    <div className="flex items-center space-x-2 mt-1">
                      <span
                        className={cn(
                          'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
                          indexer.protocol === 'torrent'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                        )}
                      >
                        {indexer.protocol}
                      </span>
                      {indexer.priority && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          Priority: {indexer.priority}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {enabledIndexers.length === 0 && (
              <div className="px-4 py-6 text-center text-gray-500 dark:text-gray-400">
                <Filter className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No indexers configured</p>
                <p className="text-xs mt-1">
                  Configure indexers in Prowlarr settings
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
