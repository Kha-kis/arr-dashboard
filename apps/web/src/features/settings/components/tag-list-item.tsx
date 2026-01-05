"use client";

import { Tag, X, Loader2 } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Props for the TagListItem component
 */
interface TagListItemProps {
	/** Tag ID */
	id: string;
	/** Tag name */
	name: string;
	/** Handler for remove button */
	onRemove: (id: string) => void;
	/** Whether deletion is pending */
	isPending: boolean;
	/** Animation delay for staggered entrance */
	animationDelay?: number;
}

/**
 * Premium Tag List Item
 *
 * Displays a tag with:
 * - Theme-aware styling
 * - Glassmorphic background
 * - Staggered entrance animation
 */
export const TagListItem = ({
	id,
	name,
	onRemove,
	isPending,
	animationDelay = 0,
}: TagListItemProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	return (
		<li
			className="group flex items-center justify-between rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm px-4 py-3 transition-all duration-300 hover:border-border/80 animate-in fade-in slide-in-from-bottom-2"
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			<div className="flex items-center gap-3">
				<div
					className="flex h-8 w-8 items-center justify-center rounded-lg"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}15)`,
						border: `1px solid ${themeGradient.from}20`,
					}}
				>
					<Tag className="h-4 w-4" style={{ color: themeGradient.from }} />
				</div>
				<span className="text-sm font-medium text-foreground">{name}</span>
			</div>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => onRemove(id)}
				disabled={isPending}
				className="gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
			>
				{isPending ? (
					<Loader2 className="h-3.5 w-3.5 animate-spin" />
				) : (
					<X className="h-3.5 w-3.5" />
				)}
				<span className="hidden sm:inline">Remove</span>
			</Button>
		</li>
	);
};
