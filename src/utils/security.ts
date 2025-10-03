/**
 * Advanced security utilities and validation
 * Provides comprehensive input validation, XSS protection, and security monitoring
 */

import { advancedErrorHandler, ErrorCategory, ErrorSeverity } from './errorHandler';

/**
 * Security Configuration
 */
export interface SecurityConfig {
  /** Enable strict CSP */
  enableCSP: boolean;
  /** Maximum input length */
  maxInputLength: number;
  /** Rate limiting configuration */
  rateLimiting: {
    enabled: boolean;
    maxRequests: number;
    windowMs: number;
  };
  /** Allowed origins for CORS */
  allowedOrigins: string[];
  /** Enable security logging */
  enableLogging: boolean;
}

const defaultSecurityConfig: SecurityConfig = {
  enableCSP: true,
  maxInputLength: 10000,
  rateLimiting: {
    enabled: true,
    maxRequests: 100,
    windowMs: 60000, // 1 minute
  },
  allowedOrigins: ['http://localhost:3000', 'http://localhost:5173'],
  enableLogging: true,
};

/**
 * Input Validation Utilities
 */
export class InputValidator {
  private static instance: InputValidator;
  private config: SecurityConfig;

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...defaultSecurityConfig, ...config };
  }

  static getInstance(config?: Partial<SecurityConfig>): InputValidator {
    if (!InputValidator.instance) {
      InputValidator.instance = new InputValidator(config);
    }
    return InputValidator.instance;
  }

  /**
   * Sanitize HTML input to prevent XSS attacks
   */
  sanitizeHTML(input: string): string {
    if (!input || typeof input !== 'string') return '';

    // Basic HTML entity encoding
    const entityMap: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;',
      '`': '&#x60;',
      '=': '&#x3D;',
    };

    return input.replace(/[&<>"'`=\/]/g, (match) => entityMap[match]);
  }

  /**
   * Validate and sanitize URL input
   */
  validateURL(input: string): { isValid: boolean; sanitized: string; error?: string } {
    if (!input || typeof input !== 'string') {
      return { isValid: false, sanitized: '', error: 'Invalid URL input' };
    }

    try {
      const url = new URL(input);
      
      // Check protocol whitelist
      const allowedProtocols = ['http:', 'https:'];
      if (!allowedProtocols.includes(url.protocol)) {
        return { isValid: false, sanitized: '', error: 'Invalid protocol' };
      }

      // Check for potentially malicious patterns
      const maliciousPatterns = [
        /javascript:/i,
        /data:/i,
        /vbscript:/i,
        /onload=/i,
        /onerror=/i,
      ];

      for (const pattern of maliciousPatterns) {
        if (pattern.test(input)) {
          return { isValid: false, sanitized: '', error: 'Potentially malicious URL' };
        }
      }

      return { isValid: true, sanitized: url.toString() };
    } catch (error) {
      return { isValid: false, sanitized: '', error: 'Malformed URL' };
    }
  }

  /**
   * Validate API key format
   */
  validateAPIKey(input: string): { isValid: boolean; error?: string } {
    if (!input || typeof input !== 'string') {
      return { isValid: false, error: 'API key is required' };
    }

    // Check length
    if (input.length < 10 || input.length > 128) {
      return { isValid: false, error: 'API key length must be between 10 and 128 characters' };
    }

    // Check for valid characters (alphanumeric and common special characters)
    const validPattern = /^[a-zA-Z0-9\-_=+/]+$/;
    if (!validPattern.test(input)) {
      return { isValid: false, error: 'API key contains invalid characters' };
    }

    return { isValid: true };
  }

  /**
   * Validate port number
   */
  validatePort(input: string | number): { isValid: boolean; port?: number; error?: string } {
    const portNum = typeof input === 'string' ? parseInt(input, 10) : input;

    if (isNaN(portNum)) {
      return { isValid: false, error: 'Port must be a number' };
    }

    if (portNum < 1 || portNum > 65535) {
      return { isValid: false, error: 'Port must be between 1 and 65535' };
    }

    // Warn about common system ports
    if (portNum < 1024) {
      return { isValid: true, port: portNum, error: 'Warning: Using system port' };
    }

    return { isValid: true, port: portNum };
  }

  /**
   * Validate file path input
   */
  validateFilePath(input: string): { isValid: boolean; sanitized?: string; error?: string } {
    if (!input || typeof input !== 'string') {
      return { isValid: false, error: 'File path is required' };
    }

    // Check for path traversal attempts
    const dangerousPatterns = [
      /\.\./,
      /\/\//,
      /\\\\+/,
      /<script/i,
      /javascript:/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(input)) {
        return { isValid: false, error: 'Potentially dangerous file path' };
      }
    }

    // Normalize path separators and remove dangerous characters
    const sanitized = input
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/[<>"|?*]/g, '');

    return { isValid: true, sanitized };
  }

  /**
   * General input length validation
   */
  validateLength(input: string, maxLength?: number): { isValid: boolean; error?: string } {
    if (!input) return { isValid: true };

    const limit = maxLength || this.config.maxInputLength;
    if (input.length > limit) {
      return { isValid: false, error: `Input exceeds maximum length of ${limit} characters` };
    }

    return { isValid: true };
  }
}

