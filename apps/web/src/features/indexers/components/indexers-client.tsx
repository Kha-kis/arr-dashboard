"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import {
	AlertCircle,
	CheckCircle2,
	FlaskConical,
	RefreshCw,
	Search,
	SlidersHorizontal,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilterSelect } from "../../../components/layout";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import { Input, Pagination } from "../../../components/ui";
import {
	useSearchIndexersQuery,
	useTestIndexerMutation,
	useUpdateIndexerMutation,
} from "../../../hooks/api/useSearch";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getErrorMessage } from "../../../lib/error-utils";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { computeStats } from "../lib/indexers-utils";
import { EmptyIndexersCard } from "./empty-indexers-card";
import { IndexerInstanceCard } from "./indexer-instance-card";
import { IndexerStatsGrid } from "./indexer-stats-grid";

// ============================================================================
// Types & Constants
// ============================================================================

type ProtocolFilter = "all" | "torrent" | "usenet";
type StatusFilter = "all" | "enabled" | "disabled";
type SortField = "name" | "priority" | "protocol";
type SortOrder = "asc" | "desc";

const PROTOCOL_OPTIONS = [
	{ value: "all", label: "All protocols" },
	{ value: "torrent", label: "Torrent" },
	{ value: "usenet", label: "Usenet" },
];

const STATUS_OPTIONS = [
	{ value: "all", label: "All statuses" },
	{ value: "enabled", label: "Enabled" },
	{ value: "disabled", label: "Disabled" },
];

const SORT_OPTIONS = [
	{ value: "name", label: "Name" },
	{ value: "priority", label: "Priority" },
	{ value: "protocol", label: "Protocol" },
];

const FEEDBACK_AUTO_DISMISS_MS = 5000;

// ============================================================================
// Component
// ============================================================================

