/**
 * Advanced monitoring and analytics system
 * Provides performance monitoring, user analytics, and usage statistics
 */

import { advancedErrorHandler, ErrorCategory, ErrorSeverity } from './errorHandler';

export interface AnalyticsConfig {
  /** Enable analytics collection */
  enabled: boolean;
  /** Sample rate (0.0 to 1.0) */
  sampleRate: number;
  /** Enable performance monitoring */
  enablePerformanceMonitoring: boolean;
  /** Enable user interaction tracking */
  enableUserTracking: boolean;
  /** Enable error tracking */
  enableErrorTracking: boolean;
  /** Maximum events to store locally */
  maxEvents: number;
  /** Send interval in milliseconds */
  sendInterval: number;
}

const defaultAnalyticsConfig: AnalyticsConfig = {
  enabled: true,
  sampleRate: 1.0,
  enablePerformanceMonitoring: true,
  enableUserTracking: true,
  enableErrorTracking: true,
  maxEvents: 1000,
  sendInterval: 30000, // 30 seconds
};

export interface AnalyticsEvent {
  id: string;
  type: 'pageview' | 'interaction' | 'performance' | 'error' | 'custom';
  name: string;
  timestamp: number;
  data: Record<string, any>;
  sessionId: string;
  userId?: string;
}

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: 'ms' | 'bytes' | 'count' | 'percentage';
  timestamp: number;
  context?: Record<string, any>;
}

export interface UserInteraction {
  type: 'click' | 'scroll' | 'keyboard' | 'form' | 'navigation';
  target: string;
  timestamp: number;
  context?: Record<string, any>;
}

/**
 * Performance Monitor
 */
class PerformanceMonitor {
  private observers: PerformanceObserver[] = [];
  private metrics: PerformanceMetric[] = [];
  private config: AnalyticsConfig;

  constructor(config: AnalyticsConfig) {
    this.config = config;
    
    if (this.config.enablePerformanceMonitoring) {
      this.initializeObservers();
    }
  }

  private initializeObservers(): void {
    if (typeof window === 'undefined' || !window.PerformanceObserver) return;

    // Navigation timing
    this.observeEntryType('navigation', (entries) => {
      entries.forEach((entry: PerformanceNavigationTiming) => {
        this.addMetric('page_load_time', entry.loadEventEnd - entry.loadEventStart, 'ms', {
          domContentLoaded: entry.domContentLoadedEventEnd - entry.domContentLoadedEventStart,
          dnsLookup: entry.domainLookupEnd - entry.domainLookupStart,
          tcpConnection: entry.connectEnd - entry.connectStart,
          serverResponse: entry.responseEnd - entry.responseStart,
        });
      });
    });

    // Largest Contentful Paint
    this.observeEntryType('largest-contentful-paint', (entries) => {
      const lastEntry = entries[entries.length - 1];
      this.addMetric('largest_contentful_paint', lastEntry.startTime, 'ms', {
        element: lastEntry.element?.tagName,
        url: lastEntry.url,
      });
    });

    // First Input Delay
    this.observeEntryType('first-input', (entries) => {
      const firstInput = entries[0];
      this.addMetric('first_input_delay', firstInput.processingStart - firstInput.startTime, 'ms', {
        eventType: firstInput.name,
      });
    });

    // Cumulative Layout Shift
    this.observeEntryType('layout-shift', (entries) => {
      let clsValue = 0;
      entries.forEach((entry: PerformanceEntry & { value: number; hadRecentInput: boolean }) => {
        if (!entry.hadRecentInput) {
          clsValue += entry.value;
        }
      });
      
      this.addMetric('cumulative_layout_shift', clsValue, 'count', {
        entryCount: entries.length,
      });
    });

    // Memory usage (if available)
    if ('memory' in performance) {
      setInterval(() => {
        const memory = (performance as any).memory;
        this.addMetric('memory_usage', memory.usedJSHeapSize, 'bytes', {
          totalHeapSize: memory.totalJSHeapSize,
          heapSizeLimit: memory.jsHeapSizeLimit,
        });
      }, 10000);
    }

    // Long tasks
    this.observeEntryType('longtask', (entries) => {
      entries.forEach((entry) => {
        this.addMetric('long_task', entry.duration, 'ms', {
          startTime: entry.startTime,
          attribution: entry.attribution,
        });
      });
    });
  }

  private observeEntryType(type: string, callback: (entries: PerformanceEntry[]) => void): void {
    try {
      const observer = new PerformanceObserver((list) => {
        callback(list.getEntries());
      });
      
      observer.observe({ type, buffered: true });
      this.observers.push(observer);
    } catch (error) {
      console.warn(`Failed to observe performance entry type: ${type}`, error);
    }
  }

