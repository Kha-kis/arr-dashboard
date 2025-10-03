/**
 * Advanced Caching Strategies
 * Provides intelligent caching, cache invalidation, offline storage, and data synchronization
 */

import { advancedErrorHandler, ErrorCategory, ErrorSeverity } from './errorHandler';
import { cacheManager } from './cache';

export interface CacheStrategy {
  name: string;
  description: string;
  priority: number;
  shouldCache: (key: string, data: any, context: CacheContext) => boolean;
  getTTL: (key: string, data: any, context: CacheContext) => number;
  getInvalidationRules: (key: string, data: any) => InvalidationRule[];
}

export interface CacheContext {
  userAgent: string;
  connectionType: string;
  isOffline: boolean;
  memoryPressure: 'low' | 'medium' | 'high';
  cacheSize: number;
  lastAccess: number;
  frequency: number;
}

export interface InvalidationRule {
  type: 'time' | 'dependency' | 'event' | 'version' | 'pattern';
  condition: any;
  cascades?: string[];
}

export interface SyncOperation {
  id: string;
  type: 'create' | 'update' | 'delete';
  resource: string;
  data: any;
  timestamp: number;
  retries: number;
  priority: 'low' | 'normal' | 'high';
  status: 'pending' | 'syncing' | 'completed' | 'failed';
}

export interface OfflineQueueItem {
  id: string;
  operation: SyncOperation;
  context: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: any;
  };
  createdAt: number;
  scheduledFor?: number;
}

/**
 * Intelligent Cache Strategy Manager
 */
