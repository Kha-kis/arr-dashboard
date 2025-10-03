import React from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { Button, Card, CardHeader, CardContent } from '@/components/ui';
import { useAppStore } from '@/store';

interface ErrorFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
}

export const ErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  resetErrorBoundary,
}) => {
  const { setError } = useAppStore();

  const handleReset = () => {
    setError(null);
    resetErrorBoundary();
    // Optionally reload the page for a complete reset
    // window.location.reload();
  };

  const handleReload = () => {
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader
          title="Something went wrong"
          subtitle="An unexpected error occurred while running the application."
        />
        <CardContent className="space-y-4">
          {/* Error details */}
          <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <h4 className="font-medium text-destructive mb-1">
                  {error.name || 'Error'}
                </h4>
                <p className="text-sm text-destructive/80 break-words">
                  {error.message || 'An unknown error occurred'}
                </p>
              </div>
            </div>
          </div>

          {/* Error stack in development */}
          {process.env.NODE_ENV === 'development' && error.stack && (
            <details className="group">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Show technical details
              </summary>
              <pre className="mt-2 p-3 bg-muted rounded-lg text-xs overflow-auto text-muted-foreground">
                {error.stack}
              </pre>
            </details>
          )}

          {/* Action buttons */}
          <div className="flex flex-col sm:flex-row gap-3">
            <Button onClick={handleReset} className="flex-1" variant="default">
              <RefreshCw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
            <Button
              onClick={handleReload}
              className="flex-1"
              variant="secondary"
            >
              <Home className="h-4 w-4 mr-2" />
              Reload Page
            </Button>
          </div>

          {/* Help text */}
          <div className="text-center">
            <p className="text-xs text-muted-foreground">
              If this problem persists, try clearing your browser cache and
              cookies.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
