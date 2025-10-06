import { cn } from "../../../lib/utils";

export interface LibraryBadgeProps {
	children: React.ReactNode;
	tone: "green" | "blue" | "red" | "yellow";
}

/**
 * Colored badge component for library items
 * Used to display status, monitoring state, and other attributes
 */
export const LibraryBadge = ({ children, tone }: LibraryBadgeProps) => (
	<span
		className={cn(
			"inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
			tone === "green" &&
				"border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
			tone === "blue" && "border-sky-400/40 bg-sky-500/10 text-sky-200",
			tone === "red" && "border-red-400/40 bg-red-500/10 text-red-200",
			tone === "yellow" &&
				"border-yellow-400/40 bg-yellow-500/10 text-yellow-200",
		)}
	>
		{children}
	</span>
);