  private addMetric(name: string, value: number, unit: PerformanceMetric['unit'], context?: Record<string, any>): void {
    const metric: PerformanceMetric = {
      name,
      value,
      unit,
      timestamp: Date.now(),
      context,
    };

    this.metrics.push(metric);

    // Keep only recent metrics
    if (this.metrics.length > this.config.maxEvents) {
      this.metrics.shift();
    }
  }

  public getMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }

  public getMetricsSummary(): Record<string, { avg: number; min: number; max: number; count: number }> {
    const summary: Record<string, { avg: number; min: number; max: number; count: number }> = {};

    this.metrics.forEach(metric => {
      if (!summary[metric.name]) {
        summary[metric.name] = {
          avg: 0,
          min: Infinity,
          max: -Infinity,
          count: 0,
        };
      }

      const s = summary[metric.name];
      s.min = Math.min(s.min, metric.value);
      s.max = Math.max(s.max, metric.value);
      s.avg = (s.avg * s.count + metric.value) / (s.count + 1);
      s.count++;
    });

    return summary;
  }

  public destroy(): void {
    this.observers.forEach(observer => observer.disconnect());
    this.observers = [];
    this.metrics = [];
  }
}

/**
 * User Interaction Tracker
 */
class InteractionTracker {
  private interactions: UserInteraction[] = [];
  private config: AnalyticsConfig;
  private eventListeners: Array<{ element: Element; event: string; listener: EventListener }> = [];

  constructor(config: AnalyticsConfig) {
    this.config = config;
    
    if (this.config.enableUserTracking) {
      this.initializeTracking();
    }
  }

  private initializeTracking(): void {
    if (typeof window === 'undefined') return;

    // Click tracking
    this.addEventListenerToDocument('click', (event) => {
      const target = event.target as Element;
      this.trackInteraction('click', this.getElementSelector(target), {
        x: event.clientX,
        y: event.clientY,
        button: event.button,
      });
    });

    // Form interactions
    this.addEventListenerToDocument('submit', (event) => {
      const form = event.target as HTMLFormElement;
      this.trackInteraction('form', this.getElementSelector(form), {
        action: form.action,
        method: form.method,
        elements: form.elements.length,
      });
    });

    // Scroll tracking (throttled)
    let scrollTimeout: NodeJS.Timeout;
    this.addEventListenerToDocument('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        this.trackInteraction('scroll', 'window', {
          scrollY: window.scrollY,
          scrollX: window.scrollX,
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight,
        });
      }, 100);
    });

    // Keyboard interactions
    this.addEventListenerToDocument('keydown', (event) => {
      // Only track special keys to avoid capturing sensitive input
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === 'Tab') {
        this.trackInteraction('keyboard', event.key, {
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        });
      }
    });

    // Page visibility changes
    document.addEventListener('visibilitychange', () => {
      this.trackInteraction('navigation', 'visibility_change', {
        hidden: document.hidden,
        visibilityState: document.visibilityState,
      });
    });
  }

  private addEventListenerToDocument(event: string, listener: EventListener): void {
    document.addEventListener(event, listener);
    this.eventListeners.push({ element: document, event, listener });
  }

  private getElementSelector(element: Element): string {
    // Create a simple selector for the element
    let selector = element.tagName.toLowerCase();
    
    if (element.id) {
      selector += `#${element.id}`;
    }
    
    if (element.className) {
      const classes = element.className.split(' ').filter(c => c.trim());
      if (classes.length > 0) {
        selector += `.${classes.slice(0, 2).join('.')}`;
      }
    }

    return selector;
  }

  private trackInteraction(type: UserInteraction['type'], target: string, context?: Record<string, any>): void {
    const interaction: UserInteraction = {
      type,
      target,
      timestamp: Date.now(),
      context,
    };

    this.interactions.push(interaction);

    // Keep only recent interactions
    if (this.interactions.length > this.config.maxEvents) {
      this.interactions.shift();
    }
  }

  public getInteractions(): UserInteraction[] {
    return [...this.interactions];
  }

  public getInteractionsSummary(): Record<string, { count: number; targets: Record<string, number> }> {
    const summary: Record<string, { count: number; targets: Record<string, number> }> = {};

    this.interactions.forEach(interaction => {
      if (!summary[interaction.type]) {
        summary[interaction.type] = {
          count: 0,
          targets: {},
        };
      }

      summary[interaction.type].count++;
      summary[interaction.type].targets[interaction.target] = 
        (summary[interaction.type].targets[interaction.target] || 0) + 1;
    });

    return summary;
  }

  public destroy(): void {
    this.eventListeners.forEach(({ element, event, listener }) => {
      element.removeEventListener(event, listener);
    });
    this.eventListeners = [];
    this.interactions = [];
  }
}

