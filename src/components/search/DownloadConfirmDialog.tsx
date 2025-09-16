import React from 'react';
import { X, Download, ExternalLink, Info, AlertTriangle } from 'lucide-react';
import { SearchResult } from '@/types';
import { formatBytes, cn } from '@/utils';

interface DownloadConfirmDialogProps {
  result: SearchResult | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (result: SearchResult) => void;
  isDownloading?: boolean;
}

export const DownloadConfirmDialog: React.FC<DownloadConfirmDialogProps> = ({
  result,
  isOpen,
  onClose,
  onConfirm,
  isDownloading = false,
}) => {
  if (!isOpen || !result) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleConfirm = () => {
    onConfirm(result);
  };

  const getProtocolIcon = () => {
    return result.protocol === 'torrent' ? '🌱' : '📡';
  };

  const getProtocolColor = () => {
    return result.protocol === 'torrent'
      ? 'text-green-600 dark:text-green-400'
      : 'text-blue-600 dark:text-blue-400';
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Confirm Download
          </h3>
          <button
            onClick={onClose}
            disabled={isDownloading}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Title */}
          <div>
            <h4 className="font-medium text-gray-900 dark:text-gray-100 text-base">
              {result.title || result.name}
            </h4>
          </div>

          {/* Details Grid */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            {/* Size */}
            <div>
              <span className="text-gray-500 dark:text-gray-400 block">
                Size
              </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {formatBytes(result.size)}
              </span>
            </div>

            {/* Protocol */}
            <div>
              <span className="text-gray-500 dark:text-gray-400 block">
                Protocol
              </span>
              <span
                className={cn(
                  'font-medium capitalize flex items-center space-x-1',
                  getProtocolColor()
                )}
              >
                <span>{getProtocolIcon()}</span>
                <span>{result.protocol}</span>
              </span>
            </div>

            {/* Indexer */}
            <div>
              <span className="text-gray-500 dark:text-gray-400 block">
                Indexer
              </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {result.indexer}
              </span>
            </div>

            {/* Seeders (if torrent) */}
            {result.protocol === 'torrent' && result.seeders !== undefined && (
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">
                  Seeders
                </span>
                <span
                  className={cn(
                    'font-medium',
                    result.seeders > 0
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  )}
                >
                  {result.seeders}
                  {result.leechers !== undefined && ` / ${result.leechers}`}
                </span>
              </div>
            )}

            {/* Quality */}
            {result.quality && (
              <div className="col-span-2">
                <span className="text-gray-500 dark:text-gray-400 block">
                  Quality
                </span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {result.quality.quality.name}
                  {result.quality.revision.version > 1 &&
                    ` v${result.quality.revision.version}`}
                </span>
              </div>
            )}
          </div>

          {/* Warnings */}
          {result.protocol === 'torrent' &&
            (result.seeders === 0 || !result.seeders) && (
              <div className="flex items-start space-x-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md">
                <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5" />
                <div className="text-sm">
                  <p className="text-yellow-800 dark:text-yellow-200 font-medium">
                    Low or No Seeders
                  </p>
                  <p className="text-yellow-700 dark:text-yellow-300 text-xs mt-1">
                    This torrent may download slowly or not at all due to lack
                    of seeders.
                  </p>
                </div>
              </div>
            )}

          {/* Info Note */}
          <div className="flex items-start space-x-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
            <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5" />
            <div className="text-sm">
              <p className="text-blue-800 dark:text-blue-200 font-medium">
                Download Process
              </p>
              <p className="text-blue-700 dark:text-blue-300 text-xs mt-1">
                This will send the release to your configured download clients
                via Prowlarr.
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between p-6 border-t border-gray-200 dark:border-gray-700 space-x-3">
          {/* Info Link */}
          {result.infoUrl && (
            <a
              href={result.infoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              <ExternalLink className="h-4 w-4 mr-1" />
              Details
            </a>
          )}

          <div className="flex space-x-3">
            <button
              onClick={onClose}
              disabled={isDownloading}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={isDownloading}
              className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isDownloading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                  Downloading...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
