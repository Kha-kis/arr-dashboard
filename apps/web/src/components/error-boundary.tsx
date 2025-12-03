/**
 * Error Boundary Component
 * Catches React errors and displays fallback UI
 */

"use client";

import { AlertCircle } from "lucide-react";
import React, { Component, type ReactNode } from "react";
import { Alert, AlertDescription } from "./ui";

const MAX_RETRIES = 3;
const DEFAULT_ERROR_MESSAGE = "An unexpected error occurred";
const MAX_MESSAGE_LENGTH = 200;

/**
 * Sanitizes error messages to avoid exposing sensitive details to users.
 * Removes URLs, file paths, API keys, tokens, and other sensitive patterns.
 * Enforces max length and returns a safe default on failure or suspicious content.
 */
function sanitizeErrorMessage(message: string | undefined | null): string {
	try {
		if (!message || typeof message !== "string" || message.trim().length === 0) {
			return DEFAULT_ERROR_MESSAGE;
		}

		let sanitized = message;

		// Patterns that indicate sensitive content - return default immediately
		const sensitivePatterns = [
			/\{[\s\S]*"[\w]+":[\s\S]*\}/, // JSON blobs
			/at\s+[\w.]+\s*\(.*:\d+:\d+\)/, // Stack trace lines
			/Error:\s*at\s+/i, // Stack trace headers
			/BEGIN\s+(RSA|PRIVATE|CERTIFICATE)/i, // Crypto keys
		];

		for (const pattern of sensitivePatterns) {
			if (pattern.test(sanitized)) {
				return DEFAULT_ERROR_MESSAGE;
			}
		}

		// Scrub patterns that might leak sensitive info
		const scrubPatterns: [RegExp, string][] = [
			// URLs (http, https, ftp, ws, wss)
			[/\b(https?|ftp|wss?):\/\/[^\s<>"{}|\\^`\[\]]+/gi, "[URL]"],
			// File system paths (Unix and Windows)
			[/\b(?:\/(?:[\w.-]+\/)+[\w.-]*|[A-Za-z]:\\(?:[\w.-]+\\)+[\w.-]*)/g, "[PATH]"],
			// Long hex strings (32+ chars, likely tokens/hashes)
			[/\b[0-9a-f]{32,}\b/gi, "[REDACTED]"],
			// API keys (common patterns)
			[/\b(?:api[_-]?key|token|secret|password|auth)[=:]\s*["']?[\w-]{8,}["']?/gi, "[REDACTED]"],
			// Bearer tokens
			[/\bBearer\s+[\w.-]+/gi, "[REDACTED]"],
			// UUID-like strings
			[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[ID]"],
			// Email addresses
			[/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/gi, "[EMAIL]"],
			// IP addresses
			[/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g, "[IP]"],
		];

		for (const [pattern, replacement] of scrubPatterns) {
			sanitized = sanitized.replace(pattern, replacement);
		}

		// Collapse multiple whitespace and trim
		sanitized = sanitized.replace(/\s+/g, " ").trim();

		// If message is now too short after scrubbing, use default
		if (sanitized.length < 5) {
			return DEFAULT_ERROR_MESSAGE;
		}

		// Truncate if too long
		if (sanitized.length > MAX_MESSAGE_LENGTH) {
			sanitized = `${sanitized.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
		}

		return sanitized;
	} catch {
		return DEFAULT_ERROR_MESSAGE;
	}
}

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
	onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
	hasError: boolean;
	error: Error | null;
	retryCount: number;
	remountKey: number;
}

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false, error: null, retryCount: 0, remountKey: 0 };
	}

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { hasError: true, error };
	}

	override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error("ErrorBoundary caught error:", error, errorInfo);
		this.props.onError?.(error, errorInfo);
	}

	private handleRetry = () => {
		if (this.state.retryCount < MAX_RETRIES) {
			this.setState((prevState) => ({
				hasError: false,
				error: null,
				retryCount: prevState.retryCount + 1,
				remountKey: prevState.remountKey + 1,
			}));
		}
	};

	private handleReload = () => {
		window.location.reload();
	};

	override render() {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

			const remainingAttempts = MAX_RETRIES - this.state.retryCount;
			const canRetry = remainingAttempts > 0;

			return (
				<Alert variant="danger">
					<AlertCircle className="h-4 w-4" />
					<AlertDescription>
						<div className="space-y-2">
							<p className="font-semibold">Something went wrong</p>
							<p className="text-sm text-muted-foreground">
								{sanitizeErrorMessage(this.state.error?.message)}
							</p>
							{canRetry ? (
								<div className="space-y-1">
									<button
										type="button"
										onClick={this.handleRetry}
										className="text-sm underline hover:no-underline"
										aria-label="Try again"
									>
										Try again
									</button>
									<p className="text-xs text-muted-foreground">
										{remainingAttempts} attempt{remainingAttempts !== 1 ? "s" : ""} remaining
									</p>
								</div>
							) : (
								<div className="space-y-1">
									<p className="text-xs text-muted-foreground">Maximum retry attempts reached.</p>
									<button
										type="button"
										onClick={this.handleReload}
										className="text-sm underline hover:no-underline"
										aria-label="Reload the page"
									>
										Reload page
									</button>
								</div>
							)}
						</div>
					</AlertDescription>
				</Alert>
			);
		}

		return <React.Fragment key={this.state.remountKey}>{this.props.children}</React.Fragment>;
	}
}
