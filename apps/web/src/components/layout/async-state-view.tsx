"use client";

import { AlertTriangle, type LucideIcon, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import { cn } from "../../lib/utils";
import { PremiumEmptyState } from "./premium-containers";
import { SkeletonTable } from "../ui/skeleton";

const errorToMessage = (error: unknown, fallback: string): string => {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error.length > 0) return error;
	return fallback;
};

/* =============================================================================
   ASYNC STATE VIEW
   Standardized loading / error / empty / content presentation for data panels.

   Why this exists:
   - Data panels across the app each invented their own "spinner-or-nothing"
     loading UI, silently swallowed errors, and rendered ad-hoc empty messages.
   - This composer dispatches to existing primitives (PremiumSkeleton,
     PremiumEmptyState) and adds the missing piece — a themed error card with a
     retry button — so panels can opt into all four states with one wrapper.

   Order of precedence: error > loading > empty > content.
   Errors win even while loading so a stale failure isn't masked by a refetch.
   ============================================================================= */

export interface AsyncStateEmptyConfig {
	icon: LucideIcon;
	title: string;
	description?: string;
	action?: ReactNode;
}

export interface AsyncStateViewProps {
	/** Whether the underlying query is currently fetching (initial load). */
	isLoading?: boolean;
	/** Whether the underlying query failed. */
	isError?: boolean;
	/** The error from the failed query, if any. Rendered as the error description. */
	error?: unknown;
	/** Whether the loaded data is empty. Ignored while loading or in error. */
	isEmpty?: boolean;
	/** Optional retry handler. When provided and `isError` is true, a retry button is shown. */
	onRetry?: () => void;
	/** Optional override for the loading state. Defaults to a themed table skeleton. */
	loadingFallback?: ReactNode;
	/** Configuration for the empty state. */
	emptyState: AsyncStateEmptyConfig;
	/** Optional title for the error state. Defaults to "Couldn't load data". */
	errorTitle?: string;
	/** Optional override for the error description. Defaults to the error message. */
	errorDescription?: string;
	/** Content to render in the success state. */
	children: ReactNode;
	/** Optional className applied to the error / loading wrapper (not the content). */
	className?: string;
}

export const AsyncStateView = ({
	isLoading = false,
	isError = false,
	error,
	isEmpty = false,
	onRetry,
	loadingFallback,
	emptyState,
	errorTitle = "Couldn't load data",
	errorDescription,
	children,
	className,
}: AsyncStateViewProps) => {
	if (isError) {
		return (
			<AsyncErrorCard
				title={errorTitle}
				description={
					errorDescription ?? errorToMessage(error, "Something went wrong while loading.")
				}
				onRetry={onRetry}
				className={className}
			/>
		);
	}

	if (isLoading) {
		return (
			<div className={className} role="status" aria-live="polite" aria-busy="true">
				{loadingFallback ?? <SkeletonTable rows={4} columns={4} themed />}
				<span className="sr-only">Loading…</span>
			</div>
		);
	}

	if (isEmpty) {
		return (
			<PremiumEmptyState
				icon={emptyState.icon}
				title={emptyState.title}
				description={emptyState.description}
				action={emptyState.action}
				className={className}
			/>
		);
	}

	return <>{children}</>;
};

/* =============================================================================
   ASYNC ERROR CARD
   Themed inline error with retry. Exported so callers can render it standalone
   (e.g. on the side of a layout where AsyncStateView's other branches don't
   apply).
   ============================================================================= */

interface AsyncErrorCardProps {
	title: string;
	description: string;
	onRetry?: () => void;
	className?: string;
}

export const AsyncErrorCard = ({ title, description, onRetry, className }: AsyncErrorCardProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center py-12 px-6 text-center",
				"rounded-2xl border border-red-500/20 bg-red-500/[0.04]",
				className,
			)}
			role="alert"
		>
			<div
				className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
				style={{
					background: "linear-gradient(135deg, rgba(239,68,68,0.15), rgba(239,68,68,0.05))",
					border: "1px solid rgba(239,68,68,0.25)",
				}}
			>
				<AlertTriangle className="h-7 w-7 text-red-400" aria-hidden="true" />
			</div>
			<h3 className="text-base font-semibold mb-1">{title}</h3>
			<p className="text-sm text-muted-foreground max-w-md mb-5 break-words">{description}</p>
			{onRetry && (
				<button
					type="button"
					onClick={onRetry}
					className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
					}}
				>
					<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
					Try again
				</button>
			)}
		</div>
	);
};