class CacheStrategyManager {
  private static instance: CacheStrategyManager;
  private strategies: Map<string, CacheStrategy> = new Map();
  private context: CacheContext;
  private contextUpdateInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.context = this.initializeContext();
    this.setupContextUpdates();
    this.registerDefaultStrategies();
  }

  static getInstance(): CacheStrategyManager {
    if (!CacheStrategyManager.instance) {
      CacheStrategyManager.instance = new CacheStrategyManager();
    }
    return CacheStrategyManager.instance;
  }

  /**
   * Register a caching strategy
   */
  registerStrategy(strategy: CacheStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /**
   * Get optimal caching strategy for data
   */
  getOptimalStrategy(key: string, data: any): CacheStrategy | null {
    const applicableStrategies = Array.from(this.strategies.values())
      .filter(strategy => strategy.shouldCache(key, data, this.context))
      .sort((a, b) => b.priority - a.priority);

    return applicableStrategies[0] || null;
  }

  /**
   * Intelligently cache data using optimal strategy
   */
  async smartCache(key: string, data: any, options: { force?: boolean } = {}): Promise<void> {
    try {
      const strategy = this.getOptimalStrategy(key, data);
      
      if (!strategy && !options.force) {
        return; // Data should not be cached according to strategies
      }

      const ttl = strategy ? strategy.getTTL(key, data, this.context) : 30 * 60 * 1000;
      const tags = this.generateTags(key, data, strategy);

      await cacheManager.set(key, data, {
        ttl,
        tags,
        source: strategy?.name || 'manual'
      });

      // Set up invalidation rules
      if (strategy) {
        const invalidationRules = strategy.getInvalidationRules(key, data);
        this.setupInvalidationRules(key, invalidationRules);
      }

    } catch (error) {
      advancedErrorHandler.handleAdvancedError(
        error as Error,
        ErrorCategory.PERFORMANCE,
        ErrorSeverity.LOW,
        { context: 'CacheStrategyManager.smartCache', key }
      );
    }
  }

  /**
   * Update context information
   */
  updateContext(updates: Partial<CacheContext>): void {
    this.context = { ...this.context, ...updates };
  }

  private initializeContext(): CacheContext {
    return {
      userAgent: navigator.userAgent,
      connectionType: this.getConnectionType(),
      isOffline: !navigator.onLine,
      memoryPressure: this.getMemoryPressure(),
      cacheSize: 0,
      lastAccess: Date.now(),
      frequency: 1
    };
  }

  private setupContextUpdates(): void {
    // Update context every 30 seconds
    this.contextUpdateInterval = setInterval(() => {
      this.updateContext({
        connectionType: this.getConnectionType(),
        isOffline: !navigator.onLine,
        memoryPressure: this.getMemoryPressure(),
        lastAccess: Date.now()
      });
    }, 30000);

    // Listen for connection changes
    window.addEventListener('online', () => {
      this.updateContext({ isOffline: false });
    });

    window.addEventListener('offline', () => {
      this.updateContext({ isOffline: true });
    });
  }

  private getConnectionType(): string {
    // @ts-ignore - navigator.connection is not in all browsers
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return connection?.effectiveType || 'unknown';
  }

  private getMemoryPressure(): 'low' | 'medium' | 'high' {
    // @ts-ignore - performance.memory is not standardized
    const memory = (performance as any).memory;
    if (!memory) return 'low';

    const usedPercent = (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100;
    
    if (usedPercent > 80) return 'high';
    if (usedPercent > 60) return 'medium';
    return 'low';
  }

  private generateTags(key: string, data: any, strategy?: CacheStrategy): string[] {
    const tags: string[] = [];
    
    // Add strategy tag
    if (strategy) {
      tags.push(`strategy:${strategy.name}`);
    }

    // Add resource type tag
    if (key.includes('api/')) {
      const pathParts = key.split('/');
      const resource = pathParts[pathParts.indexOf('api') + 1];
      tags.push(`resource:${resource}`);
    }

    // Add data type tag
    if (Array.isArray(data)) {
      tags.push('type:array');
    } else if (typeof data === 'object') {
      tags.push('type:object');
    } else {
      tags.push(`type:${typeof data}`);
    }

    return tags;
  }

  private setupInvalidationRules(key: string, rules: InvalidationRule[]): void {
    for (const rule of rules) {
      switch (rule.type) {
        case 'dependency':
          this.setupDependencyInvalidation(key, rule);
          break;
        case 'event':
          this.setupEventInvalidation(key, rule);
          break;
        case 'pattern':
          this.setupPatternInvalidation(key, rule);
          break;
      }
    }
  }

  private setupDependencyInvalidation(key: string, rule: InvalidationRule): void {
    // Set up dependency-based invalidation
    const dependencies = rule.condition as string[];
    for (const dep of dependencies) {
      // This would typically integrate with a dependency tracking system
      console.log(`Setting up dependency invalidation: ${key} depends on ${dep}`);
    }
  }

  private setupEventInvalidation(key: string, rule: InvalidationRule): void {
    // Set up event-based invalidation
    const eventName = rule.condition as string;
    window.addEventListener(eventName, async () => {
      await cacheManager.delete(key);
      if (rule.cascades) {
        await cacheManager.invalidateByTags(rule.cascades);
      }
    });
  }

  private setupPatternInvalidation(key: string, rule: InvalidationRule): void {
    // Set up pattern-based invalidation
    const pattern = rule.condition as RegExp;
    // This would integrate with a pattern matching system
    console.log(`Setting up pattern invalidation: ${key} with pattern ${pattern}`);
  }

  private registerDefaultStrategies(): void {
    // Frequent Access Strategy - cache frequently accessed data longer
    this.registerStrategy({
      name: 'frequent-access',
      description: 'Cache frequently accessed data with extended TTL',
      priority: 100,
      shouldCache: (key, data, context) => context.frequency > 3,
      getTTL: (key, data, context) => {
        const baseTTL = 30 * 60 * 1000; // 30 minutes
        return baseTTL * Math.min(context.frequency, 10); // Up to 5 hours for very frequent
      },
      getInvalidationRules: () => [
        { type: 'time', condition: { maxAge: 24 * 60 * 60 * 1000 } } // Max 24 hours
      ]
    });

    // Network-Aware Strategy - adjust caching based on connection
    this.registerStrategy({
      name: 'network-aware',
      description: 'Adjust caching based on network conditions',
      priority: 90,
      shouldCache: (key, data, context) => context.connectionType !== '4g' || context.isOffline,
      getTTL: (key, data, context) => {
        if (context.isOffline) return 24 * 60 * 60 * 1000; // 24 hours offline
        if (context.connectionType === 'slow-2g') return 4 * 60 * 60 * 1000; // 4 hours
        if (context.connectionType === '2g') return 2 * 60 * 60 * 1000; // 2 hours
        return 60 * 60 * 1000; // 1 hour default
      },
      getInvalidationRules: () => [
        { type: 'event', condition: 'online' }
      ]
    });

    // Memory-Aware Strategy - adjust caching based on memory pressure
    this.registerStrategy({
      name: 'memory-aware',
      description: 'Adjust caching based on memory pressure',
      priority: 80,
      shouldCache: (key, data, context) => context.memoryPressure !== 'high',
      getTTL: (key, data, context) => {
        if (context.memoryPressure === 'high') return 5 * 60 * 1000; // 5 minutes
        if (context.memoryPressure === 'medium') return 15 * 60 * 1000; // 15 minutes
        return 60 * 60 * 1000; // 1 hour
      },
      getInvalidationRules: () => []
    });

    // Critical Data Strategy - cache critical data aggressively
    this.registerStrategy({
      name: 'critical-data',
      description: 'Aggressively cache critical application data',
      priority: 120,
      shouldCache: (key, data, context) => {
        return key.includes('user') || key.includes('config') || key.includes('auth');
      },
      getTTL: () => 4 * 60 * 60 * 1000, // 4 hours
      getInvalidationRules: (key) => [
        { type: 'event', condition: 'user-logout' },
        { type: 'dependency', condition: ['user-data', 'config-data'] }
      ]
    });
  }

  destroy(): void {
    if (this.contextUpdateInterval) {
      clearInterval(this.contextUpdateInterval);
    }
  }
}

/**
 * Offline Synchronization Manager
 */
class OfflineSyncManager {
  private static instance: OfflineSyncManager;
  private queue: Map<string, OfflineQueueItem> = new Map();
  private syncInterval: NodeJS.Timeout | null = null;
  private isOnline = navigator.onLine;

  constructor() {
    this.setupEventListeners();
    this.loadQueueFromStorage();
    this.startSyncProcess();
  }

  static getInstance(): OfflineSyncManager {
    if (!OfflineSyncManager.instance) {
      OfflineSyncManager.instance = new OfflineSyncManager();
    }
    return OfflineSyncManager.instance;
  }

  /**
   * Queue operation for offline synchronization
   */
  queueOperation(operation: Omit<SyncOperation, 'id' | 'timestamp' | 'retries' | 'status'>): string {
    const id = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const syncOperation: SyncOperation = {
      ...operation,
      id,
      timestamp: Date.now(),
      retries: 0,
      status: 'pending'
    };

    const queueItem: OfflineQueueItem = {
      id,
      operation: syncOperation,
      context: {
        url: '',
        method: operation.type === 'create' ? 'POST' : operation.type === 'update' ? 'PUT' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: operation.data
      },
      createdAt: Date.now()
    };

    this.queue.set(id, queueItem);
    this.saveQueueToStorage();

    if (this.isOnline) {
      this.processQueue();
    }

    return id;
  }

  /**
   * Process offline queue when online
   */
  private async processQueue(): Promise<void> {
    if (!this.isOnline || this.queue.size === 0) return;

    const priorityOrder = { high: 3, normal: 2, low: 1 };
    const sortedItems = Array.from(this.queue.values())
      .filter(item => item.operation.status === 'pending')
      .sort((a, b) => {
        const priorityDiff = priorityOrder[b.operation.priority] - priorityOrder[a.operation.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return a.createdAt - b.createdAt; // FIFO for same priority
      });

    for (const item of sortedItems) {
      try {
        item.operation.status = 'syncing';
        await this.syncOperation(item);
        item.operation.status = 'completed';
        this.queue.delete(item.id);
      } catch (error) {
        item.operation.status = 'failed';
        item.operation.retries++;
        
        if (item.operation.retries >= 3) {
          console.error(`Failed to sync operation ${item.id} after 3 retries:`, error);
          this.queue.delete(item.id); // Remove permanently failed operations
        } else {
          // Schedule retry with exponential backoff
          const delay = Math.min(1000 * Math.pow(2, item.operation.retries), 30000);
          item.scheduledFor = Date.now() + delay;
          item.operation.status = 'pending';
        }
      }
    }

    this.saveQueueToStorage();
  }

  private async syncOperation(item: OfflineQueueItem): Promise<void> {
    // This would integrate with your actual API client
    const response = await fetch(item.context.url, {
      method: item.context.method,
      headers: item.context.headers,
      body: item.context.body ? JSON.stringify(item.context.body) : undefined
    });

    if (!response.ok) {
      throw new Error(`Sync failed: ${response.status} ${response.statusText}`);
    }

    // Update cache with synced data
    const responseData = await response.json();
    await cacheManager.set(
      `${item.operation.resource}:${item.operation.data?.id || 'latest'}`,
      responseData,
      { tags: [item.operation.resource, 'synced'] }
    );
  }

  private setupEventListeners(): void {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.processQueue();
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
    });
  }

  private startSyncProcess(): void {
    // Check for scheduled retries every minute
    this.syncInterval = setInterval(() => {
      const now = Date.now();
      let hasScheduledItems = false;

      for (const item of this.queue.values()) {
        if (item.scheduledFor && item.scheduledFor <= now && item.operation.status === 'pending') {
          hasScheduledItems = true;
          break;
        }
      }

      if (hasScheduledItems && this.isOnline) {
        this.processQueue();
      }
    }, 60000); // Every minute
  }

  private loadQueueFromStorage(): void {
    try {
      const stored = localStorage.getItem('arr-dashboard-sync-queue');
      if (stored) {
        const queueData = JSON.parse(stored);
        this.queue = new Map(queueData);
      }
    } catch (error) {
      console.warn('Failed to load sync queue from storage:', error);
    }
  }

  private saveQueueToStorage(): void {
    try {
      const queueData = Array.from(this.queue.entries());
      localStorage.setItem('arr-dashboard-sync-queue', JSON.stringify(queueData));
    } catch (error) {
      console.warn('Failed to save sync queue to storage:', error);
    }
  }

  /**
   * Get queue status
   */
  getQueueStatus() {
    const items = Array.from(this.queue.values());
    return {
      total: items.length,
      pending: items.filter(item => item.operation.status === 'pending').length,
      syncing: items.filter(item => item.operation.status === 'syncing').length,
      failed: items.filter(item => item.operation.status === 'failed').length,
      oldestItem: items.length > 0 ? Math.min(...items.map(item => item.createdAt)) : null
    };
  }

  destroy(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
  }
}

