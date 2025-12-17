"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

interface ErrorProps {
	error: Error & { digest?: string };
	reset: () => void;
}

/**
 * Global error boundary for the application.
 * Catches JavaScript errors in route segments and displays a fallback UI.
 */
const ErrorBoundary = ({ error, reset }: ErrorProps) => {
	useEffect(() => {
		// Log the error to the console in development
		console.error("Application error:", error);
	}, [error]);

	return (
		<div className="flex min-h-screen items-center justify-center bg-bg p-4">
			<div className="w-full max-w-md space-y-6 text-center">
				<div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
					<AlertTriangle className="h-8 w-8 text-red-500" />
				</div>

				<div className="space-y-2">
					<h1 className="text-2xl font-semibold text-fg">Something went wrong</h1>
					<p className="text-sm text-fg-muted">
						An unexpected error occurred. Please try again or return to the dashboard.
					</p>
				</div>

				{process.env.NODE_ENV === "development" && (
					<div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-left">
						<p className="mb-2 text-xs font-medium uppercase text-red-400">Error Details</p>
						<p className="font-mono text-xs text-red-300 break-all">{error.message}</p>
						{error.digest && (
							<p className="mt-2 font-mono text-xs text-fg-muted">
								Digest: {error.digest}
							</p>
						)}
					</div>
				)}

				<div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
					<button
						type="button"
						onClick={reset}
						className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary/90"
					>
						<RefreshCw className="h-4 w-4" />
						Try Again
					</button>
					<a
						href="/dashboard"
						className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-bg-subtle px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-bg-subtle/80"
					>
						<Home className="h-4 w-4" />
						Go to Dashboard
					</a>
				</div>
			</div>
		</div>
	);
};

export default ErrorBoundary;