export const IndexersClient = () => {
	const { gradient: themeGradient } = useThemeGradient();

	const { data, isLoading, error, refetch, isFetching } = useSearchIndexersQuery();
	const { data: services } = useServicesQuery();
	const testMutation = useTestIndexerMutation();
	const updateMutation = useUpdateIndexerMutation();

	const prowlarrUrlMap = useMemo(() => {
		const map = new Map<string, string>();
		if (!services) return map;
		for (const svc of services) {
			if (svc.service === "prowlarr") {
				map.set(svc.id, svc.externalUrl || svc.baseUrl);
			}
		}
		return map;
	}, [services]);

	// UI state
	const [testingKey, setTestingKey] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<{
		type: "success" | "error";
		message: string;
	} | null>(null);
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(25);

	// Filter state
	const [searchTerm, setSearchTerm] = useState("");
	const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>("all");
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [instanceFilter, setInstanceFilter] = useState("all");
	const [sortField, setSortField] = useState<SortField>("name");
	const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
	const [filtersOpen, setFiltersOpen] = useState(false);

	// Test All state
	const [testAllRunning, setTestAllRunning] = useState(false);
	const [testAllProgress, setTestAllProgress] = useState<{
		total: number;
		completed: number;
		passed: number;
		failed: number;
	} | null>(null);

	// Auto-dismiss feedback
	const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const setFeedbackWithAutoDismiss = useCallback(
		(fb: { type: "success" | "error"; message: string }) => {
			if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
			setFeedback(fb);
			feedbackTimerRef.current = setTimeout(() => setFeedback(null), FEEDBACK_AUTO_DISMISS_MS);
		},
		[],
	);
	useEffect(() => {
		return () => {
			if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
		};
	}, []);

	// Keyboard shortcut: "F" to toggle filters
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT"
			)
				return;
			if (e.key === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
				e.preventDefault();
				setFiltersOpen((prev) => !prev);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	// Data
	const aggregated = useMemo(() => data?.aggregated ?? [], [data?.aggregated]);
	const [incognitoMode] = useIncognitoMode();
	const instances = useMemo(() => data?.instances ?? [], [data?.instances]);
	const noInstances = !isLoading && instances.length === 0;

	const instanceOptions = useMemo(() => {
		const opts = [{ value: "all", label: "All instances" }];
		for (const inst of instances) {
			opts.push({
				value: inst.instanceId,
				label: incognitoMode ? getLinuxInstanceName(inst.instanceName) : inst.instanceName,
			});
		}
		return opts;
	}, [instances, incognitoMode]);

	// Filter + sort
	const filtered = useMemo(() => {
		let result = aggregated;

		if (searchTerm.trim()) {
			const term = searchTerm.toLowerCase();
			result = result.filter((idx) => idx.name.toLowerCase().includes(term));
		}
		if (protocolFilter !== "all") {
			result = result.filter((idx) => idx.protocol === protocolFilter);
		}
		if (statusFilter !== "all") {
			result = result.filter((idx) => (statusFilter === "enabled" ? idx.enable : !idx.enable));
		}
		if (instanceFilter !== "all") {
			result = result.filter((idx) => idx.instanceId === instanceFilter);
		}

		result = [...result].sort((a, b) => {
			let cmp = 0;
			switch (sortField) {
				case "name":
					cmp = a.name.localeCompare(b.name);
					break;
				case "priority":
					cmp = (a.priority ?? 0) - (b.priority ?? 0);
					break;
				case "protocol":
					cmp = a.protocol.localeCompare(b.protocol);
					break;
			}
			return sortOrder === "asc" ? cmp : -cmp;
		});

		return result;
	}, [aggregated, searchTerm, protocolFilter, statusFilter, instanceFilter, sortField, sortOrder]);

	const stats = useMemo(() => computeStats(aggregated), [aggregated]);

	const resetPage = useCallback(() => setPage(1), []);

	const paginatedIndexers = useMemo(() => {
		const start = (page - 1) * pageSize;
		return filtered.slice(start, start + pageSize);
	}, [filtered, page, pageSize]);

	const paginatedInstances = useMemo(() => {
		const instanceMap = new Map<
			string,
			{ instanceId: string; instanceName: string; data: ProwlarrIndexer[] }
		>();
		for (const indexer of paginatedIndexers) {
			const existing = instanceMap.get(indexer.instanceId);
			if (existing) {
				existing.data.push(indexer);
			} else {
				instanceMap.set(indexer.instanceId, {
					instanceId: indexer.instanceId,
					instanceName: indexer.instanceName,
					data: [indexer],
				});
			}
		}
		return Array.from(instanceMap.values());
	}, [paginatedIndexers]);

	// Active filter count
	const activeFilterCount = [
		searchTerm.trim() ? 1 : 0,
		protocolFilter !== "all" ? 1 : 0,
		statusFilter !== "all" ? 1 : 0,
		instanceFilter !== "all" ? 1 : 0,
	].reduce((sum, v) => sum + v, 0);

	// Handlers
	const handleTest = async (instanceId: string, indexerId: number) => {
		if (testMutation.isPending) return;
		const key = `${instanceId}:${indexerId}`;
		setTestingKey(key);
		setFeedback(null);
		try {
			const result = await testMutation.mutateAsync({ instanceId, indexerId });
			setFeedbackWithAutoDismiss({
				type: "success",
				message: result.message ?? "Indexer test passed",
			});
		} catch (err) {
			setFeedbackWithAutoDismiss({
				type: "error",
				message: getErrorMessage(err, "Indexer test failed"),
			});
		} finally {
			setTestingKey(null);
		}
	};

	const handleTestAll = async () => {
		if (testAllRunning) return;
		const enabledIndexers = filtered.filter((idx) => idx.enable);
		if (enabledIndexers.length === 0) {
			setFeedbackWithAutoDismiss({
				type: "error",
				message: "No enabled indexers to test",
			});
			return;
		}

		setTestAllRunning(true);
		setFeedback(null);
		const progress = { total: enabledIndexers.length, completed: 0, passed: 0, failed: 0 };
		setTestAllProgress({ ...progress });

		const BATCH_SIZE = 5;
		for (let i = 0; i < enabledIndexers.length; i += BATCH_SIZE) {
			const batch = enabledIndexers.slice(i, i + BATCH_SIZE);
			const results = await Promise.allSettled(
				batch.map((idx) =>
					testMutation.mutateAsync({ instanceId: idx.instanceId, indexerId: idx.id }),
				),
			);
			for (const result of results) {
				progress.completed++;
				if (result.status === "fulfilled") {
					progress.passed++;
				} else {
					progress.failed++;
				}
			}
			setTestAllProgress({ ...progress });
		}

		setTestAllRunning(false);
		setTestAllProgress(null);
		setFeedbackWithAutoDismiss({
			type: progress.failed === 0 ? "success" : "error",
			message:
				progress.failed === 0
					? `All ${progress.passed} indexers passed`
					: `${progress.passed} passed, ${progress.failed} failed out of ${progress.total} indexers`,
		});
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
			setFeedbackWithAutoDismiss({ type: "success", message: "Indexer changes saved" });
			void refetch();
			return result;
		} catch (err) {
			const message = getErrorMessage(err, "Failed to update indexer");
			setFeedbackWithAutoDismiss({ type: "error", message });
			throw err instanceof Error ? err : new Error(message);
		}
	};

	const handleToggleDetails = (instanceId: string, indexerId: number) => {
		const key = `${instanceId}:${indexerId}`;
		setExpandedKey((previous) => (previous === key ? null : key));
	};

	const toggleSortOrder = () => {
		setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
		resetPage();
	};

	// Loading State
	if (isLoading) {
		return (
			<section className="space-y-6 animate-in fade-in duration-300">
				<div className="space-y-3">
					<PremiumSkeleton variant="line" className="h-8 w-48" />
					<PremiumSkeleton
						variant="line"
						className="h-4 w-80"
						style={{ animationDelay: "50ms" }}
					/>
				</div>
				<PremiumSkeleton
					variant="card"
					className="h-14"
					style={{ animationDelay: "100ms" }}
				/>
				<PremiumSkeleton
					variant="card"
					className="h-12"
					style={{ animationDelay: "150ms" }}
				/>
				<div className="space-y-1">
					{["a", "b", "c", "d", "e"].map((id, i) => (
						<PremiumSkeleton
							key={id}
							variant="line"
							className="h-12"
							style={{ animationDelay: `${(i + 4) * 50}ms` }}
						/>
					))}
				</div>
			</section>
		);
	}

	return (
		<section className="space-y-5 animate-in fade-in duration-300">
			{/* Header — compact, two-line */}
			<header className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-bold text-foreground">Indexers</h1>
					<p className="text-sm text-muted-foreground/70 mt-0.5">
						{aggregated.length > 0
							? `${aggregated.length} indexers across ${instances.length} ${instances.length === 1 ? "instance" : "instances"}`
							: "Manage your Prowlarr indexers"}
					</p>
				</div>

				<div className="flex items-center gap-2 shrink-0">
					{/* Test All */}
					{!noInstances && aggregated.length > 0 && (
						<button
							type="button"
							onClick={handleTestAll}
							disabled={testAllRunning || isFetching}
							className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed border border-border/40 hover:bg-card/60"
						>
							<FlaskConical className={`h-3.5 w-3.5 ${testAllRunning ? "animate-pulse" : ""}`} />
							<span className="hidden sm:inline">{testAllRunning ? "Testing..." : "Test All"}</span>
						</button>
					)}

					{/* Refresh */}
					<button
						type="button"
						onClick={() => void refetch()}
						disabled={isFetching}
						className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 2px 8px -2px ${themeGradient.glow}`,
						}}
					>
						<RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
						<span className="hidden sm:inline">{isFetching ? "Refreshing" : "Refresh"}</span>
					</button>
				</div>
			</header>

			{/* Feedback alerts */}
			{error && (
				<div
					className="rounded-lg border p-3 animate-in fade-in slide-in-from-top-2 duration-200"
					style={{
						backgroundColor: SEMANTIC_COLORS.error.bg,
						borderColor: SEMANTIC_COLORS.error.border,
					}}
				>
					<div className="flex items-center gap-3">
						<AlertCircle className="h-4 w-4 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
						<p className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
							Unable to load indexers. Check your Prowlarr settings.
						</p>
					</div>
				</div>
			)}

			{feedback && (
				<div
					className="rounded-lg border p-3 animate-in fade-in slide-in-from-top-2 duration-200"
					style={{
						backgroundColor:
							feedback.type === "success" ? SEMANTIC_COLORS.success.bg : SEMANTIC_COLORS.error.bg,
						borderColor:
							feedback.type === "success"
								? SEMANTIC_COLORS.success.border
								: SEMANTIC_COLORS.error.border,
					}}
				>
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							{feedback.type === "success" ? (
								<CheckCircle2
									className="h-4 w-4 shrink-0"
									style={{ color: SEMANTIC_COLORS.success.from }}
								/>
							) : (
								<XCircle
									className="h-4 w-4 shrink-0"
									style={{ color: SEMANTIC_COLORS.error.from }}
								/>
							)}
							<p
								className="text-sm font-medium"
								style={{
									color:
										feedback.type === "success"
											? SEMANTIC_COLORS.success.text
											: SEMANTIC_COLORS.error.text,
								}}
							>
								{feedback.message}
							</p>
						</div>
						<button
							type="button"
							onClick={() => setFeedback(null)}
							className="shrink-0 rounded-md p-0.5 hover:bg-muted/50 transition-colors"
						>
							<XCircle className="h-3.5 w-3.5 text-muted-foreground" />
						</button>
					</div>
				</div>
			)}

			{/* Test All Progress */}
			{testAllProgress && (
				<div
					className="rounded-lg border p-3 animate-in fade-in duration-200"
					style={{
						backgroundColor: `${themeGradient.from}08`,
						borderColor: `${themeGradient.from}25`,
					}}
				>
					<div className="space-y-2">
						<div className="flex items-center justify-between text-xs">
							<span className="font-medium text-foreground">
								Testing... {testAllProgress.completed}/{testAllProgress.total}
							</span>
							<span className="text-muted-foreground">
								{testAllProgress.passed} passed
								{testAllProgress.failed > 0 && `, ${testAllProgress.failed} failed`}
							</span>
						</div>
						<div className="h-1.5 rounded-full bg-muted/20 overflow-hidden">
							<div
								className="h-full rounded-full transition-all duration-300"
								style={{
									width: `${Math.round((testAllProgress.completed / testAllProgress.total) * 100)}%`,
									background:
										testAllProgress.failed > 0
											? SEMANTIC_COLORS.warning.from
											: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
								}}
							/>
						</div>
					</div>
				</div>
			)}

			{noInstances ? (
				<EmptyIndexersCard />
			) : (
				<>
					{/* Stats Ribbon */}
					<IndexerStatsGrid stats={stats} />

					{/* Search + Filter Bar — integrated, minimal */}
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
							{/* Search */}
							<div className="relative flex-1">
								<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/55" />
								<Input
									placeholder="Search indexers..."
									value={searchTerm}
									id="indexer-search"
									onChange={(e) => {
										setSearchTerm(e.target.value);
										resetPage();
									}}
									className="pl-9 h-9 text-sm"
								/>
							</div>

							{/* Filter toggle + sort controls */}
							<div className="flex items-center gap-2 shrink-0">
								<button
									type="button"
									onClick={() => setFiltersOpen((prev) => !prev)}
									className="inline-flex items-center gap-1.5 rounded-lg border border-border/40 px-2.5 py-2 text-xs font-medium transition-colors hover:bg-card/60"
									style={{
										color: filtersOpen || activeFilterCount > 0 ? themeGradient.from : undefined,
										borderColor: activeFilterCount > 0 ? `${themeGradient.from}30` : undefined,
									}}
								>
									<SlidersHorizontal className="h-3.5 w-3.5" />
									Filters
									{activeFilterCount > 0 && (
										<span
											className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white"
											style={{ backgroundColor: themeGradient.from }}
										>
											{activeFilterCount}
										</span>
									)}
									<kbd className="hidden sm:inline-flex h-4 items-center rounded border border-border/30 bg-muted/20 px-1 text-[9px] font-mono text-muted-foreground/55">
										F
									</kbd>
								</button>

								{/* Sort toggle */}
								<button
									type="button"
									onClick={toggleSortOrder}
									className="rounded-lg border border-border/40 px-2.5 py-2 text-xs font-medium transition-colors hover:bg-card/60"
									title={sortOrder === "asc" ? "Ascending" : "Descending"}
								>
									{sortOrder === "asc" ? "A→Z" : "Z→A"}
								</button>
							</div>
						</div>

						{/* Collapsible filters */}
						{filtersOpen && (
							<div className="flex flex-wrap items-end gap-3 animate-in fade-in slide-in-from-top-1 duration-150">
								<FilterSelect
									value={protocolFilter}
									onChange={(v) => {
										setProtocolFilter(v as ProtocolFilter);
										resetPage();
									}}
									options={PROTOCOL_OPTIONS}
									label="Protocol"
								/>
								<FilterSelect
									value={statusFilter}
									onChange={(v) => {
										setStatusFilter(v as StatusFilter);
										resetPage();
									}}
									options={STATUS_OPTIONS}
									label="Status"
								/>
								{instances.length > 1 && (
									<FilterSelect
										value={instanceFilter}
										onChange={(v) => {
											setInstanceFilter(v);
											resetPage();
										}}
										options={instanceOptions}
										label="Instance"
									/>
								)}
								<FilterSelect
									value={sortField}
									onChange={(v) => {
										setSortField(v as SortField);
										resetPage();
									}}
									options={SORT_OPTIONS}
									label="Sort by"
								/>
							</div>
						)}

						{/* Active filter summary */}
						{activeFilterCount > 0 && (
							<div className="flex items-center justify-between text-[11px] text-muted-foreground/60">
								<span>
									{filtered.length} of {aggregated.length} indexers
								</span>
								<button
									type="button"
									onClick={() => {
										setSearchTerm("");
										setProtocolFilter("all");
										setStatusFilter("all");
										setInstanceFilter("all");
									}}
									className="hover:text-foreground transition-colors"
									style={{ color: themeGradient.from }}
								>
									Clear all
								</button>
							</div>
						)}
					</div>

					{/* Pagination */}
					{filtered.length > pageSize && (
						<Pagination
							currentPage={page}
							totalItems={filtered.length}
							pageSize={pageSize}
							onPageChange={setPage}
							onPageSizeChange={(size) => {
								setPageSize(size);
								setPage(1);
							}}
							pageSizeOptions={[25, 50, 100]}
						/>
					)}

					{/* Instance Cards */}
					{paginatedInstances.length > 0 ? (
						<div className="space-y-4">
							{paginatedInstances.map((instance, index) => (
								<div
									key={instance.instanceId}
									className="animate-in fade-in slide-in-from-bottom-2"
									style={{
										animationDelay: `${index * 80}ms`,
										animationFillMode: "backwards",
									}}
								>
									<IndexerInstanceCard
										instanceId={instance.instanceId}
										instanceName={instance.instanceName}
										prowlarrUrl={prowlarrUrlMap.get(instance.instanceId)}
										indexers={instance.data}
										onTest={handleTest}
										onUpdate={handleUpdate}
										testingKey={testingKey}
										isPending={testMutation.isPending}
										expandedKey={expandedKey}
										onToggleDetails={handleToggleDetails}
										searchTerm={searchTerm}
									/>
								</div>
							))}
						</div>
					) : (
						<div className="text-center py-16">
							<Search className="h-6 w-6 mx-auto mb-2 text-muted-foreground/45" />
							<p className="text-xs text-muted-foreground/50">No indexers match your filters</p>
						</div>
					)}

					{/* Bottom Pagination */}
					{filtered.length > pageSize && (
						<Pagination
							currentPage={page}
							totalItems={filtered.length}
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
