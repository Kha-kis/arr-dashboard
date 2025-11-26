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
		<header className={cn("flex items-start justify-between gap-4", className)}>
			<div className="space-y-2">
				<h1 className="text-3xl font-bold text-white">{title}</h1>
				{description && <p className="text-base text-white/70">{description}</p>}
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</header>
	);
};
