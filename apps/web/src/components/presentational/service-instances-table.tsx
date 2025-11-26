/**
 * Service Instances Table - Presentational Component
 *
 * Displays configured service instances in a table format.
 * Shows label, service type, URL, tags, and enabled status.
 * Pure UI component with no business logic.
 */

import type { ServiceInstanceSummary } from "@arr/shared";
import { getLinuxUrl } from "../../lib/incognito";

interface ServiceInstancesTableProps {
	instances: ServiceInstanceSummary[];
	incognitoMode: boolean;
}

export const ServiceInstancesTable = ({ instances, incognitoMode }: ServiceInstancesTableProps) => {
	return (
		<div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
			<table className="min-w-full divide-y divide-white/10 text-sm text-white/80">
				<thead className="bg-white/5 text-left text-xs uppercase tracking-wide text-white/60">
					<tr>
						<th className="px-4 py-3">Label</th>
						<th className="px-4 py-3">Service</th>
						<th className="px-4 py-3">Base URL</th>
						<th className="px-4 py-3">Tags</th>
						<th className="px-4 py-3 text-center">Status</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-white/5">
					{instances.map((instance) => (
						<tr key={instance.id}>
							<td className="px-4 py-3 font-medium text-white">{instance.label}</td>
							<td className="px-4 py-3 capitalize">{instance.service}</td>
							<td className="px-4 py-3 text-white/70">
								{incognitoMode ? getLinuxUrl(instance.baseUrl) : instance.baseUrl}
							</td>
							<td className="px-4 py-3">
								{instance.tags.length === 0 ? (
									<span className="text-white/40">-</span>
								) : (
									<div className="flex flex-wrap gap-2">
										{instance.tags.map((tag) => (
											<span
												key={tag.id}
												className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white"
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
											: "bg-white/10 text-white/50"
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
