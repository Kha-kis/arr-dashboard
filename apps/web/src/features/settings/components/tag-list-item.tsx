"use client";

import { Loader2, Tag, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

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
	const { gradient: themeGradient } = useThemeGradient();
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	useEffect(() => {
		if (!confirmingDelete) return;
		const timer = setTimeout(() => setConfirmingDelete(false), 3000);
		return () => clearTimeout(timer);
	}, [confirmingDelete]);

	const handleRemove = () => {
		if (confirmingDelete) {
			onRemove(id);
			setConfirmingDelete(false);
		} else {
			setConfirmingDelete(true);
		}
	};

	return (
		<li
			className="group flex items-center justify-between rounded-xl border border-border/30 bg-muted/10 px-4 py-3 transition-all duration-300 hover:border-border/80 animate-in fade-in slide-in-from-bottom-2"
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
				onClick={handleRemove}
				disabled={isPending}
				aria-label={confirmingDelete ? `Confirm remove ${name}` : `Remove ${name}`}
				className={`gap-1.5 transition-opacity ${
					confirmingDelete
						? "opacity-100 text-red-400"
						: "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
				}`}
			>
				{isPending ? (
					<Loader2 className="h-3.5 w-3.5 animate-spin" />
				) : confirmingDelete ? (
					<span className="text-xs font-medium">Confirm?</span>
				) : (
					<X className="h-3.5 w-3.5" />
				)}
				{!confirmingDelete && <span className="hidden sm:inline">Remove</span>}
			</Button>
		</li>
	);
};
