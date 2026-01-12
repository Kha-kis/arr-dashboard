"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp, Filter, X, Check } from "lucide-react";
import { Button, Input, Switch, Badge } from "../../../components/ui";
import { PremiumSkeleton } from "../../../components/layout";
import { useFilterOptions } from "../hooks/useFilterOptions";
import type { HuntConfigWithInstance, HuntConfigUpdate } from "../lib/hunting-types";
import { cn } from "../../../lib/utils";

interface HuntingFiltersProps {
	config: HuntConfigWithInstance;
	formState: HuntConfigUpdate;
	onChange: (updates: HuntConfigUpdate) => void;
}

export const HuntingFilters = ({ config, formState, onChange }: HuntingFiltersProps) => {
	const [expanded, setExpanded] = useState(false);
	const { filterOptions, isLoading } = useFilterOptions(config.instanceId);

	// Parse stored JSON arrays into number/string arrays
	const parseJson = <T,>(value: string | null | undefined): T[] => {
		if (!value) return [];
		try {
			return JSON.parse(value) as T[];
		} catch {
			return [];
		}
	};

	// Get current values from formState or config
	const filterLogic = formState.filterLogic ?? config.filterLogic ?? "AND";
	const monitoredOnly = formState.monitoredOnly ?? config.monitoredOnly ?? true;
	const includeTags = parseJson<number>(formState.includeTags ?? config.includeTags);
	const excludeTags = parseJson<number>(formState.excludeTags ?? config.excludeTags);
	const includeQualityProfiles = parseJson<number>(formState.includeQualityProfiles ?? config.includeQualityProfiles);
	const excludeQualityProfiles = parseJson<number>(formState.excludeQualityProfiles ?? config.excludeQualityProfiles);
	const includeStatuses = parseJson<string>(formState.includeStatuses ?? config.includeStatuses);
	const yearMin = formState.yearMin ?? config.yearMin;
	const yearMax = formState.yearMax ?? config.yearMax;
	const ageThresholdDays = formState.ageThresholdDays ?? config.ageThresholdDays;

	// Check if any filters are active
	const hasActiveFilters =
		!monitoredOnly ||
		includeTags.length > 0 ||
		excludeTags.length > 0 ||
		includeQualityProfiles.length > 0 ||
		excludeQualityProfiles.length > 0 ||
		includeStatuses.length > 0 ||
		yearMin !== null ||
		yearMax !== null ||
		ageThresholdDays !== null;

	const updateJsonField = (field: keyof HuntConfigUpdate, values: (number | string)[]) => {
		onChange({ [field]: values.length > 0 ? JSON.stringify(values) : null });
	};

	const toggleArrayItem = <T extends number | string>(
		field: keyof HuntConfigUpdate,
		currentValues: T[],
		item: T
	) => {
		const newValues = currentValues.includes(item)
			? currentValues.filter(v => v !== item)
			: [...currentValues, item];
		updateJsonField(field, newValues as (number | string)[]);
	};

	return (
		<div className="border-t border-border pt-4">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="w-full flex items-center justify-between text-left"
			>
				<div className="flex items-center gap-2">
					<Filter className="h-4 w-4 text-muted-foreground" />
					<span className="font-medium text-foreground">Filters</span>
					{hasActiveFilters && (
						<Badge variant="info" size="sm">Active</Badge>
					)}
				</div>
				{expanded ? (
					<ChevronUp className="h-4 w-4 text-muted-foreground" />
				) : (
					<ChevronDown className="h-4 w-4 text-muted-foreground" />
				)}
			</button>

			{expanded && (
				<div className="mt-4 space-y-6">
					{isLoading ? (
						<div className="space-y-4">
							<PremiumSkeleton variant="line" className="h-8 w-full" style={{ animationDelay: "0ms" }} />
							<PremiumSkeleton variant="card" className="h-20" style={{ animationDelay: "50ms" }} />
							<PremiumSkeleton variant="card" className="h-20" style={{ animationDelay: "100ms" }} />
						</div>
					) : (
						<>
							{/* Filter Logic & Monitored */}
							<div className="grid grid-cols-2 gap-4">
								<div className="space-y-2">
									<label className="text-xs text-muted-foreground">Filter Logic</label>
									<div className="flex gap-2">
										<Button
											type="button"
											variant={filterLogic === "AND" ? "primary" : "secondary"}
											size="sm"
											onClick={() => onChange({ filterLogic: "AND" })}
										>
											AND
										</Button>
										<Button
											type="button"
											variant={filterLogic === "OR" ? "primary" : "secondary"}
											size="sm"
											onClick={() => onChange({ filterLogic: "OR" })}
										>
											OR
										</Button>
									</div>
									<p className="text-xs text-muted-foreground">
										{filterLogic === "AND" ? "All conditions must match" : "Any condition can match"}
									</p>
								</div>
								<div className="space-y-2">
									<label className="text-xs text-muted-foreground">Monitored Only</label>
									<div className="flex items-center gap-2">
										<Switch
											checked={monitoredOnly}
											onCheckedChange={(checked) => onChange({ monitoredOnly: checked })}
										/>
										<span className="text-sm text-foreground">
											{monitoredOnly ? "Yes" : "No"}
										</span>
									</div>
									<p className="text-xs text-muted-foreground">
										Only hunt monitored content
									</p>
								</div>
							</div>

							{/* Tags */}
							{filterOptions && filterOptions.tags.length > 0 && (
								<div className="space-y-3">
									<label className="text-xs text-muted-foreground">Tags</label>
									<div className="space-y-2">
										<div className="flex items-center gap-2 mb-1">
											<span className="text-xs text-green-500 font-medium">Include:</span>
											{includeTags.length === 0 && (
												<span className="text-xs text-muted-foreground">Any tag</span>
											)}
										</div>
										<div className="flex flex-wrap gap-1.5">
											{filterOptions.tags.map((tag) => (
												<TagButton
													key={tag.id}
													label={tag.label}
													selected={includeTags.includes(tag.id)}
													excluded={excludeTags.includes(tag.id)}
													onClick={() => {
														// Remove from exclude if adding to include
														if (excludeTags.includes(tag.id)) {
															updateJsonField("excludeTags", excludeTags.filter(id => id !== tag.id));
														}
														toggleArrayItem("includeTags", includeTags, tag.id);
													}}
													variant="include"
												/>
											))}
										</div>
										<div className="flex items-center gap-2 mb-1 mt-3">
											<span className="text-xs text-red-500 font-medium">Exclude:</span>
											{excludeTags.length === 0 && (
												<span className="text-xs text-muted-foreground">None</span>
											)}
										</div>
										<div className="flex flex-wrap gap-1.5">
											{filterOptions.tags.map((tag) => (
												<TagButton
													key={tag.id}
													label={tag.label}
													selected={excludeTags.includes(tag.id)}
													excluded={includeTags.includes(tag.id)}
													onClick={() => {
														// Remove from include if adding to exclude
														if (includeTags.includes(tag.id)) {
															updateJsonField("includeTags", includeTags.filter(id => id !== tag.id));
														}
														toggleArrayItem("excludeTags", excludeTags, tag.id);
													}}
													variant="exclude"
												/>
											))}
										</div>
									</div>
								</div>
							)}

							{/* Quality Profiles */}
							{filterOptions && filterOptions.qualityProfiles.length > 0 && (
								<div className="space-y-3">
									<label className="text-xs text-muted-foreground">Quality Profiles</label>
									<div className="space-y-2">
										<div className="flex items-center gap-2 mb-1">
											<span className="text-xs text-green-500 font-medium">Include:</span>
											{includeQualityProfiles.length === 0 && (
												<span className="text-xs text-muted-foreground">Any profile</span>
											)}
										</div>
										<div className="flex flex-wrap gap-1.5">
											{filterOptions.qualityProfiles.map((qp) => (
												<TagButton
													key={qp.id}
													label={qp.name}
													selected={includeQualityProfiles.includes(qp.id)}
													excluded={excludeQualityProfiles.includes(qp.id)}
													onClick={() => {
														if (excludeQualityProfiles.includes(qp.id)) {
															updateJsonField("excludeQualityProfiles", excludeQualityProfiles.filter(id => id !== qp.id));
														}
														toggleArrayItem("includeQualityProfiles", includeQualityProfiles, qp.id);
													}}
													variant="include"
												/>
											))}
										</div>
										<div className="flex items-center gap-2 mb-1 mt-3">
											<span className="text-xs text-red-500 font-medium">Exclude:</span>
											{excludeQualityProfiles.length === 0 && (
												<span className="text-xs text-muted-foreground">None</span>
											)}
										</div>
										<div className="flex flex-wrap gap-1.5">
											{filterOptions.qualityProfiles.map((qp) => (
												<TagButton
													key={qp.id}
													label={qp.name}
													selected={excludeQualityProfiles.includes(qp.id)}
													excluded={includeQualityProfiles.includes(qp.id)}
													onClick={() => {
														if (includeQualityProfiles.includes(qp.id)) {
															updateJsonField("includeQualityProfiles", includeQualityProfiles.filter(id => id !== qp.id));
														}
														toggleArrayItem("excludeQualityProfiles", excludeQualityProfiles, qp.id);
													}}
													variant="exclude"
												/>
											))}
										</div>
									</div>
								</div>
							)}

							{/* Status */}
							{filterOptions && filterOptions.statuses.length > 0 && (
								<div className="space-y-2">
									<label className="text-xs text-muted-foreground">Status</label>
									<div className="flex flex-wrap gap-1.5">
										{filterOptions.statuses.map((status) => (
											<TagButton
												key={status.value}
												label={status.label}
												selected={includeStatuses.includes(status.value)}
												onClick={() => toggleArrayItem("includeStatuses", includeStatuses, status.value)}
												variant="include"
											/>
										))}
									</div>
									{includeStatuses.length === 0 && (
										<p className="text-xs text-muted-foreground">Any status</p>
									)}
								</div>
							)}

							{/* Year Range */}
							<div className="space-y-2">
								<label className="text-xs text-muted-foreground">Year Range</label>
								<div className="grid grid-cols-2 gap-4">
									<div className="space-y-1">
										<label className="text-xs text-muted-foreground">From</label>
										<Input
											type="number"
											placeholder="Min"
											min={1900}
											max={2100}
											value={yearMin ?? ""}
											onChange={(e) => onChange({
												yearMin: e.target.value ? Number.parseInt(e.target.value) : null
											})}
										/>
									</div>
									<div className="space-y-1">
										<label className="text-xs text-muted-foreground">To</label>
										<Input
											type="number"
											placeholder="Max"
											min={1900}
											max={2100}
											value={yearMax ?? ""}
											onChange={(e) => onChange({
												yearMax: e.target.value ? Number.parseInt(e.target.value) : null
											})}
										/>
									</div>
								</div>
							</div>

							{/* Age Threshold */}
							<div className="space-y-2">
								<label className="text-xs text-muted-foreground">Age Threshold (Days)</label>
								<div className="flex items-center gap-2">
									<Input
										type="number"
										placeholder="No limit"
										min={0}
										max={365}
										value={ageThresholdDays ?? ""}
										onChange={(e) => onChange({
											ageThresholdDays: e.target.value ? Number.parseInt(e.target.value) : null
										})}
										className="w-32"
									/>
									<span className="text-sm text-muted-foreground">days old</span>
								</div>
								<p className="text-xs text-muted-foreground">
									Skip content released within this many days (wait for better releases)
								</p>
							</div>

							{/* Reset Filters */}
							{hasActiveFilters && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										onChange({
											filterLogic: "AND",
											monitoredOnly: true,
											includeTags: null,
											excludeTags: null,
											includeQualityProfiles: null,
											excludeQualityProfiles: null,
											includeStatuses: null,
											yearMin: null,
											yearMax: null,
											ageThresholdDays: null,
										});
									}}
								>
									<X className="h-4 w-4 mr-1" />
									Reset Filters
								</Button>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
};

interface TagButtonProps {
	label: string;
	selected: boolean;
	excluded?: boolean;
	onClick: () => void;
	variant: "include" | "exclude";
}

const TagButton = ({ label, selected, excluded, onClick, variant }: TagButtonProps) => {
	const isDisabled = excluded && !selected;

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={isDisabled}
			className={cn(
				"px-2.5 py-1 text-xs rounded-full border transition-all",
				"flex items-center gap-1",
				isDisabled && "opacity-40 cursor-not-allowed",
				!selected && !isDisabled && "border-border bg-card text-muted-foreground hover:border-muted-foreground",
				selected && variant === "include" && "border-green-500 bg-green-500/10 text-green-500",
				selected && variant === "exclude" && "border-red-500 bg-red-500/10 text-red-500",
			)}
		>
			{selected && (
				<Check className="h-3 w-3" />
			)}
			{label}
		</button>
	);
};
