/**
 * Error Boundary Component
 * Catches React errors and displays fallback UI
 */

"use client";

import React, { Component, type ReactNode } from "react";
import { Alert, AlertDescription } from "./ui";
import { AlertCircle } from "lucide-react";

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
	onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error("ErrorBoundary caught error:", error, errorInfo);
		this.props.onError?.(error, errorInfo);
	}

	override render() {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

			return (
				<Alert variant="danger">
					<AlertCircle className="h-4 w-4" />
					<AlertDescription>
						<div className="space-y-2">
							<p className="font-semibold">Something went wrong</p>
							<p className="text-sm text-muted-foreground">
								{this.state.error?.message || "An unexpected error occurred"}
							</p>
							<button
								type="button"
								onClick={() => this.setState({ hasError: false, error: null })}
								className="text-sm underline hover:no-underline"
							>
								Try again
							</button>
						</div>
					</AlertDescription>
				</Alert>
			);
		}

		return this.props.children;
	}
}
