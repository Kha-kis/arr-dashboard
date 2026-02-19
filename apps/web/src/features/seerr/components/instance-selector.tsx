"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import { FilterSelect } from "../../../components/layout";

interface InstanceSelectorProps {
	instances: ServiceInstanceSummary[];
	selectedId: string;
	onSelect: (id: string) => void;
}

export const InstanceSelector = ({ instances, selectedId, onSelect }: InstanceSelectorProps) => (
	<FilterSelect
		value={selectedId}
		onChange={onSelect}
		options={instances.map((inst) => ({ value: inst.id, label: inst.label }))}
		className="min-w-[160px]"
	/>
);