/**
 * Main Analytics Manager
 */
class AnalyticsManager {
  private static instance: AnalyticsManager;
  private config: AnalyticsConfig;
  private events: AnalyticsEvent[] = [];
  private sessionId: string;
  private userId?: string;
  private performanceMonitor: PerformanceMonitor;
  private interactionTracker: InteractionTracker;
  private sendTimer?: NodeJS.Timeout;

  constructor(config: Partial<AnalyticsConfig> = {}) {
    this.config = { ...defaultAnalyticsConfig, ...config };
    this.sessionId = this.generateSessionId();
    
    this.performanceMonitor = new PerformanceMonitor(this.config);
    this.interactionTracker = new InteractionTracker(this.config);

    if (this.config.enabled) {
      this.startSendTimer();
      this.trackPageView();
    }
  }

  static getInstance(config?: Partial<AnalyticsConfig>): AnalyticsManager {
    if (!AnalyticsManager.instance) {
      AnalyticsManager.instance = new AnalyticsManager(config);
    }
    return AnalyticsManager.instance;
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private shouldSample(): boolean {
    return Math.random() < this.config.sampleRate;
  }

  private startSendTimer(): void {
    this.sendTimer = setInterval(() => {
      this.sendEvents();
    }, this.config.sendInterval);
  }

  public setUserId(userId: string): void {
    this.userId = userId;
  }

  public trackEvent(name: string, data?: Record<string, any>): void {
    if (!this.config.enabled || !this.shouldSample()) return;

    const event: AnalyticsEvent = {
      id: this.generateEventId(),
      type: 'custom',
      name,
      timestamp: Date.now(),
      data: data || {},
      sessionId: this.sessionId,
      userId: this.userId,
    };

    this.events.push(event);

    // Keep only recent events
    if (this.events.length > this.config.maxEvents) {
      this.events.shift();
    }
  }

  public trackPageView(page?: string): void {
    if (!this.config.enabled) return;

    const currentPage = page || window.location.pathname;
    
    this.trackEvent('page_view', {
      page: currentPage,
      title: document.title,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
    });
  }

  public trackError(error: Error, context?: Record<string, any>): void {
    if (!this.config.enabled || !this.config.enableErrorTracking) return;

    this.trackEvent('error', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      context,
    });
  }

  private generateEventId(): string {
    return `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private async sendEvents(): Promise<void> {
    if (this.events.length === 0) return;

    const eventsToSend = [...this.events];
    const performanceMetrics = this.performanceMonitor.getMetrics();
    const interactions = this.interactionTracker.getInteractions();

    const payload = {
      events: eventsToSend,
      performance: performanceMetrics,
      interactions,
      sessionId: this.sessionId,
      userId: this.userId,
      timestamp: Date.now(),
    };

    try {
      // In a real application, this would send to your analytics service
      if (process.env.NODE_ENV === 'development') {
        console.log('Would send analytics data:', payload);
      } else {
        // Example: Send to analytics endpoint
        // await fetch('/api/analytics', {
        //   method: 'POST',
        //   headers: { 'Content-Type': 'application/json' },
        //   body: JSON.stringify(payload),
        // });
      }

      // Clear sent events
      this.events = [];
    } catch (error) {
      console.error('Failed to send analytics data:', error);
      
      // Re-add events to retry later (limit to prevent memory issues)
      this.events = [...eventsToSend.slice(-100), ...this.events];
    }
  }

  public getAnalyticsSummary(): {
    events: { total: number; byType: Record<string, number> };
    performance: Record<string, { avg: number; min: number; max: number; count: number }>;
    interactions: Record<string, { count: number; targets: Record<string, number> }>;
  } {
    const eventsByType: Record<string, number> = {};
    this.events.forEach(event => {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
    });

    return {
      events: {
        total: this.events.length,
        byType: eventsByType,
      },
      performance: this.performanceMonitor.getMetricsSummary(),
      interactions: this.interactionTracker.getInteractionsSummary(),
    };
  }

  public destroy(): void {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
    }
    
    this.performanceMonitor.destroy();
    this.interactionTracker.destroy();
    
    // Send remaining events
    this.sendEvents();
  }
}

// Export singleton instance
export const analytics = AnalyticsManager.getInstance();

// Convenience functions
export const trackEvent = (name: string, data?: Record<string, any>) => analytics.trackEvent(name, data);
export const trackPageView = (page?: string) => analytics.trackPageView(page);
export const trackError = (error: Error, context?: Record<string, any>) => analytics.trackError(error, context);
export const setUserId = (userId: string) => analytics.setUserId(userId);

export default AnalyticsManager;