"use client";

import { cn } from "../../lib/utils";
import { Card } from "./card";

interface StatCardProps {
	label: string;
	value: string | number;
	description?: string;
	className?: string;
	onClick?: () => void;
}

/**
 * Stat card for displaying metrics
 *
 * Consistent card component for showing key statistics.
 * Used in dashboard and other metric displays.
 *
 * @example
 * ```tsx
 * <StatCard
 *   label="Sonarr"
 *   value={5}
 *   description="Active instances configured."
 * />
 * ```
 */
export const StatCard = ({ label, value, description, className, onClick }: StatCardProps) => {
	const card = (
		<Card className={cn("p-6", className)}>
			<p className="text-sm uppercase tracking-wide text-muted-foreground">{label}</p>
			<p className="mt-2 text-3xl font-semibold text-foreground">{value}</p>
			{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
		</Card>
	);

	if (onClick) {
		return (
			<button type="button" onClick={onClick} className="w-full text-left">
				{card}
			</button>
		);
	}

	return card;
};
