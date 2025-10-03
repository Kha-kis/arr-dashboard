/**
 * Global Request Queue System
 * Manages API requests to prevent overwhelming services and hitting rate limits
 */

export interface QueuedRequest {
  id: string;
  url: string;
  options: RequestInit;
  priority: number; // Higher number = higher priority
  service: string; // 'sonarr', 'radarr', 'prowlarr'
  instanceId?: string;
  resolve: (value: Response) => void;
  reject: (error: Error) => void;
  retries: number;
  maxRetries: number;
  createdAt: number;
}

export class RequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private activeRequests = new Map<string, number>(); // service -> count
  private serviceRateLimits = new Map<string, {
    maxConcurrent: number;
    requestsPerMinute: number;
    requestTimes: number[];
    lastRequestTime: number;
  }>();

  constructor() {
    // Reasonable rate limits since cache eliminates duplicate requests
    this.serviceRateLimits.set('sonarr', {
      maxConcurrent: 10, // Allow more concurrent requests
      requestsPerMinute: 300, // Much higher rate limit
      requestTimes: [],
      lastRequestTime: 0
    });
    
    this.serviceRateLimits.set('radarr', {
      maxConcurrent: 10, // Allow more concurrent requests
      requestsPerMinute: 300, // Much higher rate limit
      requestTimes: [],
      lastRequestTime: 0
    });
    
    this.serviceRateLimits.set('prowlarr', {
      maxConcurrent: 8, // Allow more concurrent requests
      requestsPerMinute: 200, // Higher rate limit
      requestTimes: [],
      lastRequestTime: 0
    });
  }

  /**
   * Add a request to the queue
   */
  enqueueRequest(
    url: string,
    options: RequestInit = {},
    service: string,
    instanceId?: string,
    priority = 0,
    maxRetries = 3
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        id: `${service}-${instanceId || 'default'}-${Date.now()}-${Math.random()}`,
        url,
        options,
        priority,
        service,
        instanceId,
        resolve,
        reject,
        retries: 0,
        maxRetries,
        createdAt: Date.now(),
      };

      // Insert request based on priority
      const insertIndex = this.queue.findIndex(r => r.priority < priority);
      if (insertIndex === -1) {
        this.queue.push(request);
      } else {
        this.queue.splice(insertIndex, 0, request);
      }

      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  /**
   * Process the request queue - handle multiple requests in parallel since cache eliminates duplicates
   */
  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      const requestsToProcess: QueuedRequest[] = [];
      
      // Process multiple requests in parallel since cache handles duplicates
      for (let i = 0; i < Math.min(this.queue.length, 10); i++) {
        const request = this.queue[i];
        if (request && this.canProcessRequest(request)) {
          requestsToProcess.push(request);
          this.queue.splice(i, 1);
          i--; // Adjust index after removal
        }
      }
      
      if (requestsToProcess.length > 0) {
        // Process multiple requests in parallel - no artificial delays
        requestsToProcess.forEach(request => this.executeRequest(request));
      } else {
        // No requests can be processed right now, wait very briefly
        await this.wait(50); // Very short wait when queue is blocked
      }
    }

    this.processing = false;
  }

  /**
   * Check if a request can be processed - now only checks basic concurrency
   */
  private canProcessRequest(request: QueuedRequest): boolean {
    // Only check very basic concurrency limits - cache prevents actual duplicate issues
    const activeCount = this.activeRequests.get(request.service) || 0;
    const serviceLimits = this.serviceRateLimits.get(request.service);
    
    // Allow reasonable concurrency but not unlimited
    return activeCount < (serviceLimits?.maxConcurrent || 20);
  }

  /**
   * Execute a request
   */
  private async executeRequest(request: QueuedRequest): Promise<void> {
    
    // Just track that we're processing a request (no rate limiting)

    // Track active requests
    const activeCount = this.activeRequests.get(request.service) || 0;
    this.activeRequests.set(request.service, activeCount + 1);

    try {
      // Add timeout to request options
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const requestOptions: RequestInit = {
        ...request.options,
        signal: controller.signal,
      };

      console.log(`[RequestQueue] Processing ${request.service} request: ${request.url}`);
      
      const response = await fetch(request.url, requestOptions);
      clearTimeout(timeoutId);
      
      // Check if response indicates rate limiting
      if (response.status === 429) {
        throw new Error('Rate limited');
      }
      
      if (!response.ok && response.status >= 400 && response.status < 500) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      request.resolve(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Handle rate limiting specifically
      if (errorMessage.includes('Rate limited') || errorMessage.includes('429')) {
        console.warn(`[RequestQueue] Rate limited for ${request.service}, retrying...`);
        
        if (request.retries < request.maxRetries) {
          request.retries++;
          // Very short delay for 429 retries - cache will serve stale data if this fails
          await this.wait(500); // Just 500ms delay
          // Put back in queue with lower priority to not block other requests
          this.queue.push(request);
        } else {
          // Don't reject - cache will serve stale data
          console.warn(`Max retries exceeded for ${request.service} request, cache will serve stale data`);
          request.reject(new Error(`Max retries exceeded for ${request.service} request`));
        }
      } else if (request.retries < request.maxRetries) {
        request.retries++;
        const backoffTime = Math.min(1000 * Math.pow(2, request.retries), 10000); // Exponential backoff, max 10s
        await this.wait(backoffTime);
        this.queue.unshift(request); // Retry
      } else {
        console.error(`[RequestQueue] Request failed after ${request.retries} retries:`, errorMessage);
        request.reject(error instanceof Error ? error : new Error(errorMessage));
      }
    } finally {
      // Decrease active request count
      const activeCount = this.activeRequests.get(request.service) || 1;
      this.activeRequests.set(request.service, Math.max(0, activeCount - 1));
    }
  }

  /**
   * Wait for a specified amount of time
   */
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get queue status for debugging
   */
  getStatus(): {
    queueLength: number;
    activeRequests: Record<string, number>;
    serviceRateLimits: Record<string, { requestsInLastMinute: number; maxRequestsPerMinute: number }>;
  } {
    const now = Date.now();
    const serviceStatus: Record<string, { requestsInLastMinute: number; maxRequestsPerMinute: number }> = {};
    
    for (const [service, limits] of this.serviceRateLimits) {
      const requestsInLastMinute = limits.requestTimes.filter(
        time => now - time < this.rateLimitWindow
      ).length;
      
      serviceStatus[service] = {
        requestsInLastMinute,
        maxRequestsPerMinute: limits.requestsPerMinute,
      };
    }

    return {
      queueLength: this.queue.length,
      activeRequests: Object.fromEntries(this.activeRequests),
      serviceRateLimits: serviceStatus,
    };
  }

  /**
   * Clear all queued requests (useful for cleanup)
   */
  clearQueue(): void {
    this.queue.forEach(request => {
      request.reject(new Error('Queue cleared'));
    });
    this.queue = [];
  }

  /**
   * Update rate limits for a service
   */
  updateServiceLimits(
    service: string, 
    limits: { maxConcurrent?: number; requestsPerMinute?: number }
  ): void {
    const existing = this.serviceRateLimits.get(service);
    if (existing) {
      if (limits.maxConcurrent !== undefined) {
        existing.maxConcurrent = limits.maxConcurrent;
      }
      if (limits.requestsPerMinute !== undefined) {
        existing.requestsPerMinute = limits.requestsPerMinute;
      }
    }
  }
}

// Global singleton instance
export const globalRequestQueue = new RequestQueue();

// Utility function to make queued requests
export function queuedFetch(
  url: string,
  options: RequestInit = {},
  service: string,
  instanceId?: string,
  priority = 0,
  maxRetries = 3
): Promise<Response> {
  return globalRequestQueue.enqueueRequest(url, options, service, instanceId, priority, maxRetries);
}