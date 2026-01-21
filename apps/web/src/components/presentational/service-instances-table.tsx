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
		<div className="overflow-hidden rounded-xl border border-border bg-card">
			<table className="min-w-full divide-y divide-border text-sm text-muted-foreground">
				<thead className="bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
					<tr>
						<th className="px-4 py-3">Label</th>
						<th className="px-4 py-3">Service</th>
						<th className="px-4 py-3">Base URL</th>
						<th className="px-4 py-3">Tags</th>
						<th className="px-4 py-3 text-center">Status</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-border/50">
					{instances.map((instance) => {
						// Use externalUrl for browser navigation if available, otherwise fall back to baseUrl
						const linkUrl = instance.externalUrl || instance.baseUrl;
						return (
						<tr key={instance.id}>
							<td className="px-4 py-3 font-medium text-foreground">
								<a
									href={linkUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1.5 text-foreground hover:text-sky-400 transition-colors"
									title={`Open ${instance.label} in new tab`}
								>
									{instance.label}
									<ExternalLink className="h-3 w-3 opacity-50" />
								</a>
							</td>
							<td className="px-4 py-3 capitalize">{instance.service}</td>
							<td className="px-4 py-3 text-muted-foreground">
								{incognitoMode ? getLinuxUrl(linkUrl) : linkUrl}
							</td>
							<td className="px-4 py-3">
								{instance.tags.length === 0 ? (
									<span className="text-muted-foreground/60">-</span>
								) : (
									<div className="flex flex-wrap gap-2">
										{instance.tags.map((tag) => (
											<span
												key={tag.id}
												className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground"
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
											: "bg-muted text-muted-foreground"
									}`}
								>
									{instance.enabled ? "Enabled" : "Disabled"}
								</span>
							</td>
						</tr>
					);
					})}
				</tbody>
			</table>
		</div>
	);
};
