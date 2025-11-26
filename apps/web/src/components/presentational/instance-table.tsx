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
			<div className="rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-white/60">
				{emptyMessage}
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
			<table className="min-w-full divide-y divide-white/10 text-sm text-white/80">
				<thead className="bg-white/5 text-left text-xs uppercase tracking-wide text-white/60">
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
				<tbody className="divide-y divide-white/5">
					{rows.map((row) => (
						<tr key={row.instanceId} className="hover:bg-white/10">
							<td className="px-4 py-3 text-white">
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
										className={`px-4 py-3 text-white/70 ${column.align === "left" ? "text-left" : "text-right"}`}
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
