"use client";

/**
 * Quality Breakdown - Presentational Component
 *
 * Displays quality distribution as horizontal progress bars.
 * Pure UI component with no business logic.
 */

import { THEME_GRADIENTS } from "../../lib/theme-gradients";
import { useColorTheme } from "../../providers/color-theme-provider";

const integer = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});

const qualityLabels: Record<string, string> = {
	uhd4k: "4K/UHD",
	fullHd1080p: "1080p",
	hd720p: "720p",
	sd: "SD",
	unknown: "Unknown",
};

const getQualityLabel = (key: string): string => qualityLabels[key] ?? key;

interface QualityBreakdownProps {
	breakdown?:
		| Record<string, number>
		| {
				uhd4k: number;
				fullHd1080p: number;
				hd720p: number;
				sd: number;
				unknown: number;
		  };
}

export const QualityBreakdown = ({ breakdown }: QualityBreakdownProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	if (!breakdown) return null;

	const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
	if (total === 0) return <p className="text-sm text-fg-muted">No quality data</p>;

	return (
		<div className="space-y-2">
			{Object.entries(breakdown).map(([key, count]) => {
				if (count === 0) return null;
				const percentage = (count / total) * 100;
				const labelId = `quality-label-${key}`;
				return (
					<div key={key} className="flex items-center gap-3">
						<div id={labelId} className="w-20 text-xs text-fg-muted">
							{getQualityLabel(key)}
						</div>
						<div className="flex-1">
							<div
								role="progressbar"
								aria-valuenow={Math.round(percentage)}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-labelledby={labelId}
								className="h-2 overflow-hidden rounded-full bg-bg-subtle"
							>
								<div className="h-full" style={{ width: `${percentage}%`, backgroundColor: themeGradient.fromMedium }} />
							</div>
						</div>
						<div className="w-16 text-right text-xs text-fg-muted">
							{integer.format(count)} ({percentFormatter.format(percentage)}%)
						</div>
					</div>
				);
			})}
		</div>
	);
};
