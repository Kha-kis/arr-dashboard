"use client";

import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

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
