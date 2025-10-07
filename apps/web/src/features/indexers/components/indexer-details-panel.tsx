"use client";

import { useEffect, useState } from "react";
import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import { useIndexerDetailsQuery } from "../../../hooks/api/useSearch";
import { Button } from "../../../components/ui/button";
import { Alert, AlertDescription, Skeleton } from "../../../components/ui";
import { IndexerDetailsInfo } from "./indexer-details-info";
import { IndexerEditForm } from "./indexer-edit-form";
import { IndexerConfigurationFields } from "./indexer-configuration-fields";

/**
 * Panel displaying detailed information about an indexer with edit capabilities
 * @param instanceId - Prowlarr instance ID
 * @param indexer - Base indexer object
 * @param expanded - Whether the panel is expanded
 * @param onUpdate - Callback to update indexer details
 * @returns React component or null if not expanded
 */
export const IndexerDetailsPanel = ({
	instanceId,
	indexer,
	expanded,
	onUpdate,
}: {
	instanceId: string;
	indexer: ProwlarrIndexer;
	expanded: boolean;
	onUpdate: (
		instanceId: string,
		indexerId: number,
		payload: ProwlarrIndexerDetails,
	) => Promise<ProwlarrIndexerDetails>;
}) => {
	const { data, isLoading, error, refetch, isFetching } = useIndexerDetailsQuery(
		expanded ? instanceId : null,
		expanded ? indexer.id : null,
		expanded,
	);

	const detail = data ?? {
		id: indexer.id,
		name: indexer.name,
		instanceId,
		instanceName: indexer.instanceName ?? indexer.instanceId ?? "",
		instanceUrl: indexer.instanceUrl,
		enable: indexer.enable,
		priority: indexer.priority,
		tags: indexer.tags,
		protocol: indexer.protocol,
		capabilities: indexer.capabilities,
	};

	const initialEnable = detail.enable ?? indexer.enable ?? false;
	const initialPriority = detail.priority ?? indexer.priority ?? 0;

	const [isEditing, setIsEditing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [formEnable, setFormEnable] = useState(initialEnable);
	const [formPriority, setFormPriority] = useState<number | undefined>(
		initialPriority ?? undefined,
	);

	useEffect(() => {
		if (!expanded) {
			setIsEditing(false);
			setLocalError(null);
			setFormEnable(initialEnable);
			setFormPriority(initialPriority ?? undefined);
			return;
		}

		setFormEnable(initialEnable);
		setFormPriority(initialPriority ?? undefined);
		setLocalError(null);
	}, [expanded, initialEnable, initialPriority]);

	if (!expanded) {
		return null;
	}

	const detailError =
		error instanceof Error ? error.message : error ? "Unable to load indexer settings." : null;
	const isLoadingState = isLoading && !detail.fields && !detail.stats;

	const handleStartEditing = () => {
		setFormEnable(initialEnable);
		setFormPriority(initialPriority ?? undefined);
		setIsEditing(true);
		setLocalError(null);
	};

	const handleCancelEditing = () => {
		setFormEnable(initialEnable);
		setFormPriority(initialPriority ?? undefined);
		setIsEditing(false);
		setLocalError(null);
	};

	const handleSaveChanges = async () => {
		setIsSaving(true);
		setLocalError(null);

		const payload: ProwlarrIndexerDetails = {
			...detail,
			id: detail.id ?? indexer.id,
			instanceId: detail.instanceId ?? instanceId,
			instanceName: detail.instanceName ?? indexer.instanceName ?? "",
			instanceUrl: detail.instanceUrl ?? indexer.instanceUrl,
			enable: formEnable,
			priority: formPriority ?? detail.priority ?? undefined,
			fields: detail.fields ?? [],
		};

		try {
			await onUpdate(instanceId, indexer.id, payload);
			setIsEditing(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to update indexer";
			setLocalError(message);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div className="space-y-6 rounded-lg border border-white/10 bg-slate-950/80 p-4">
			{isLoadingState ? (
				<div className="flex items-center gap-2 text-sm text-white/60">
					<Skeleton className="h-4 w-4 rounded-full" />
					Loading indexer settings…
				</div>
			) : detailError ? (
				<Alert variant="danger">
					<AlertDescription>
						<div className="flex flex-col gap-3">
							<span>{detailError}</span>
							<div>
								<Button variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
									{isFetching ? "Retrying…" : "Retry"}
								</Button>
							</div>
						</div>
					</AlertDescription>
				</Alert>
			) : (
				<>
					<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
						<IndexerDetailsInfo detail={detail} indexer={indexer} />
						<div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
							<div className="flex flex-wrap items-center gap-2">
								<Button variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
									{isFetching ? "Refreshing…" : "Refresh details"}
								</Button>
								{isEditing ? (
									<>
										<Button variant="ghost" onClick={handleCancelEditing} disabled={isSaving}>
											Cancel
										</Button>
										<Button onClick={handleSaveChanges} disabled={isSaving}>
											{isSaving ? "Saving…" : "Save changes"}
										</Button>
									</>
								) : (
									<Button variant="secondary" onClick={handleStartEditing}>
										Edit
									</Button>
								)}
							</div>
							{localError ? <p className="text-sm text-red-300">{localError}</p> : null}
						</div>
					</div>

					{isEditing ? (
						<IndexerEditForm
							formEnable={formEnable}
							formPriority={formPriority}
							onEnableChange={setFormEnable}
							onPriorityChange={setFormPriority}
						/>
					) : (
						<p className="text-xs text-white/40">
							Advanced configuration remains read-only here. Use the Prowlarr interface for
							additional changes.
						</p>
					)}

					{detail.fields && detail.fields.length > 0 ? (
						<IndexerConfigurationFields fields={detail.fields} />
					) : null}
				</>
			)}
		</div>
	);
};