/**
 * Predictive Cache Preloader
 */
class PredictiveCachePreloader {
  private static instance: PredictiveCachePreloader;
  private accessPatterns: Map<string, { count: number; lastAccess: number; nextPredicted?: number }> = new Map();
  private preloadQueue: Set<string> = new Set();

  constructor() {
    this.loadPatternsFromStorage();
    this.setupPreloadProcess();
  }

  static getInstance(): PredictiveCachePreloader {
    if (!PredictiveCachePreloader.instance) {
      PredictiveCachePreloader.instance = new PredictiveCachePreloader();
    }
    return PredictiveCachePreloader.instance;
  }

  /**
   * Record access pattern
   */
  recordAccess(key: string): void {
    const now = Date.now();
    const existing = this.accessPatterns.get(key);
    
    if (existing) {
      const timeDiff = now - existing.lastAccess;
      existing.count++;
      existing.lastAccess = now;
      
      // Predict next access time based on pattern
      if (existing.count > 3) {
        existing.nextPredicted = now + (timeDiff / existing.count);
      }
    } else {
      this.accessPatterns.set(key, {
        count: 1,
        lastAccess: now
      });
    }

    this.savePatternsToStorage();
  }

  /**
   * Get predictions for preloading
   */
  getPredictions(): string[] {
    const now = Date.now();
    const predictions: string[] = [];

    for (const [key, pattern] of this.accessPatterns.entries()) {
      if (pattern.nextPredicted && pattern.nextPredicted <= now + 300000) { // Within 5 minutes
        predictions.push(key);
      }
    }

    return predictions.sort((a, b) => {
      const patternA = this.accessPatterns.get(a)!;
      const patternB = this.accessPatterns.get(b)!;
      return (patternA.nextPredicted || 0) - (patternB.nextPredicted || 0);
    });
  }

