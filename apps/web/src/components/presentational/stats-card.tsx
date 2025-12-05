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
	<div className="rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm text-fg-muted">
		<p className="text-xs uppercase text-fg-muted">{title}</p>
		<p className="text-2xl font-semibold text-fg">
			{typeof value === "number" ? integer.format(value) : value}
		</p>
		{description ? <p className="text-xs text-fg-muted">{description}</p> : null}
	</div>
);
