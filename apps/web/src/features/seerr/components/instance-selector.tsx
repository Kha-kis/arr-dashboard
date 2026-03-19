"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { FilterSelect } from "../../../components/layout";
import { useSeerrHealth } from "../../../hooks/api/useSeerr";

interface InstanceSelectorProps {
	instances: ServiceInstanceSummary[];
	selectedId: string;
	onSelect: (id: string) => void;
}

/** Colored dot indicating Seerr instance health */
function HealthDot({ instanceId }: { instanceId: string }) {
	const { data: health } = useSeerrHealth(instanceId);

	const color =
		!health || health.status === "unknown"
			? "rgb(107 114 128)" // gray-500
			: health.status === "healthy"
				? SEMANTIC_COLORS.success.text
				: SEMANTIC_COLORS.error.text;

	const title =
		!health || health.status === "unknown"
			? "Health unknown"
			: health.status === "healthy"
				? "Healthy"
				: `Error: ${health.error ?? "Unknown"}`;

	return (
		<span
			className="inline-block h-2 w-2 rounded-full shrink-0"
			style={{ backgroundColor: color }}
			title={title}
		/>
	);
}

export const InstanceSelector = ({ instances, selectedId, onSelect }: InstanceSelectorProps) => (
	<div className="flex items-center gap-2">
		{instances.length > 0 && <HealthDot instanceId={selectedId} />}
		<FilterSelect
			value={selectedId}
			onChange={onSelect}
			options={instances.map((inst) => ({ value: inst.id, label: inst.label }))}
			className="min-w-[160px]"
		/>
	</div>
);