  private setupPreloadProcess(): void {
    // Check for preload opportunities every 2 minutes
    setInterval(() => {
      const predictions = this.getPredictions();
      
      for (const key of predictions.slice(0, 5)) { // Limit to 5 predictions
        if (!this.preloadQueue.has(key)) {
          this.schedulePreload(key);
        }
      }
    }, 2 * 60 * 1000);
  }

  private async schedulePreload(key: string): Promise<void> {
    this.preloadQueue.add(key);
    
    try {
      // This would integrate with your actual data fetching logic
      // For now, we'll simulate preloading
      console.log(`Preloading predicted access: ${key}`);
      
      // Remove from queue after processing
      setTimeout(() => {
        this.preloadQueue.delete(key);
      }, 1000);
      
    } catch (error) {
      this.preloadQueue.delete(key);
      console.warn(`Failed to preload ${key}:`, error);
    }
  }

  private loadPatternsFromStorage(): void {
    try {
      const stored = localStorage.getItem('arr-dashboard-access-patterns');
      if (stored) {
        const patternsData = JSON.parse(stored);
        this.accessPatterns = new Map(patternsData);
      }
    } catch (error) {
      console.warn('Failed to load access patterns from storage:', error);
    }
  }

  private savePatternsToStorage(): void {
    try {
      const patternsData = Array.from(this.accessPatterns.entries());
      localStorage.setItem('arr-dashboard-access-patterns', JSON.stringify(patternsData));
    } catch (error) {
      console.warn('Failed to save access patterns to storage:', error);
    }
  }

  getStats() {
    return {
      totalPatterns: this.accessPatterns.size,
      activePreloads: this.preloadQueue.size,
      predictions: this.getPredictions().length
    };
  }
}

// Export singleton instances
export const cacheStrategyManager = CacheStrategyManager.getInstance();
export const offlineSyncManager = OfflineSyncManager.getInstance();
export const predictiveCachePreloader = PredictiveCachePreloader.getInstance();

// Convenience functions
export const smartCache = (key: string, data: any, options?: { force?: boolean }) =>
  cacheStrategyManager.smartCache(key, data, options);

export const queueOfflineOperation = (operation: Omit<SyncOperation, 'id' | 'timestamp' | 'retries' | 'status'>) =>
  offlineSyncManager.queueOperation(operation);

export const recordCacheAccess = (key: string) => predictiveCachePreloader.recordAccess(key);

export default {
  cacheStrategyManager,
  offlineSyncManager,
  predictiveCachePreloader
};