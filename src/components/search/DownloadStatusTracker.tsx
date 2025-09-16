import React from 'react';
import { CheckCircle, AlertCircle, Clock, Download, X } from 'lucide-react';
import { cn } from '@/utils';

interface DownloadStatus {
  id: string;
  title: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  timestamp: Date;
  error?: string;
}

interface DownloadStatusTrackerProps {
  className?: string;
}

export const DownloadStatusTracker: React.FC<DownloadStatusTrackerProps> = ({
  className,
}) => {
  const [downloads, setDownloads] = React.useState<DownloadStatus[]>([]);
  const [isVisible, setIsVisible] = React.useState(false);

  // Auto-hide completed/failed downloads after 5 seconds
  React.useEffect(() => {
    downloads.forEach(download => {
      if (download.status === 'completed' || download.status === 'failed') {
        const timeSinceUpdate = Date.now() - download.timestamp.getTime();
        if (timeSinceUpdate > 5000) {
          setDownloads(prev => prev.filter(d => d.id !== download.id));
        }
      }
    });
  }, [downloads]);

  // Show/hide tracker based on active downloads
  React.useEffect(() => {
    setIsVisible(downloads.length > 0);
  }, [downloads.length]);

  const addDownload = React.useCallback((id: string, title: string) => {
    setDownloads(prev => [
      ...prev.filter(d => d.id !== id), // Remove existing entry
      {
        id,
        title,
        status: 'pending',
        timestamp: new Date(),
      },
    ]);
  }, []);

  const updateDownloadStatus = React.useCallback(
    (id: string, status: DownloadStatus['status'], error?: string) => {
      setDownloads(prev =>
        prev.map(download =>
          download.id === id
            ? { ...download, status, timestamp: new Date(), error }
            : download
        )
      );
    },
    []
  );

  const removeDownload = React.useCallback((id: string) => {
    setDownloads(prev => prev.filter(d => d.id !== id));
  }, []);

  // Expose methods to parent components via ref or global state
  React.useEffect(() => {
    // You could expose these methods via a global store or context
    (window as any).downloadTracker = {
      addDownload,
      updateDownloadStatus,
      removeDownload,
    };
  }, [addDownload, updateDownloadStatus, removeDownload]);

  const getStatusIcon = (status: DownloadStatus['status']) => {
    switch (status) {
      case 'pending':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'downloading':
        return <Download className="h-4 w-4 text-blue-500 animate-bounce" />;
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'failed':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return null;
    }
  };

  const getStatusText = (status: DownloadStatus['status']) => {
    switch (status) {
      case 'pending':
        return 'Queued';
      case 'downloading':
        return 'Downloading';
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      default:
        return '';
    }
  };

  const getStatusColor = (status: DownloadStatus['status']) => {
    switch (status) {
      case 'pending':
        return 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20';
      case 'downloading':
        return 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20';
      case 'completed':
        return 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20';
      case 'failed':
        return 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20';
      default:
        return '';
    }
  };

  if (!isVisible || downloads.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-40 max-w-sm w-full space-y-2',
        className
      )}
    >
      {downloads.map(download => (
        <div
          key={download.id}
          className={cn(
            'flex items-start space-x-3 p-4 rounded-lg border shadow-lg backdrop-blur-sm transition-all duration-300',
            getStatusColor(download.status)
          )}
        >
          <div className="flex-shrink-0 mt-0.5">
            {getStatusIcon(download.status)}
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {download.title}
            </p>
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {getStatusText(download.status)}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-500">
                {download.timestamp.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
            {download.error && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-1 truncate">
                {download.error}
              </p>
            )}
          </div>

          {/* Close button for completed/failed downloads */}
          {(download.status === 'completed' ||
            download.status === 'failed') && (
            <button
              onClick={() => removeDownload(download.id)}
              className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      ))}

      {/* Clear all completed/failed button */}
      {downloads.some(
        d => d.status === 'completed' || d.status === 'failed'
      ) && (
        <div className="flex justify-center mt-2">
          <button
            onClick={() =>
              setDownloads(prev =>
                prev.filter(
                  d => d.status !== 'completed' && d.status !== 'failed'
                )
              )
            }
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors px-2 py-1 rounded"
          >
            Clear completed
          </button>
        </div>
      )}
    </div>
  );
};