/**
 * Content Security Policy Manager
 */
export class CSPManager {
  private static nonce: string | null = null;

  /**
   * Generate a cryptographically secure nonce
   */
  static generateNonce(): string {
    if (typeof window === 'undefined') return '';

    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    const nonce = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    CSPManager.nonce = nonce;
    return nonce;
  }

  /**
   * Get current nonce
   */
  static getNonce(): string | null {
    return CSPManager.nonce;
  }

  /**
   * Generate CSP header value
   */
  static generateCSPHeader(config: Partial<SecurityConfig> = {}): string {
    const mergedConfig = { ...defaultSecurityConfig, ...config };
    const nonce = CSPManager.generateNonce();

    const directives = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self' " + mergedConfig.allowedOrigins.join(' '),
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ];

    return directives.join('; ');
  }
}

/**
 * Rate Limiting Manager
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private config: SecurityConfig['rateLimiting'];

  constructor(config: SecurityConfig['rateLimiting'] = defaultSecurityConfig.rateLimiting) {
    this.config = config;
    
    // Clean up old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if request is allowed
   */
  isAllowed(identifier: string): boolean {
    if (!this.config.enabled) return true;

    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    
    // Get existing requests for this identifier
    let requests = this.requests.get(identifier) || [];
    
    // Remove requests outside the window
    requests = requests.filter(timestamp => timestamp > windowStart);
    
    // Check if limit exceeded
    if (requests.length >= this.config.maxRequests) {
      this.logRateLimitExceeded(identifier);
      return false;
    }

    // Add current request
    requests.push(now);
    this.requests.set(identifier, requests);
    
    return true;
  }

  private logRateLimitExceeded(identifier: string): void {
    const error = new Error(`Rate limit exceeded for ${identifier}`);
    advancedErrorHandler.handleAdvancedError(error, ErrorCategory.SECURITY, ErrorSeverity.HIGH, {
      identifier,
      limit: this.config.maxRequests,
      window: this.config.windowMs,
    });
  }

  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    
    for (const [identifier, requests] of this.requests.entries()) {
      const validRequests = requests.filter(timestamp => timestamp > cutoff);
      
      if (validRequests.length === 0) {
        this.requests.delete(identifier);
      } else {
        this.requests.set(identifier, validRequests);
      }
    }
  }
}

/**
 * Security Monitor
 */
