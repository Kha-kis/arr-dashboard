/**
 * Stats Card - Presentational Component
 *
 * Displays a single statistic with optional description.
 * Pure UI component with no business logic.
 */

const integer = new Intl.NumberFormat();

interface StatsCardProps {
	title: string;
	value: string | number;
	description?: string;
}

export const StatsCard = ({ title, value, description }: StatsCardProps) => (
	<div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80">
		<p className="text-xs uppercase text-white/50">{title}</p>
		<p className="text-2xl font-semibold text-white">
			{typeof value === "number" ? integer.format(value) : value}
		</p>
		{description ? <p className="text-xs text-white/50">{description}</p> : null}
	</div>
);
