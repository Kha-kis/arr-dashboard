/**
 * Instance Table - Presentational Component
 *
 * Generic table for displaying service instance statistics.
 * Supports custom columns with formatters and incognito mode.
 * Pure UI component with no business logic.
 */

import { getLinuxInstanceName } from "../../lib/incognito";

const integer = new Intl.NumberFormat();

interface InstanceRow {
	instanceId: string;
	instanceName: string;
}

interface InstanceTableColumn<Row> {
	key: keyof Row;
	label: string;
	align?: "left" | "right";
	formatter?: (value: Row[keyof Row]) => string;
}

interface InstanceTableProps<Row extends InstanceRow> {
	rows: Row[];
	emptyMessage: string;
	columns: InstanceTableColumn<Row>[];
	incognitoMode: boolean;
}

export const InstanceTable = <Row extends InstanceRow>({
	rows,
	emptyMessage,
	columns,
	incognitoMode,
}: InstanceTableProps<Row>) => {
	if (rows.length === 0) {
		return (
			<div className="rounded-xl border border-border bg-bg-subtle px-4 py-6 text-center text-sm text-fg-muted">
				{emptyMessage}
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-xl border border-border bg-bg-subtle">
			<table className="min-w-full divide-y divide-border text-sm text-fg-muted">
				<thead className="bg-bg-hover text-left text-xs uppercase tracking-wide text-fg-muted">
					<tr>
						<th className="px-4 py-3">Instance</th>
						{columns.map((column) => (
							<th
								key={String(column.key)}
								className={`px-4 py-3 ${column.align === "left" ? "text-left" : "text-right"}`}
							>
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="divide-y divide-border/50">
					{rows.map((row) => (
						<tr key={row.instanceId} className="hover:bg-bg-hover">
							<td className="px-4 py-3 text-fg">
								{incognitoMode ? getLinuxInstanceName(row.instanceName) : row.instanceName}
							</td>
							{columns.map((column) => {
								const raw = row[column.key];
								const formatted = column.formatter
									? column.formatter(raw)
									: typeof raw === "number"
										? integer.format(raw)
										: String(raw ?? "-");
								return (
									<td
										key={String(column.key)}
										className={`px-4 py-3 text-fg-muted ${column.align === "left" ? "text-left" : "text-right"}`}
									>
										{formatted}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
};
