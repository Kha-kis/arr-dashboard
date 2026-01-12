"use client";

import { useThemeGradient } from "../../../hooks/useThemeGradient";

/**
 * Premium Detail Stat Component
 *
 * Displays a single detail statistic with:
 * - Theme-aware styling
 * - Optional color override
 * - Compact label/value layout
 */
export const DetailStat = ({
	label,
	value,
	color,
}: {
	label: string;
	value?: string;
	color?: string;
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	if (!value || value.trim().length === 0) {
		return null;
	}

	return (
		<div className="space-y-1.5">
			<p className="text-xs uppercase tracking-wider font-medium text-muted-foreground">
				{label}
			</p>
			<p
				className="text-sm font-semibold"
				style={{ color: color || "inherit" }}
			>
				{value}
			</p>
		</div>
	);
};