export class SecurityMonitor {
  private static instance: SecurityMonitor;
  private config: SecurityConfig;
  private rateLimiter: RateLimiter;
  private validator: InputValidator;
  private securityEvents: Array<{
    type: string;
    severity: string;
    timestamp: number;
    details: any;
  }> = [];

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...defaultSecurityConfig, ...config };
    this.rateLimiter = new RateLimiter(this.config.rateLimiting);
    this.validator = new InputValidator(this.config);
  }

  static getInstance(config?: Partial<SecurityConfig>): SecurityMonitor {
    if (!SecurityMonitor.instance) {
      SecurityMonitor.instance = new SecurityMonitor(config);
    }
    return SecurityMonitor.instance;
  }

  /**
   * Log security event
   */
  logSecurityEvent(type: string, severity: 'low' | 'medium' | 'high' | 'critical', details: any): void {
    if (!this.config.enableLogging) return;

    const event = {
      type,
      severity,
      timestamp: Date.now(),
      details,
    };

    this.securityEvents.push(event);

    // Keep only recent events (last 1000)
    if (this.securityEvents.length > 1000) {
      this.securityEvents.shift();
    }

    // Report critical events immediately
    if (severity === 'critical') {
      this.reportCriticalEvent(event);
    }

    if (process.env.NODE_ENV === 'development') {
      console.warn(`[SECURITY] ${severity.toUpperCase()} - ${type}:`, details);
    }
  }

  private reportCriticalEvent(event: any): void {
    const error = new Error(`Critical security event: ${event.type}`);
    advancedErrorHandler.handleAdvancedError(error, ErrorCategory.SECURITY, ErrorSeverity.CRITICAL, event.details);
  }

  /**
   * Check request security
   */
  checkRequest(url: string, data?: any): { allowed: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check rate limiting
    const clientId = this.getClientIdentifier();
    if (!this.rateLimiter.isAllowed(clientId)) {
      issues.push('Rate limit exceeded');
      this.logSecurityEvent('rate_limit_exceeded', 'high', { clientId, url });
    }

    // Validate URL
    const urlValidation = this.validator.validateURL(url);
    if (!urlValidation.isValid) {
      issues.push(`Invalid URL: ${urlValidation.error}`);
      this.logSecurityEvent('invalid_url', 'medium', { url, error: urlValidation.error });
    }

    // Check for suspicious patterns in data
    if (data && typeof data === 'object') {
      const suspiciousPatterns = this.checkForSuspiciousPatterns(data);
      if (suspiciousPatterns.length > 0) {
        issues.push('Suspicious data patterns detected');
        this.logSecurityEvent('suspicious_data', 'high', { patterns: suspiciousPatterns, data });
      }
    }

    return {
      allowed: issues.length === 0,
      issues,
    };
  }

  private getClientIdentifier(): string {
    // In a real application, this would use more sophisticated client identification
    return `${window.location.host}-${Date.now().toString().slice(-6)}`;
  }

  private checkForSuspiciousPatterns(data: any): string[] {
    const patterns: string[] = [];
    const dataString = JSON.stringify(data).toLowerCase();

    // Check for common attack patterns
    const attackPatterns = [
      { pattern: /<script/i, name: 'XSS Script Tag' },
      { pattern: /javascript:/i, name: 'JavaScript Protocol' },
      { pattern: /on\w+\s*=/i, name: 'Event Handler' },
      { pattern: /union\s+select/i, name: 'SQL Injection' },
      { pattern: /drop\s+table/i, name: 'SQL Drop Statement' },
      { pattern: /\.\.\//, name: 'Path Traversal' },
    ];

    for (const { pattern, name } of attackPatterns) {
      if (pattern.test(dataString)) {
        patterns.push(name);
      }
    }

    return patterns;
  }

  /**
   * Get security statistics
   */
  getSecurityStats(): {
    totalEvents: number;
    eventsBySeverity: Record<string, number>;
    recentEvents: Array<any>;
  } {
    const stats = {
      totalEvents: this.securityEvents.length,
      eventsBySeverity: {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      },
      recentEvents: this.securityEvents.slice(-10),
    };

    this.securityEvents.forEach(event => {
      stats.eventsBySeverity[event.severity]++;
    });

    return stats;
  }

  /**
   * Clear security logs
   */
  clearLogs(): void {
    this.securityEvents = [];
  }
}

// Export singleton instances
export const inputValidator = InputValidator.getInstance();
export const securityMonitor = SecurityMonitor.getInstance();

// Utility functions for common use cases
export const sanitizeInput = (input: string) => inputValidator.sanitizeHTML(input);
export const validateApiUrl = (url: string) => inputValidator.validateURL(url);
export const validateApiKey = (key: string) => inputValidator.validateAPIKey(key);
export const validatePortNumber = (port: string | number) => inputValidator.validatePort(port);

// Security middleware for fetch requests
export const secureRequest = async (url: string, options: RequestInit = {}): Promise<Response> => {
  // Check request security
  const securityCheck = securityMonitor.checkRequest(url, options.body);
  
  if (!securityCheck.allowed) {
    throw new Error(`Security check failed: ${securityCheck.issues.join(', ')}`);
  }

  // Add security headers
  const secureHeaders = {
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Add CSP nonce if available
  const nonce = CSPManager.getNonce();
  if (nonce) {
    secureHeaders['X-CSP-Nonce'] = nonce;
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers: secureHeaders,
    });

    // Log successful request
    securityMonitor.logSecurityEvent('request_success', 'low', { url, status: response.status });

    return response;
  } catch (error) {
    // Log failed request
    securityMonitor.logSecurityEvent('request_failure', 'medium', { url, error: error.message });
    throw error;
  }
};

export default {
  InputValidator,
  CSPManager,
  RateLimiter,
  SecurityMonitor,
  inputValidator,
  securityMonitor,
  sanitizeInput,
  validateApiUrl,
  validateApiKey,
  validatePortNumber,
  secureRequest,
};