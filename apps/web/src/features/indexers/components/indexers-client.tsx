"use client";

import { useMemo, useState } from "react";
import type { ProwlarrIndexerDetails } from "@arr/shared";
import {
	useSearchIndexersQuery,
	useTestIndexerMutation,
	useUpdateIndexerMutation,
} from "../../../hooks/api/useSearch";
import { Pagination } from "../../../components/ui";
import { computeStats } from "../lib/indexers-utils";
import { IndexerStatsGrid } from "./indexer-stats-grid";
import { EmptyIndexersCard } from "./empty-indexers-card";
import { IndexerInstanceCard } from "./indexer-instance-card";
import {
	RefreshCw,
	AlertCircle,
	CheckCircle2,
	XCircle,
	Search,
} from "lucide-react";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import { getErrorMessage } from "../../../lib/error-utils";

/**
 * Premium Indexers Client
 *
 * Features:
 * - Theme-aware gradient header
 * - Glassmorphic feedback alerts
 * - Animated loading states
 * - Premium pagination styling
 */
export const IndexersClient = () => {
	const { gradient: themeGradient } = useThemeGradient();

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
			const message = getErrorMessage(err, "Indexer test failed");
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
			const message = getErrorMessage(err, "Failed to update indexer");
			setFeedback({ type: "error", message });
			throw err instanceof Error ? err : new Error(message);
		}
	};

	const handleToggleDetails = (instanceId: string, indexerId: number) => {
		const key = `${instanceId}:${indexerId}`;
		setExpandedKey((previous) => (previous === key ? null : key));
	};

	// Loading State
	if (isLoading) {
		return (
			<section className="space-y-8 animate-in fade-in duration-300">
				{/* Header Skeleton */}
				<div className="space-y-4">
					<PremiumSkeleton variant="line" className="h-4 w-32" />
					<PremiumSkeleton variant="line" className="h-10 w-48" style={{ animationDelay: "50ms" }} />
					<PremiumSkeleton variant="line" className="h-4 w-96" style={{ animationDelay: "100ms" }} />
				</div>

				{/* Stats Grid Skeleton */}
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					{Array.from({ length: 4 }).map((_, i) => (
						<PremiumSkeleton
							key={i}
							variant="card"
							className="h-24"
							style={{ animationDelay: `${i * 100}ms` }}
						/>
					))}
				</div>

				{/* Loading Indicator */}
				<div className="flex items-center justify-center py-12">
					<div
						className="h-10 w-10 animate-spin rounded-full border-2 border-t-transparent"
						style={{ borderColor: `${themeGradient.from}40`, borderTopColor: "transparent" }}
					/>
				</div>
			</section>
		);
	}

	return (
		<section className="space-y-8 animate-in fade-in duration-300">
			{/* Premium Header */}
			<header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
				<div className="flex items-start gap-4">
					<div
						className="flex h-14 w-14 items-center justify-center rounded-2xl shrink-0"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: `1px solid ${themeGradient.from}30`,
						}}
					>
						<Search className="h-7 w-7" style={{ color: themeGradient.from }} />
					</div>
					<div>
						<p
							className="text-sm font-medium uppercase tracking-wider"
							style={{ color: themeGradient.from }}
						>
							Indexer management
						</p>
						<h1
							className="text-3xl font-bold mt-1"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								WebkitBackgroundClip: "text",
								WebkitTextFillColor: "transparent",
							}}
						>
							Indexers
						</h1>
						<p className="mt-2 text-sm text-muted-foreground max-w-xl">
							Review indexers from your configured Prowlarr instances, inspect their settings, and run
							connectivity tests.
						</p>
					</div>
				</div>

				<button
					type="button"
					onClick={() => void refetch()}
					disabled={isFetching}
					className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
					}}
				>
					<RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
					{isFetching ? "Refreshing..." : "Refresh"}
				</button>
			</header>

			{/* Error Alert */}
			{error && (
				<div
					className="rounded-2xl border p-5 backdrop-blur-xs animate-in fade-in slide-in-from-top-2 duration-300"
					style={{
						backgroundColor: SEMANTIC_COLORS.error.bg,
						borderColor: SEMANTIC_COLORS.error.border,
					}}
				>
					<div className="flex items-start gap-4">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
							style={{ backgroundColor: `${SEMANTIC_COLORS.error.from}20` }}
						>
							<AlertCircle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.error.from }} />
						</div>
						<div>
							<p className="font-semibold text-foreground">Unable to load indexers</p>
							<p className="text-sm text-muted-foreground mt-1">
								Double-check your Prowlarr settings and try again.
							</p>
						</div>
					</div>
				</div>
			)}

			{/* Feedback Alert */}
			{feedback && (
				<div
					className="rounded-2xl border p-5 backdrop-blur-xs animate-in fade-in slide-in-from-top-2 duration-300"
					style={{
						backgroundColor: feedback.type === "success" ? SEMANTIC_COLORS.success.bg : SEMANTIC_COLORS.error.bg,
						borderColor: feedback.type === "success" ? SEMANTIC_COLORS.success.border : SEMANTIC_COLORS.error.border,
					}}
				>
					<div className="flex items-center gap-3">
						{feedback.type === "success" ? (
							<CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.success.from }} />
						) : (
							<XCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
						)}
						<p
							className="font-medium"
							style={{
								color: feedback.type === "success" ? SEMANTIC_COLORS.success.text : SEMANTIC_COLORS.error.text,
							}}
						>
							{feedback.message}
						</p>
					</div>
				</div>
			)}

			{noInstances ? (
				<EmptyIndexersCard />
			) : (
				<>
					{/* Stats Grid */}
					<IndexerStatsGrid stats={stats} />

					{/* Top Pagination */}
					{aggregated.length > 0 && (
						<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
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
						</div>
					)}

					{/* Instance Cards */}
					<div className="space-y-6">
						{paginatedInstances.map((instance, index) => (
							<div
								key={instance.instanceId}
								className="animate-in fade-in slide-in-from-bottom-4"
								style={{
									animationDelay: `${index * 100}ms`,
									animationFillMode: "backwards",
								}}
							>
								<IndexerInstanceCard
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
							</div>
						))}
					</div>

					{/* Bottom Pagination */}
					{aggregated.length > 0 && (
						<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
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
						</div>
					)}
				</>
			)}
		</section>
	);
};
