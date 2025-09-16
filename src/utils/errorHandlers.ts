import { toast } from 'sonner';

/**
 * Standard error interface
 */
export interface AppError {
  message: string;
  code?: string;
  status?: number;
  service?: string;
  context?: string;
  originalError?: any;
}

/**
 * Error type classifications
 */
export enum ErrorType {
  NETWORK = 'network',
  AUTHENTICATION = 'authentication',
  AUTHORIZATION = 'authorization',
  VALIDATION = 'validation',
  NOT_FOUND = 'not_found',
  SERVER = 'server',
  UNKNOWN = 'unknown',
}

/**
 * Classify error based on status code and message
 */
export const classifyError = (error: any): ErrorType => {
  const status = error?.status || error?.response?.status;
  const message = error?.message || '';

  if (status === 401) return ErrorType.AUTHENTICATION;
  if (status === 403) return ErrorType.AUTHORIZATION;
  if (status === 404) return ErrorType.NOT_FOUND;
  if (status >= 400 && status < 500) return ErrorType.VALIDATION;
  if (status >= 500) return ErrorType.SERVER;
  if (message.toLowerCase().includes('network')) return ErrorType.NETWORK;

  return ErrorType.UNKNOWN;
};

/**
 * Create standardized error object
 */
export const createAppError = (
  error: any,
  context: string,
  service?: string
): AppError => {
  const errorType = classifyError(error);
  const status = error?.status || error?.response?.status;

  let message = 'An unexpected error occurred';

  // Extract meaningful message
  if (error?.message) {
    message = error.message;
  } else if (error?.response?.data?.message) {
    message = error.response.data.message;
  } else if (error?.response?.data?.error) {
    message = error.response.data.error;
  }

  return {
    message,
    code: errorType,
    status,
    service,
    context,
    originalError: error,
  };
};

/**
 * Get user-friendly error message
 */
export const getUserFriendlyMessage = (appError: AppError): string => {
  const { code, service, context } = appError;

  switch (code) {
    case ErrorType.AUTHENTICATION:
      return `Authentication failed for ${service || 'service'}. Please check your API key.`;

    case ErrorType.AUTHORIZATION:
      return `Access denied. You don't have permission to perform this action.`;

    case ErrorType.NOT_FOUND:
      return `The requested resource was not found. Please check your configuration.`;

    case ErrorType.NETWORK:
      return `Network error. Please check your connection and service URLs.`;

    case ErrorType.VALIDATION:
      if (
        appError.message.includes('already exists') ||
        appError.message.includes('already been added')
      ) {
        return `This item is already in your library.`;
      }
      return `Invalid request. Please check your input and try again.`;

    case ErrorType.SERVER:
      return `Server error occurred. The ${service || 'service'} may be experiencing issues.`;

    default:
      return appError.message || `Failed to ${context}. Please try again.`;
  }
};

/**
 * Handle API errors with consistent logging and user feedback
 */
export const handleApiError = (
  error: any,
  context: string,
  service?: string,
  showToast: boolean = true
): AppError => {
  const appError = createAppError(error, context, service);

  // Log error for debugging
  console.error(`[${service || 'API'}] ${context}:`, {
    message: appError.message,
    status: appError.status,
    code: appError.code,
    originalError: appError.originalError,
  });

  // Show user-friendly toast
  if (showToast) {
    const userMessage = getUserFriendlyMessage(appError);

    if (
      appError.code === ErrorType.AUTHENTICATION ||
      appError.code === ErrorType.AUTHORIZATION
    ) {
      toast.error(userMessage, {
        description: 'Check your settings and API configuration.',
        action: {
          label: 'Settings',
          onClick: () => (window.location.href = '/settings'),
        },
      });
    } else if (appError.code === ErrorType.NETWORK) {
      toast.error(userMessage, {
        description: 'Verify your service URLs and network connection.',
      });
    } else if (
      appError.code === ErrorType.VALIDATION &&
      userMessage.includes('already in your library')
    ) {
      toast.warning(userMessage);
    } else {
      toast.error(userMessage);
    }
  }

  return appError;
};

/**
 * Retry logic for failed API calls
 */
export const withRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  context: string = 'operation',
  service?: string
): Promise<T> => {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const appError = createAppError(error, context, service);

      // Don't retry on client errors (except rate limiting)
      if (
        appError.status &&
        appError.status >= 400 &&
        appError.status < 500 &&
        appError.status !== 429
      ) {
        break;
      }

      // Don't retry on authentication/authorization errors
      if (
        appError.code === ErrorType.AUTHENTICATION ||
        appError.code === ErrorType.AUTHORIZATION
      ) {
        break;
      }

      if (attempt === maxRetries) break;

      // Exponential backoff
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));

      console.warn(
        `[${service || 'API'}] Retrying ${context} (attempt ${attempt + 1}/${maxRetries})`
      );
    }
  }

  throw lastError;
};

/**
 * Batch error handler for multiple operations
 */
export const handleBatchErrors = (
  errors: Array<{ error: any; context: string; service?: string }>,
  showIndividualToasts: boolean = false
): AppError[] => {
  const appErrors = errors.map(({ error, context, service }) =>
    handleApiError(error, context, service, showIndividualToasts)
  );

  if (!showIndividualToasts && appErrors.length > 0) {
    // Show summary toast for batch errors
    const errorCounts = appErrors.reduce(
      (acc, error) => {
        acc[error.code || 'unknown'] = (acc[error.code || 'unknown'] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const summary = Object.entries(errorCounts)
      .map(([type, count]) => `${count} ${type}`)
      .join(', ');

    toast.error(`Multiple errors occurred: ${summary}`, {
      description: 'Check the console for detailed error information.',
    });
  }

  return appErrors;
};

/**
 * Format error for display in UI components
 */
export const formatErrorForDisplay = (error: AppError): string => {
  return getUserFriendlyMessage(error);
};
