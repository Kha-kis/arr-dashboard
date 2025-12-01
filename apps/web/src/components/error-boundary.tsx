/**
 * Error Boundary Component
 * Catches React errors and displays fallback UI
 */

"use client";

import React, { Component, type ReactNode } from "react";
import { Alert, AlertDescription } from "./ui";
import { AlertCircle } from "lucide-react";

const MAX_RETRIES = 3;

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
								{this.state.error?.message || "An unexpected error occurred"}
							</p>
							{canRetry ? (
								<div className="space-y-1">
									<button
										type="button"
										onClick={this.handleRetry}
										className="text-sm underline hover:no-underline"
									>
										Try again
									</button>
									<p className="text-xs text-muted-foreground">
										{remainingAttempts} attempt{remainingAttempts !== 1 ? "s" : ""} remaining
									</p>
								</div>
							) : (
								<div className="space-y-1">
									<p className="text-xs text-muted-foreground">
										Maximum retry attempts reached.
									</p>
									<button
										type="button"
										onClick={this.handleReload}
										className="text-sm underline hover:no-underline"
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
