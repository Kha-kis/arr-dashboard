"use client";

import { useEffect } from "react";

interface GlobalErrorProps {
	error: Error & { digest?: string };
	reset: () => void;
}

/**
 * Global error boundary for the root layout.
 * This catches errors that occur in the root layout itself.
 * Must define its own <html> and <body> tags since it replaces the root layout.
 */
const GlobalError = ({ error, reset }: GlobalErrorProps) => {
	useEffect(() => {
		// Log the error to the console
		console.error("Global application error:", error);
	}, [error]);

	return (
		<html lang="en">
			<body className="bg-slate-950 text-white">
				<div className="flex min-h-screen items-center justify-center p-4">
					<div className="w-full max-w-md space-y-6 text-center">
						<div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
							<svg
								className="h-8 w-8 text-red-500"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								xmlns="http://www.w3.org/2000/svg"
								aria-label="Error warning"
								role="img"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
								/>
							</svg>
						</div>

						<div className="space-y-2">
							<h1 className="text-2xl font-semibold">Application Error</h1>
							<p className="text-sm text-slate-400">
								A critical error occurred. Please refresh the page or contact support if the
								problem persists.
							</p>
						</div>

						{process.env.NODE_ENV === "development" && (
							<div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-left">
								<p className="mb-2 text-xs font-medium uppercase text-red-400">Error Details</p>
								<p className="font-mono text-xs text-red-300 break-all">{error.message}</p>
								{error.digest && (
									<p className="mt-2 font-mono text-xs text-slate-500">
										Digest: {error.digest}
									</p>
								)}
							</div>
						)}

						<div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
							<button
								type="button"
								onClick={reset}
								className="inline-flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-700"
							>
								<svg
									className="h-4 w-4"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
									/>
								</svg>
								Try Again
							</button>
							<a
								href="/"
								className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700"
							>
								<svg
									className="h-4 w-4"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
									/>
								</svg>
								Return Home
							</a>
						</div>
					</div>
				</div>
			</body>
		</html>
	);
};

export default GlobalError;
