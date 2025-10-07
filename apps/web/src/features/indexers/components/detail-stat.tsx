"use client";

/**
 * Component for displaying a single detail statistic
 * @param label - Label text for the statistic
 * @param value - Value to display (optional)
 * @returns React component or null if no value
 */
export const DetailStat = ({
	label,
	value,
}: {
	label: string;
	value?: string;
}) => {
	if (!value || value.trim().length === 0) {
		return null;
	}
	return (
		<div className="space-y-1">
			<p className="text-xs uppercase tracking-wider text-white/40">{label}</p>
			<p className="text-sm font-medium text-white">{value}</p>
		</div>
	);
};
