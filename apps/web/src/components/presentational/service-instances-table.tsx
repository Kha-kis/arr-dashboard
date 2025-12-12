/**
 * Service Instances Table - Presentational Component
 *
 * Displays configured service instances in a table format.
 * Shows label, service type, URL, tags, and enabled status.
 * Pure UI component with no business logic.
 */

import type { ServiceInstanceSummary } from "@arr/shared";
import { ExternalLink } from "lucide-react";
import { getLinuxUrl } from "../../lib/incognito";

interface ServiceInstancesTableProps {
	instances: ServiceInstanceSummary[];
	incognitoMode: boolean;
}

export const ServiceInstancesTable = ({ instances, incognitoMode }: ServiceInstancesTableProps) => {
	return (
		<div className="overflow-hidden rounded-xl border border-border bg-bg-subtle">
			<table className="min-w-full divide-y divide-border text-sm text-fg-muted">
				<thead className="bg-bg-hover text-left text-xs uppercase tracking-wide text-fg-muted">
					<tr>
						<th className="px-4 py-3">Label</th>
						<th className="px-4 py-3">Service</th>
						<th className="px-4 py-3">Base URL</th>
						<th className="px-4 py-3">Tags</th>
						<th className="px-4 py-3 text-center">Status</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-border/50">
					{instances.map((instance) => (
						<tr key={instance.id}>
							<td className="px-4 py-3 font-medium text-fg">
								<a
									href={instance.baseUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1.5 text-fg hover:text-sky-400 transition-colors"
									title={`Open ${instance.label} in new tab`}
								>
									{instance.label}
									<ExternalLink className="h-3 w-3 opacity-50" />
								</a>
							</td>
							<td className="px-4 py-3 capitalize">{instance.service}</td>
							<td className="px-4 py-3 text-fg-muted">
								{incognitoMode ? getLinuxUrl(instance.baseUrl) : instance.baseUrl}
							</td>
							<td className="px-4 py-3">
								{instance.tags.length === 0 ? (
									<span className="text-fg-muted/60">-</span>
								) : (
									<div className="flex flex-wrap gap-2">
										{instance.tags.map((tag) => (
											<span
												key={tag.id}
												className="rounded-full bg-bg-hover px-3 py-1 text-xs font-medium text-fg"
											>
												{tag.name}
											</span>
										))}
									</div>
								)}
							</td>
							<td className="px-4 py-3 text-center">
								<span
									className={`inline-flex items-center justify-center rounded-full px-3 py-1 text-xs font-semibold ${
										instance.enabled
											? "bg-emerald-500/20 text-emerald-200"
											: "bg-bg-hover text-fg-muted"
									}`}
								>
									{instance.enabled ? "Enabled" : "Disabled"}
								</span>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
};
