import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface PageLayoutProps {
	children: ReactNode;
	maxWidth?: "4xl" | "6xl" | "7xl";
	className?: string;
}

/**
 * Standard page layout container
 *
 * Provides consistent max-width, padding, and spacing for all pages.
 * Eliminates layout class duplication across pages.
 *
 * @example
 * ```tsx
 * <PageLayout>
 *   <PageHeader title="Dashboard" description="View your downloads" />
 *   <Section>Content here</Section>
 * </PageLayout>
 * ```
 */
export const PageLayout = ({ children, maxWidth = "6xl", className }: PageLayoutProps) => {
	const maxWidthClass = maxWidth === "4xl" ? "max-w-4xl" : maxWidth === "7xl" ? "max-w-7xl" : "max-w-6xl";

	return (
		<main className={cn("mx-auto flex flex-col gap-12 px-6 py-16", maxWidthClass, className)}>
			{children}
		</main>
	);
};
