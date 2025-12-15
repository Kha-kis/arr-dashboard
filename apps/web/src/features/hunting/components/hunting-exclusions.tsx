"use client";

import { useState } from "react";
import {
	Button,
	Badge,
	EmptyState,
	Select,
	SelectOption,
	Pagination,
	Alert,
	AlertDescription,
} from "../../../components/ui";
import { Section } from "../../../components/layout";
import { Ban, Trash2, Film, Tv, RotateCcw } from "lucide-react";
import { useHuntingExclusions, useRemoveExclusion } from "../hooks/useHuntingExclusions";
import type { HuntExclusion } from "../lib/hunting-types";

export const HuntingExclusions = () => {
	const [typeFilter, setTypeFilter] = useState<string>("all");
	const [instanceFilter, setInstanceFilter] = useState<string>("all");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(20);

	const { exclusions, instances, totalCount, isLoading, error, refetch } = useHuntingExclusions({
		mediaType: typeFilter === "all" ? undefined : typeFilter,
		instanceId: instanceFilter === "all" ? undefined : instanceFilter,
		page,
		pageSize,
	});

	if (isLoading) {
		return (
			<Section title="Hunt Exclusions">
				<div className="space-y-4">
					{Array.from({ length: 5 }).map((_, i) => (
						<div key={i} className="h-16 bg-bg-subtle animate-pulse rounded-lg" />
					))}
				</div>
			</Section>
		);
	}

	if (error) {
		return (
			<EmptyState
				icon={Ban}
				title="Failed to load exclusions"
				description="Could not fetch hunt exclusions. Please try again."
			/>
		);
	}

	return (
		<Section
			title="Hunt Exclusions"
			description="Content excluded from automated hunting"
		>
			{/* Filters */}
			<div className="flex flex-wrap gap-4 mb-6">
				<Select
					value={typeFilter}
					onChange={(e) => {
						setTypeFilter(e.target.value);
						setPage(1);
					}}
				>
					<SelectOption value="all">All Types</SelectOption>
					<SelectOption value="series">Series</SelectOption>
					<SelectOption value="movie">Movies</SelectOption>
				</Select>

				<Select
					value={instanceFilter}
					onChange={(e) => {
						setInstanceFilter(e.target.value);
						setPage(1);
					}}
				>
					<SelectOption value="all">All Instances</SelectOption>
					{instances.map((inst) => (
						<SelectOption key={inst.id} value={inst.id}>
							{inst.label}
						</SelectOption>
					))}
				</Select>
			</div>

			{exclusions.length === 0 ? (
				<EmptyState
					icon={Ban}
					title="No exclusions"
					description="Content can be excluded from hunting via the Library or when items are repeatedly not found."
				/>
			) : (
				<>
					<div className="space-y-2">
						{exclusions.map((exclusion) => (
							<ExclusionRow key={exclusion.id} exclusion={exclusion} onRemoved={refetch} />
						))}
					</div>

					{totalCount > pageSize && (
						<div className="mt-6">
							<Pagination
								currentPage={page}
								totalItems={totalCount}
								pageSize={pageSize}
								onPageChange={setPage}
								onPageSizeChange={setPageSize}
							/>
						</div>
					)}
				</>
			)}
		</Section>
	);
};

interface ExclusionRowProps {
	exclusion: HuntExclusion;
	onRemoved: () => void;
}

const ExclusionRow = ({ exclusion, onRemoved }: ExclusionRowProps) => {
	const { removeExclusion, isRemoving, error } = useRemoveExclusion();
	const Icon = exclusion.mediaType === "series" ? Tv : Film;

	const handleRemove = async () => {
		await removeExclusion(exclusion.id);
		onRemoved();
	};

	return (
		<div className="flex items-center justify-between px-4 py-3 rounded-lg border border-border bg-bg-subtle/30 hover:bg-bg-subtle/50 transition">
			<div className="flex items-center gap-3">
				<Icon className="h-5 w-5 text-fg-muted" />
				<div>
					<div className="flex items-center gap-2">
						<span className="font-medium text-fg">{exclusion.title}</span>
						<Badge variant="default" className="text-xs">
							{exclusion.mediaType}
						</Badge>
						<Badge variant="info" className="text-xs">
							{exclusion.instanceName}
						</Badge>
					</div>
					{exclusion.reason && (
						<p className="text-xs text-fg-muted mt-0.5">{exclusion.reason}</p>
					)}
				</div>
			</div>

			<div className="flex items-center gap-2">
				<span className="text-xs text-fg-muted">
					{new Date(exclusion.createdAt).toLocaleDateString()}
				</span>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => void handleRemove()}
					disabled={isRemoving}
					title="Remove exclusion"
				>
					{isRemoving ? (
						<RotateCcw className="h-4 w-4 animate-spin" />
					) : (
						<Trash2 className="h-4 w-4 text-danger" />
					)}
				</Button>
			</div>

			{error && (
				<Alert variant="danger" className="mt-2">
					<AlertDescription>{error.message}</AlertDescription>
				</Alert>
			)}
		</div>
	);
};
