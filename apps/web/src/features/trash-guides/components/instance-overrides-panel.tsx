"use client";

import { useState, useMemo } from "react";
import type { CustomQualityConfig, TrashTemplate, TemplateInstanceOverride } from "@arr/shared";
import { Button } from "../../../components/ui";
import {
	Server,
	Sliders,
	ChevronDown,
	ChevronUp,
	Settings2,
	Check,
	RotateCcw,
	AlertTriangle,
	Target,
	Layers,
	Info,
} from "lucide-react";
import { InstanceQualityOverrideModal } from "./instance-quality-override-modal";
import { getEffectiveQualityConfig } from "../lib/quality-config-utils";
import { cn } from "../../../lib/utils";

interface ServiceInstance {
	id: string;
	label: string;
	service: string;
}

interface InstanceOverridesPanelProps {
	template: TrashTemplate;
	instances: ServiceInstance[];
	onOverrideChanged?: () => void;
}

interface InstanceOverrideStatus {
	instanceId: string;
	instanceLabel: string;
	hasQualityOverride: boolean;
	qualityOverride?: CustomQualityConfig;
	lastModifiedAt?: string;
}

/**
 * Panel displaying all instances and their quality override status for a template.
 * Allows quick management of per-instance quality configuration.
 */
export const InstanceOverridesPanel = ({
	template,
	instances,
	onOverrideChanged,
}: InstanceOverridesPanelProps) => {
	const [isExpanded, setIsExpanded] = useState(false);
	const [editingInstance, setEditingInstance] = useState<ServiceInstance | null>(null);

	// Parse instance overrides from template
	const instanceOverrides = useMemo((): Record<string, TemplateInstanceOverride> => {
		if (!template.instanceOverrides) return {};
		if (typeof template.instanceOverrides === "string") {
			try {
				return JSON.parse(template.instanceOverrides);
			} catch {
				return {};
			}
		}
		return template.instanceOverrides;
	}, [template.instanceOverrides]);

	// Build override status for each relevant instance
	const overrideStatuses = useMemo((): InstanceOverrideStatus[] => {
		// Filter instances to only those matching the template's service type
		const matchingInstances = instances.filter(
			(inst) => inst.service.toUpperCase() === template.serviceType.toUpperCase()
		);

		return matchingInstances.map((inst) => {
			const override = instanceOverrides[inst.id];
			return {
				instanceId: inst.id,
				instanceLabel: inst.label,
				hasQualityOverride: !!override?.qualityConfigOverride,
				qualityOverride: override?.qualityConfigOverride,
				lastModifiedAt: override?.lastModifiedAt,
			};
		});
	}, [instances, instanceOverrides, template.serviceType]);

	// Count instances with overrides
	const overrideCount = overrideStatuses.filter((s) => s.hasQualityOverride).length;

	// Get template's default quality config (from customQualityConfig or qualityProfile)
	const templateDefaultConfig = useMemo((): CustomQualityConfig | undefined => {
		const config = template.config;
		if (typeof config === "string") {
			try {
				return getEffectiveQualityConfig(JSON.parse(config));
			} catch {
				return undefined;
			}
		}
		return getEffectiveQualityConfig(config);
	}, [template.config]);

	// Get cutoff name from quality config
	const getCutoffName = (qualityConfig?: CustomQualityConfig): string | null => {
		if (!qualityConfig?.cutoffId || !qualityConfig.items) return null;
		const cutoffItem = qualityConfig.items.find(
			(e) => (e.type === "quality" ? e.item.id : e.group.id) === qualityConfig.cutoffId
		);
		if (!cutoffItem) return null;
		return cutoffItem.type === "quality" ? cutoffItem.item.name : cutoffItem.group.name;
	};

	// Don't render if no matching instances
	if (overrideStatuses.length === 0) {
		return null;
	}

	return (
		<>
			<div className="rounded-lg border border-border bg-bg-subtle/30">
				{/* Header */}
				<button
					type="button"
					onClick={() => setIsExpanded(!isExpanded)}
					className="flex items-center justify-between w-full p-4 text-left hover:bg-bg-subtle/50 transition rounded-lg"
				>
					<div className="flex items-center gap-3">
						<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-500/10">
							<Sliders className="h-5 w-5 text-purple-500" />
						</div>
						<div>
							<h3 className="text-sm font-medium text-fg">Instance Quality Overrides</h3>
							<p className="text-xs text-fg-muted">
								{overrideCount === 0 ? (
									"All instances use template default"
								) : (
									<>
										<span className="text-purple-600 dark:text-purple-400">
											{overrideCount} instance{overrideCount !== 1 ? "s" : ""}
										</span>
										{" "}with custom quality config
									</>
								)}
							</p>
						</div>
					</div>
					<div className="flex items-center gap-2">
						<span className="text-xs text-fg-muted">
							{overrideStatuses.length} instance{overrideStatuses.length !== 1 ? "s" : ""}
						</span>
						{isExpanded ? (
							<ChevronUp className="h-4 w-4 text-fg-muted" />
						) : (
							<ChevronDown className="h-4 w-4 text-fg-muted" />
						)}
					</div>
				</button>

				{/* Expanded content */}
				{isExpanded && (
					<div className="border-t border-border p-4 space-y-4">
						{/* Info about template default */}
						{templateDefaultConfig?.useCustomQualities && (
							<div className="flex items-start gap-3 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
								<Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
								<div className="text-xs text-fg-muted">
									<span className="font-medium text-fg">Template Default:</span>{" "}
									{templateDefaultConfig.items.length} quality items
									{getCutoffName(templateDefaultConfig) && (
										<>
											{" "}• Cutoff: <span className="text-primary">{getCutoffName(templateDefaultConfig)}</span>
										</>
									)}
								</div>
							</div>
						)}

						{/* Instance list */}
						<div className="space-y-2">
							{overrideStatuses.map((status) => (
								<div
									key={status.instanceId}
									className={cn(
										"flex items-center justify-between gap-3 rounded-lg border p-3 transition",
										status.hasQualityOverride
											? "border-purple-500/30 bg-purple-500/5"
											: "border-border bg-bg"
									)}
								>
									<div className="flex items-center gap-3 min-w-0">
										<Server className="h-4 w-4 text-fg-muted shrink-0" />
										<div className="min-w-0">
											<div className="text-sm font-medium text-fg truncate">
												{status.instanceLabel}
											</div>
											{status.hasQualityOverride && status.qualityOverride ? (
												<div className="flex items-center gap-2 text-xs text-fg-muted">
													<span className="flex items-center gap-1">
														<Layers className="h-3 w-3" />
														{status.qualityOverride.items?.length ?? 0} items
													</span>
													{getCutoffName(status.qualityOverride) && (
														<span className="flex items-center gap-1">
															<Target className="h-3 w-3" />
															{getCutoffName(status.qualityOverride)}
														</span>
													)}
												</div>
											) : (
												<div className="text-xs text-fg-muted flex items-center gap-1">
													<Check className="h-3 w-3 text-green-500" />
													Using template default
												</div>
											)}
										</div>
									</div>

									<div className="flex items-center gap-2 shrink-0">
										{status.hasQualityOverride && (
											<span className="flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
												<Sliders className="h-3 w-3" />
												Override
											</span>
										)}
										<Button
											variant="ghost"
											size="sm"
											onClick={() => {
												const inst = instances.find((i) => i.id === status.instanceId);
												if (inst) setEditingInstance(inst);
											}}
											className="gap-1"
										>
											<Settings2 className="h-3 w-3" />
											{status.hasQualityOverride ? "Edit" : "Customize"}
										</Button>
									</div>
								</div>
							))}
						</div>

						{/* Summary footer */}
						{overrideCount > 0 && (
							<div className="flex items-center justify-between pt-2 border-t border-border">
								<div className="flex items-center gap-2 text-xs text-fg-muted">
									<AlertTriangle className="h-3 w-3 text-amber-500" />
									<span>
										Instances with overrides won&apos;t receive template quality updates
									</span>
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Edit modal */}
			{editingInstance && (
				<InstanceQualityOverrideModal
					open={true}
					onClose={() => setEditingInstance(null)}
					templateId={template.id}
					templateName={template.name}
					instanceId={editingInstance.id}
					instanceLabel={editingInstance.label}
					serviceType={template.serviceType as "RADARR" | "SONARR"}
					templateDefaultConfig={templateDefaultConfig}
					onSaved={() => {
						setEditingInstance(null);
						onOverrideChanged?.();
					}}
				/>
			)}
		</>
	);
};
