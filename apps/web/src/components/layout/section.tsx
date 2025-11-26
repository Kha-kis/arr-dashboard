import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface SectionProps {
	title?: string;
	description?: string;
	children: ReactNode;
	className?: string;
}

/**
 * Standard section component with consistent spacing
 *
 * Provides uniform section spacing and optional header.
 * Use for major page sections (not small groups of related items).
 *
 * @example
 * ```tsx
 * <Section title="Downloads" description="Manage your queue">
 *   <QueueTable />
 * </Section>
 * ```
 */
export const Section = ({ title, description, children, className }: SectionProps) => {
	return (
		<section className={cn("space-y-6", className)}>
			{(title || description) && (
				<header className="space-y-2">
					{title && <h2 className="text-2xl font-bold text-white">{title}</h2>}
					{description && <p className="text-sm text-white/60">{description}</p>}
				</header>
			)}
			{children}
		</section>
	);
};
