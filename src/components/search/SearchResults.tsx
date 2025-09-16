import React from 'react';
import {
  Download,
  ExternalLink,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  HardDrive,
  Users,
  Wifi,
  Clock,
} from 'lucide-react';
import { SearchResult } from '@/types';
import { cn, formatBytes, formatDate } from '@/utils';

interface SearchResultsProps {
  results: SearchResult[];
  onDownload: (result: SearchResult) => void;
  onSort: (key: string) => void;
  sortConfig: { key: string; direction: 'asc' | 'desc' };
  isLoading?: boolean;
  className?: string;
}

interface SortHeaderProps {
  children: React.ReactNode;
  sortKey: string;
  currentSort: { key: string; direction: 'asc' | 'desc' };
  onSort: (key: string) => void;
  className?: string;
}

const SortHeader: React.FC<SortHeaderProps> = ({
  children,
  sortKey,
  currentSort,
  onSort,
  className,
}) => {
  const isSorted = currentSort.key === sortKey;
  const direction = isSorted ? currentSort.direction : 'asc';

  return (
    <button
      onClick={() => onSort(sortKey)}
      className={cn(
        'flex items-center space-x-1 text-left hover:text-blue-600 dark:hover:text-blue-400 transition-colors',
        className
      )}
    >
      <span>{children}</span>
      {isSorted ? (
        direction === 'asc' ? (
          <ArrowUp className="h-4 w-4" />
        ) : (
          <ArrowDown className="h-4 w-4" />
        )
      ) : (
        <ArrowUpDown className="h-4 w-4 opacity-50" />
      )}
    </button>
  );
};

export const SearchResults: React.FC<SearchResultsProps> = ({
  results,
  onDownload,
  onSort,
  sortConfig,
  isLoading = false,
  className,
}) => {
  if (isLoading) {
    return (
      <div
        className={cn(
          'bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700',
          className
        )}
      >
        <div className="p-8 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-400">Searching...</p>
        </div>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div
        className={cn(
          'bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700',
          className
        )}
      >
        <div className="p-8 text-center">
          <Download className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-400 mb-2">
            No results found
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-500">
            Try adjusting your search terms or selected indexers
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700',
        className
      )}
    >
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            Search Results
          </h3>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {results.length} result{results.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Results Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <SortHeader
                  sortKey="title"
                  currentSort={sortConfig}
                  onSort={onSort}
                >
                  Title
                </SortHeader>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <SortHeader
                  sortKey="size"
                  currentSort={sortConfig}
                  onSort={onSort}
                >
                  Size
                </SortHeader>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <SortHeader
                  sortKey="seeders"
                  currentSort={sortConfig}
                  onSort={onSort}
                >
                  Seeders
                </SortHeader>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <SortHeader
                  sortKey="indexer"
                  currentSort={sortConfig}
                  onSort={onSort}
                >
                  Indexer
                </SortHeader>
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Age
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {results.map((result, index) => (
              <tr
                key={result.guid || result.id || index}
                className="hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex flex-col">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 max-w-md truncate">
                      {result.title || result.name}
                    </div>
                    <div className="flex items-center space-x-3 mt-1">
                      {result.protocol && (
                        <span
                          className={cn(
                            'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
                            result.protocol === 'torrent'
                              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                              : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                          )}
                        >
                          {result.protocol}
                        </span>
                      )}
                      {result.quality && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                          {result.quality.quality.name}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center space-x-1 text-sm text-gray-900 dark:text-gray-100">
                    <HardDrive className="h-4 w-4 text-gray-400" />
                    <span>{formatBytes(result.size)}</span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center space-x-1 text-sm text-gray-900 dark:text-gray-100">
                    <Users className="h-4 w-4 text-gray-400" />
                    <span>{result.seeders ?? 'N/A'}</span>
                    {result.leechers !== undefined && (
                      <>
                        <span className="text-gray-400">/</span>
                        <span>{result.leechers}</span>
                      </>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center space-x-1">
                    <Wifi className="h-4 w-4 text-gray-400" />
                    <span className="text-sm text-gray-900 dark:text-gray-100">
                      {result.indexer}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center space-x-1 text-sm text-gray-500 dark:text-gray-400">
                    <Clock className="h-4 w-4" />
                    <span>
                      {result.publishDate
                        ? formatDate(result.publishDate)
                        : result.ageDays
                          ? `${result.ageDays}d`
                          : 'N/A'}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex items-center justify-end space-x-2">
                    {result.infoUrl && (
                      <a
                        href={result.infoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                        title="View details"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    <button
                      onClick={() => onDownload(result)}
                      className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                      title="Download"
                    >
                      <Download className="h-4 w-4 mr-1" />
                      Grab
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
