import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface PageLayoutProps {
	children: ReactNode;
	/** Maximum width constraint for the content */
	maxWidth?: "4xl" | "6xl" | "7xl";
	/** Vertical spacing between child elements (default: 8 = 32px) */
	gap?: "6" | "8" | "10" | "12";
	/** Additional CSS classes */
	className?: string;
}

const MAX_WIDTH_CLASSES = {
	"4xl": "max-w-4xl",
	"6xl": "max-w-6xl",
	"7xl": "max-w-7xl",
} as const;

const GAP_CLASSES = {
	"6": "gap-6",
	"8": "gap-8",
	"10": "gap-10",
	"12": "gap-12",
} as const;

/**
 * Standard page layout container
 *
 * Provides consistent structure for all pages:
 * - Semantic <main> element for accessibility
 * - Configurable max-width (default: 6xl = 1152px)
 * - Configurable vertical spacing (default: gap-8 = 32px)
 * - Consistent horizontal padding and vertical margins
 *
 * @example
 * ```tsx
 * // Standard page
 * <PageLayout>
 *   <PageHeader title="Dashboard" />
 *   <DashboardContent />
 * </PageLayout>
 *
 * // Wider page with tighter spacing
 * <PageLayout maxWidth="7xl" gap="6">
 *   <LibraryGrid />
 * </PageLayout>
 * ```
 */
export const PageLayout = ({
	children,
	maxWidth = "6xl",
	gap = "8",
	className,
}: PageLayoutProps) => {
	return (
		<main
			className={cn(
				"mx-auto flex flex-col px-6 py-16",
				MAX_WIDTH_CLASSES[maxWidth],
				GAP_CLASSES[gap],
				className
			)}
		>
			{children}
		</main>
	);
};
