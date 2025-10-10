"use client";

import { useMemo, useState } from "react";
import type { ProwlarrIndexerDetails } from "@arr/shared";
import {
	useSearchIndexersQuery,
	useTestIndexerMutation,
	useUpdateIndexerMutation,
} from "../../../hooks/api/useSearch";
import { Button } from "../../../components/ui/button";
import { Alert, AlertDescription, Skeleton, Pagination } from "../../../components/ui";
import { computeStats } from "../lib/indexers-utils";
import { IndexerStatsGrid } from "./indexer-stats-grid";
import { EmptyIndexersCard } from "./empty-indexers-card";
import { IndexerInstanceCard } from "./indexer-instance-card";

/**
 * Main client component for managing Prowlarr indexers
 * Displays indexer statistics, allows testing indexers, and editing their configuration
 * @returns React component displaying indexers management interface
 */
export const IndexersClient = () => {
	const { data, isLoading, error, refetch, isFetching } = useSearchIndexersQuery();
	const testMutation = useTestIndexerMutation();
	const updateMutation = useUpdateIndexerMutation();
	const [testingKey, setTestingKey] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<{
		type: "success" | "error";
		message: string;
	} | null>(null);
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(25);

	const aggregated = useMemo(() => data?.aggregated ?? [], [data?.aggregated]);
	const stats = useMemo(() => computeStats(aggregated), [aggregated]);
	const instances = useMemo(() => data?.instances ?? [], [data?.instances]);
	const noInstances = !isLoading && instances.length === 0;

	const paginatedAggregated = useMemo(() => {
		const start = (page - 1) * pageSize;
		return aggregated.slice(start, start + pageSize);
	}, [aggregated, page, pageSize]);

	const paginatedInstances = useMemo(() => {
		const instanceMap = new Map<string, typeof instances[0]>();

		for (const indexer of paginatedAggregated) {
			const existingInstance = instanceMap.get(indexer.instanceId);
			if (existingInstance) {
				existingInstance.data.push(indexer);
			} else {
				const originalInstance = instances.find(inst => inst.instanceId === indexer.instanceId);
				if (originalInstance) {
					instanceMap.set(indexer.instanceId, {
						instanceId: originalInstance.instanceId,
						instanceName: originalInstance.instanceName,
						data: [indexer],
					});
				}
			}
		}

		return Array.from(instanceMap.values());
	}, [paginatedAggregated, instances]);

	const handleTest = async (instanceId: string, indexerId: number) => {
		if (testMutation.isPending) {
			return;
		}
		const key = `${instanceId}:${indexerId}`;
		setTestingKey(key);
		setFeedback(null);
		try {
			const result = await testMutation.mutateAsync({ instanceId, indexerId });
			setFeedback({
				type: "success",
				message: result.message ?? "Indexer test passed",
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Indexer test failed";
			setFeedback({ type: "error", message });
		} finally {
			setTestingKey(null);
		}
	};

	const handleUpdate = async (
		updateInstanceId: string,
		indexerId: number,
		payload: ProwlarrIndexerDetails,
	) => {
		setFeedback(null);
		try {
			const result = await updateMutation.mutateAsync({
				instanceId: updateInstanceId,
				indexerId,
				indexer: payload,
			});
			setFeedback({ type: "success", message: "Indexer changes saved" });
			void refetch();
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to update indexer";
			setFeedback({ type: "error", message });
			throw err instanceof Error ? err : new Error(message);
		}
	};

	const handleToggleDetails = (instanceId: string, indexerId: number) => {
		const key = `${instanceId}:${indexerId}`;
		setExpandedKey((previous) => (previous === key ? null : key));
	};

	if (isLoading) {
		return (
			<div className="flex h-64 items-center justify-center">
				<Skeleton className="h-10 w-10 rounded-full" />
			</div>
		);
	}

	return (
		<section className="flex flex-col gap-10">
			<header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
				<div>
					<p className="text-sm font-medium uppercase text-white/60">Indexer management</p>
					<h1 className="text-3xl font-semibold text-white">Indexers</h1>
					<p className="mt-2 text-sm text-white/60">
						Review indexers from your configured Prowlarr instances, inspect their settings, and run
						connectivity tests.
					</p>
				</div>
				<Button variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
					{isFetching ? "Refreshing…" : "Refresh"}
				</Button>
			</header>

			{error && (
				<Alert variant="danger">
					<AlertDescription>
						Unable to load indexers. Double-check your Prowlarr settings and try again.
					</AlertDescription>
				</Alert>
			)}

			{feedback && (
				<Alert variant={feedback.type === "success" ? "success" : "danger"}>
					<AlertDescription>{feedback.message}</AlertDescription>
				</Alert>
			)}

			{noInstances ? (
				<EmptyIndexersCard />
			) : (
				<>
					<IndexerStatsGrid stats={stats} />

					{aggregated.length > 0 && (
						<Pagination
							currentPage={page}
							totalItems={aggregated.length}
							pageSize={pageSize}
							onPageChange={setPage}
							onPageSizeChange={(size) => {
								setPageSize(size);
								setPage(1);
							}}
							pageSizeOptions={[25, 50, 100]}
						/>
					)}

					<div className="space-y-8">
						{paginatedInstances.map((instance) => (
							<IndexerInstanceCard
								key={instance.instanceId}
								instanceId={instance.instanceId}
								instanceName={instance.instanceName}
								indexers={instance.data}
								onTest={handleTest}
								onUpdate={handleUpdate}
								testingKey={testingKey}
								isPending={testMutation.isPending}
								expandedKey={expandedKey}
								onToggleDetails={handleToggleDetails}
							/>
						))}
					</div>

					{aggregated.length > 0 && (
						<Pagination
							currentPage={page}
							totalItems={aggregated.length}
							pageSize={pageSize}
							onPageChange={setPage}
							onPageSizeChange={(size) => {
								setPageSize(size);
								setPage(1);
							}}
							pageSizeOptions={[25, 50, 100]}
						/>
					)}
				</>
			)}
		</section>
	);
};
