import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface PageHeaderProps {
	title: string;
	description?: string;
	actions?: ReactNode;
	className?: string;
}

/**
 * Standard page header component
 *
 * Displays page title, optional description, and optional action buttons.
 * Use at the top of every page for consistent hierarchy.
 *
 * @example
 * ```tsx
 * <PageHeader
 *   title="Settings"
 *   description="Manage your services and preferences"
 *   actions={<Button variant="primary">Add Service</Button>}
 * />
 * ```
 */
export const PageHeader = ({ title, description, actions, className }: PageHeaderProps) => {
	return (
		<header
			className={cn(
				"flex flex-col gap-4 border-b border-border/60 pb-5 sm:flex-row sm:items-start sm:justify-between",
				className,
			)}
		>
			<div className="min-w-0 space-y-1">
				<h1 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
					{title}
				</h1>
				{description && (
					<p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
						{description}
					</p>
				)}
			</div>
			{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
		</header>
	);
};
