import React from 'react';
import { Button, Input, EmptyState } from '@/components/ui';
import { SkeletonCard } from '@/components/ui/SkeletonComponents';
import { Inbox } from 'lucide-react';
import { useAppStore, useFilteredQueue, useSelectedItems } from '@/store';
import { useOptimisticQueue } from '@/hooks/useOptimisticUpdates';
import { QueueItem } from '@/types';

interface QueueManagerProps {
  service: 'sonarr' | 'radarr';
  loading?: boolean;
}

export const QueueManager: React.FC<QueueManagerProps> = ({
  service,
  loading,
}) => {
  const filteredQueue = useFilteredQueue(service);
  const selectedItems = useSelectedItems(service);
  const { setFilter, toggleSelection, selectAll } = useAppStore();
  const {
    optimisticRemove,
    optimisticRetry,
    optimisticBulkAction,
    isProcessing,
  } = useOptimisticQueue();

  const filter = useAppStore(state =>
    service === 'sonarr' ? state.sonarrFilter : state.radarrFilter
  );

  const handleRemove = (
    item: QueueItem,
    blocklist = false,
    changeCategory = false
  ) => {
    if (item.id) {
      optimisticRemove({
        id: item.id,
        service,
        removeFromClient: !changeCategory, // Don't remove from client when just changing category
        blocklist: blocklist,
        changeCategory: changeCategory,
      });
    }
  };

  const handleRetry = (item: QueueItem) => {
    if (item.id) {
      optimisticRetry({ id: item.id, service });
    }
  };

  const handleBulkAction = (action: 'delete' | 'retry', options: any = {}) => {
    const ids = Array.from(selectedItems);
    if (ids.length > 0) {
      optimisticBulkAction({
        ids,
        action,
        service,
        ...options,
      });
    }
  };

  const isTorrent = (item: QueueItem) => {
    return (
      item.protocol?.toLowerCase()?.includes('torrent') ||
      item.downloadProtocol?.toLowerCase()?.includes('torrent') ||
      (item.protocol && item.protocol.toLowerCase() !== 'usenet')
    );
  };

  if (loading) {
    return <SkeletonCard variant="queue" count={3} />;
  }

  if (filteredQueue.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="Queue is empty"
        description="No downloads are currently in progress"
        size="sm"
      />
    );
  }

  const allIds = filteredQueue
    .map(item => item.id)
    .filter((id): id is number => id !== undefined && id !== null);
  const allSelected =
    allIds.length > 0 && allIds.every(id => selectedItems.has(id));

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-2 justify-between">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectAll(service, allIds)}
          >
            {allSelected ? 'Clear' : 'Select All'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleBulkAction('retry')}
            disabled={selectedItems.size === 0 || isProcessing}
          >
            {isProcessing ? 'Processing...' : 'Bulk Retry'}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() =>
              handleBulkAction('delete', {
                removeFromClient: true,
                blocklist: true,
              })
            }
            disabled={selectedItems.size === 0 || isProcessing}
          >
            {isProcessing ? 'Processing...' : 'Block & Remove'}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {selectedItems.size} selected
          </span>
          <Input
            placeholder="Filter..."
            value={filter}
            onChange={e => setFilter(service, e.target.value)}
            className="w-32"
          />
        </div>
      </div>

      {/* Queue Items */}
      <div className="space-y-2">
        {filteredQueue
          .filter(item => item.id != null)
          .map(item => (
            <div
              key={item.id}
              className="flex flex-col gap-2 p-3 border border-border rounded-lg hover:bg-accent/50"
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectedItems.has(item.id!)}
                  onChange={() => toggleSelection(service, item.id!)}
                  className="rounded"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {item.title || item.series?.title || item.movie?.title}
                  </div>
                  <div className="text-sm text-muted-foreground flex gap-2">
                    <span>{item.status}</span>
                    <span>•</span>
                    <span>{item.protocol}</span>
                    {(item as any).indexer && (
                      <>
                        <span>•</span>
                        <span className="text-blue-600 dark:text-blue-400">
                          {(item as any).indexer}
                        </span>
                      </>
                    )}
                    {(item as any).downloadClient && (
                      <>
                        <span>•</span>
                        <span className="text-green-600 dark:text-green-400">
                          {(item as any).downloadClient}
                        </span>
                      </>
                    )}
                    {item.size && (
                      <>
                        <span>•</span>
                        <span>
                          {(item.size / 1024 / 1024 / 1024).toFixed(2)} GB
                        </span>
                      </>
                    )}
                  </div>
                  {/* Status Messages */}
                  {item.statusMessages && item.statusMessages.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {item.statusMessages.map((msg, idx) => (
                        <div
                          key={idx}
                          className="text-xs text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 px-2 py-1 rounded"
                        >
                          <div className="font-medium">{msg.title}</div>
                          {msg.messages &&
                            msg.messages.map((message, msgIdx) => (
                              <div key={msgIdx} className="mt-0.5">
                                {message}
                              </div>
                            ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Error Messages */}
                  {item.errorMessage && (
                    <div className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded">
                      {item.errorMessage}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRetry(item)}
                    disabled={isProcessing}
                  >
                    Retry
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(item, false, false)}
                    disabled={isProcessing}
                  >
                    Remove
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(item, true, false)}
                  >
                    Block
                  </Button>
                  {isTorrent(item) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemove(item, false, true)}
                    >
                      Change Cat
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
};
