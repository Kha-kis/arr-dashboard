"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Activity,
	CheckCircle,
	ChevronRight,
	Loader2,
	RefreshCw,
	Server,
	ShieldAlert,
	Trash2,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { GlassmorphicCard, PremiumSection } from "../../../components/layout";
import { Button } from "../../../components/ui/button";
import { apiRequest } from "../../../lib/api-client/base";
import { getErrorMessage } from "../../../lib/error-utils";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

// ============================================================================
// Types
// ============================================================================

interface ValidationStats {
	total: number;
	validated: number;
	rejected: number;
}

type HealthState = "healthy" | "degraded" | "failing";

interface IntegrationHealth {
	lastRefreshAt: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	consecutiveFailures: number;
	state: HealthState;
	categories: Record<string, ValidationStats>;
	totals: ValidationStats;
}

interface SchemaFingerprint {
	fields: string[];
	recordedAt: string;
	sampleCount: number;
}

interface DriftReport {
	newFields: string[];
	missingFields: string[];
	hasDrift: boolean;
}

interface CategoryFingerprint {
	baseline: SchemaFingerprint;
	latest: SchemaFingerprint;
	drift: DriftReport;
	fieldMissCounts: Record<string, number>;
}

interface QuarantinedItem {
	raw: unknown;
	errors: string[];
	integration: string;
	category: string;
	timestamp: string;
}

interface QuarantineResponse {
	success: boolean;
	data: {
		items: Record<string, QuarantinedItem[]>;
		totalCount: number;
	};
}

export interface ValidationHealthResponse {
	success: boolean;
	data: {
		integrations: Record<string, IntegrationHealth>;
		overallTotals: ValidationStats;
		validationModes: Record<string, string>;
		resetAt: string | null;
		fingerprints: Record<string, Record<string, CategoryFingerprint>>;
	};
}

// ============================================================================
// Helper Components
// ============================================================================

function SystemInfoCard({
	icon,
	label,
	value,
	subtitle,
	animationDelay = 0,
}: {
	icon: React.ReactNode;
	label: string;
	value: string;
	subtitle?: string;
	animationDelay?: number;
}) {
	return (
		<div
			className="flex items-start gap-3 p-4 rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs transition-all duration-300 hover:border-border/80 animate-in fade-in slide-in-from-bottom-2"
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{icon}
			<div className="min-w-0 flex-1">
				<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
				<p className="text-sm font-semibold text-foreground mt-0.5 truncate">{value}</p>
				{subtitle && (
					<p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">{subtitle}</p>
				)}
			</div>
		</div>
	);
}

function HealthStateBadge({ state }: { state: HealthState }) {
	const colors = {
		healthy: SEMANTIC_COLORS.success,
		degraded: SEMANTIC_COLORS.warning,
		failing: SEMANTIC_COLORS.error,
	};
	const labels = {
		healthy: "Healthy",
		degraded: "Degraded",
		failing: "Failing",
	};
	const color = colors[state];

	return (
		<span
			className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium"
			style={{
				backgroundColor: `${color.from}20`,
				color: color.from,
			}}
		>
			<span
				className="h-1.5 w-1.5 rounded-full"
				style={{ backgroundColor: color.from }}
			/>
			{labels[state]}
		</span>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function ValidationHealthSection({
	data,
	themeGradient,
	onReset,
	isResetting,
}: {
	data: ValidationHealthResponse["data"];
	themeGradient: { from: string; to: string; glow: string };
	onReset: () => void;
	isResetting: boolean;
}) {
	const { overallTotals, integrations, validationModes, resetAt, fingerprints } = data;
	const integrationNames = Object.keys(integrations);
	const rejectionRate =
		overallTotals.total > 0
			? ((overallTotals.rejected / overallTotals.total) * 100).toFixed(1)
			: "0.0";
	const healthStatus =
		overallTotals.rejected === 0
			? "healthy"
			: Number(rejectionRate) < 5
				? "warning"
				: "error";

	const statusColors = {
		healthy: SEMANTIC_COLORS.success,
		warning: SEMANTIC_COLORS.warning,
		error: SEMANTIC_COLORS.error,
	};
	const statusColor = statusColors[healthStatus];

	const [expandedIntegrations, setExpandedIntegrations] = useState<Set<string>>(new Set());

	const toggleExpanded = (name: string) => {
		setExpandedIntegrations((prev) => {
			const next = new Set(prev);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return next;
		});
	};

	// Check if any fingerprint has drift
	const hasDrift = Object.values(fingerprints ?? {}).some((cats) =>
		Object.values(cats).some((fp) => fp.drift.hasDrift),
	);

	return (
		<PremiumSection
			title="Validation Health"
			description="Upstream data validation statistics across all integrations"
			icon={ShieldAlert}
		>
			<div className="space-y-4">
				{/* Reset Controls */}
				<div className="flex items-center justify-between">
					<p className="text-xs text-muted-foreground">
						{resetAt
							? `Stats since: ${new Date(resetAt).toLocaleString()}`
							: "Stats since app start"}
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={onReset}
						disabled={isResetting || overallTotals.total === 0}
						className="h-7 text-xs gap-1.5"
					>
						{isResetting ? (
							<Loader2 className="h-3 w-3 animate-spin" />
						) : (
							<RefreshCw className="h-3 w-3" />
						)}
						Reset Stats
					</Button>
				</div>

				{/* Summary Cards */}
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					<SystemInfoCard
						icon={
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${statusColor.from}20, ${statusColor.to}20)`,
									border: `1px solid ${statusColor.from}30`,
								}}
							>
								{healthStatus === "healthy" ? (
									<CheckCircle className="h-5 w-5" style={{ color: statusColor.from }} />
								) : (
									<XCircle className="h-5 w-5" style={{ color: statusColor.from }} />
								)}
							</div>
						}
						label="Status"
						value={healthStatus === "healthy" ? "Healthy" : healthStatus === "warning" ? "Degraded" : "Unhealthy"}
						animationDelay={0}
					/>
					<SystemInfoCard
						icon={
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Activity className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
						}
						label="Total Validated"
						value={overallTotals.validated.toLocaleString()}
						subtitle={`of ${overallTotals.total.toLocaleString()} total`}
						animationDelay={50}
					/>
					<SystemInfoCard
						icon={
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}20, ${SEMANTIC_COLORS.error.to}20)`,
									border: `1px solid ${SEMANTIC_COLORS.error.from}30`,
								}}
							>
								<XCircle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.error.from }} />
							</div>
						}
						label="Rejected"
						value={overallTotals.rejected.toLocaleString()}
						subtitle={`${rejectionRate}% rejection rate`}
						animationDelay={100}
					/>
					<SystemInfoCard
						icon={
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${SEMANTIC_COLORS.info.from}20, ${SEMANTIC_COLORS.info.to}20)`,
									border: `1px solid ${SEMANTIC_COLORS.info.from}30`,
								}}
							>
								<Server className="h-5 w-5" style={{ color: SEMANTIC_COLORS.info.from }} />
							</div>
						}
						label="Integrations"
						value={integrationNames.length.toString()}
						subtitle={integrationNames.join(", ") || "none"}
						animationDelay={150}
					/>
				</div>

				{/* Per-Integration Breakdown */}
				{integrationNames.length === 0 && (
					<p className="text-sm text-muted-foreground text-center py-4">
						No validation data yet — stats appear after the first API call to each integration.
					</p>
				)}
				{integrationNames.length > 0 && (
					<GlassmorphicCard padding="none">
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-border/50">
										<th className="text-left p-3 font-medium text-muted-foreground uppercase text-xs tracking-wide w-8" />
										<th className="text-left p-3 font-medium text-muted-foreground uppercase text-xs tracking-wide">Integration</th>
										<th className="text-center p-3 font-medium text-muted-foreground uppercase text-xs tracking-wide">State</th>
										<th className="text-right p-3 font-medium text-muted-foreground uppercase text-xs tracking-wide">Total</th>
										<th className="text-right p-3 font-medium text-muted-foreground uppercase text-xs tracking-wide">Valid</th>
										<th className="text-right p-3 font-medium text-muted-foreground uppercase text-xs tracking-wide">Rejected</th>
										<th className="text-left p-3 font-medium text-muted-foreground uppercase text-xs tracking-wide">Mode</th>
										<th className="text-left p-3 font-medium text-muted-foreground uppercase text-xs tracking-wide">Last Seen</th>
									</tr>
								</thead>
								<tbody>
									{integrationNames.map((name, i) => {
										const health = integrations[name]!;
										const mode = validationModes[name] ?? "tolerant";
										const intRejRate = health.totals.total > 0
											? ((health.totals.rejected / health.totals.total) * 100).toFixed(1)
											: "0.0";
										const categoryCount = Object.keys(health.categories).length;
										const isExpandable = categoryCount > 1;
										const isExpanded = expandedIntegrations.has(name);

										return (
											<>
												<tr
													key={name}
													className={`border-b border-border/30 last:border-b-0 transition-colors animate-in fade-in slide-in-from-bottom-1 duration-200 ${isExpandable ? "cursor-pointer hover:bg-card/50" : "hover:bg-card/50"}`}
													style={{
														animationDelay: `${i * 30}ms`,
														animationFillMode: "backwards",
													}}
													onClick={isExpandable ? () => toggleExpanded(name) : undefined}
												>
													<td className="p-3 text-center">
														{isExpandable && (
															<ChevronRight
																className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}
															/>
														)}
													</td>
													<td className="p-3">
														<span className="font-medium text-foreground">{name}</span>
														{categoryCount > 1 && (
															<span className="ml-2 text-xs text-muted-foreground">
																({categoryCount} categories)
															</span>
														)}
													</td>
													<td className="p-3 text-center">
														<HealthStateBadge state={health.state} />
													</td>
													<td className="p-3 text-right font-mono text-foreground">{health.totals.total.toLocaleString()}</td>
													<td className="p-3 text-right font-mono" style={{ color: SEMANTIC_COLORS.success.from }}>{health.totals.validated.toLocaleString()}</td>
													<td className="p-3 text-right font-mono">
														<span style={{ color: health.totals.rejected > 0 ? SEMANTIC_COLORS.error.from : SEMANTIC_COLORS.success.from }}>
															{health.totals.rejected.toLocaleString()}
														</span>
														{health.totals.rejected > 0 && (
															<span className="text-xs text-muted-foreground ml-1">({intRejRate}%)</span>
														)}
													</td>
													<td className="p-3">
														<span
															className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
															style={{
																backgroundColor:
																	mode === "strict" ? `${SEMANTIC_COLORS.error.from}20`
																	: mode === "disabled" ? `${SEMANTIC_COLORS.warning.from}20`
																	: mode === "log-only" ? `${SEMANTIC_COLORS.info.from}20`
																	: `${SEMANTIC_COLORS.success.from}20`,
																color:
																	mode === "strict" ? SEMANTIC_COLORS.error.from
																	: mode === "disabled" ? SEMANTIC_COLORS.warning.from
																	: mode === "log-only" ? SEMANTIC_COLORS.info.from
																	: SEMANTIC_COLORS.success.from,
															}}
														>
															{mode}
														</span>
													</td>
													<td className="p-3 text-xs text-muted-foreground font-mono">
														{health.lastRefreshAt
															? new Date(health.lastRefreshAt).toLocaleTimeString()
															: "—"}
													</td>
												</tr>
												{/* Category drill-down */}
												{isExpanded && Object.entries(health.categories).map(([cat, stats]) => (
													<tr
														key={`${name}:${cat}`}
														className="border-b border-border/20 last:border-b-0 bg-card/20"
													>
														<td className="p-2" />
														<td className="p-2 pl-8 text-xs text-muted-foreground font-mono">{cat}</td>
														<td className="p-2" />
														<td className="p-2 text-right font-mono text-xs text-muted-foreground">{stats.total.toLocaleString()}</td>
														<td className="p-2 text-right font-mono text-xs" style={{ color: SEMANTIC_COLORS.success.from }}>{stats.validated.toLocaleString()}</td>
														<td className="p-2 text-right font-mono text-xs">
															<span style={{ color: stats.rejected > 0 ? SEMANTIC_COLORS.error.from : SEMANTIC_COLORS.success.from }}>
																{stats.rejected.toLocaleString()}
															</span>
														</td>
														<td className="p-2" />
														<td className="p-2" />
													</tr>
												))}
											</>
										);
									})}
								</tbody>
							</table>
						</div>
					</GlassmorphicCard>
				)}

				{/* Schema Drift Section */}
				{fingerprints && (
					<SchemaDriftSection fingerprints={fingerprints} hasDrift={hasDrift} />
				)}

				{/* Quarantine Section */}
				<QuarantineSection />
			</div>
		</PremiumSection>
	);
}

// ============================================================================
// Schema Drift Section
// ============================================================================

function SchemaDriftSection({
	fingerprints,
	hasDrift,
}: {
	fingerprints: Record<string, Record<string, CategoryFingerprint>>;
	hasDrift: boolean;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const integrationNames = Object.keys(fingerprints);

	if (integrationNames.length === 0) return null;

	return (
		<GlassmorphicCard padding="none">
			<button
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				className="flex items-center justify-between w-full p-3 text-left hover:bg-card/50 transition-colors"
			>
				<div className="flex items-center gap-2">
					<ChevronRight
						className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}
					/>
					<span className="text-sm font-medium text-foreground">Schema Drift</span>
					{hasDrift ? (
						<span
							className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
							style={{
								backgroundColor: `${SEMANTIC_COLORS.warning.from}20`,
								color: SEMANTIC_COLORS.warning.from,
							}}
						>
							Drift detected
						</span>
					) : (
						<span
							className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
							style={{
								backgroundColor: `${SEMANTIC_COLORS.success.from}20`,
								color: SEMANTIC_COLORS.success.from,
							}}
						>
							No drift
						</span>
					)}
				</div>
				<span className="text-xs text-muted-foreground">
					{integrationNames.length} integration(s) tracked
				</span>
			</button>

			{isOpen && (
				<div className="border-t border-border/30 p-3 space-y-3">
					{!hasDrift ? (
						<p className="text-sm text-muted-foreground text-center py-2">
							No schema drift detected — all upstream field shapes match their baselines.
						</p>
					) : (
						integrationNames.map((integration) => {
							const categories = fingerprints[integration]!;
							const driftingCategories = Object.entries(categories).filter(
								([, fp]) => fp.drift.hasDrift,
							);

							if (driftingCategories.length === 0) return null;

							return (
								<div key={integration} className="space-y-2">
									<p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
										{integration}
									</p>
									{driftingCategories.map(([category, fp]) => {
										// Fields with 1-2 misses (intermittent, not yet flagged as missing)
										const intermittentFields = Object.entries(fp.fieldMissCounts ?? {})
											.filter(([, count]) => count >= 1 && count < 3)
											.map(([field]) => field)
											.sort();

										return (
											<div
												key={`${integration}:${category}`}
												className="rounded-lg border border-border/30 bg-card/20 p-3 space-y-2"
											>
												<p className="text-sm font-mono text-foreground">{category}</p>
												<div className="flex flex-wrap gap-1.5">
													{fp.drift.newFields.map((field) => (
														<span
															key={field}
															className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono"
															style={{
																backgroundColor: `${SEMANTIC_COLORS.success.from}15`,
																color: SEMANTIC_COLORS.success.from,
																border: `1px solid ${SEMANTIC_COLORS.success.from}30`,
															}}
														>
															+ {field}
														</span>
													))}
													{intermittentFields.map((field) => (
														<span
															key={field}
															className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono"
															style={{
																backgroundColor: `${SEMANTIC_COLORS.warning.from}15`,
																color: SEMANTIC_COLORS.warning.from,
																border: `1px solid ${SEMANTIC_COLORS.warning.from}30`,
															}}
														>
															~ {field}
														</span>
													))}
													{fp.drift.missingFields.map((field) => (
														<span
															key={field}
															className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono"
															style={{
																backgroundColor: `${SEMANTIC_COLORS.error.from}15`,
																color: SEMANTIC_COLORS.error.from,
																border: `1px solid ${SEMANTIC_COLORS.error.from}30`,
															}}
														>
															- {field}
														</span>
													))}
												</div>
											</div>
										);
									})}
								</div>
							);
						})
					)}
				</div>
			)}
		</GlassmorphicCard>
	);
}

// ============================================================================
// Quarantine Section
// ============================================================================

function QuarantineSection() {
	const queryClient = useQueryClient();
	const [isOpen, setIsOpen] = useState(false);
	const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
	const [filterIntegration, setFilterIntegration] = useState<string>("all");

	const { data: quarantine } = useQuery<QuarantineResponse>({
		queryKey: ["validation-quarantine"],
		queryFn: () => apiRequest<QuarantineResponse>("/api/system/validation-quarantine"),
		refetchInterval: 60_000,
	});

	const clearMutation = useMutation({
		mutationFn: () => apiRequest("/api/system/validation-quarantine", { method: "DELETE" }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["validation-quarantine"] });
			toast.success("Quarantine cleared");
		},
		onError: (err) => {
			toast.error(`Failed to clear quarantine: ${getErrorMessage(err)}`);
		},
	});

	const totalCount = quarantine?.data?.totalCount ?? 0;
	const itemsByIntegration = quarantine?.data?.items ?? {};
	const integrationNames = Object.keys(itemsByIntegration).sort();

	const filteredItems: QuarantinedItem[] =
		filterIntegration === "all"
			? integrationNames.flatMap((name) => itemsByIntegration[name] ?? [])
			: itemsByIntegration[filterIntegration] ?? [];

	const toggleItem = (id: string) => {
		setExpandedItems((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	return (
		<GlassmorphicCard padding="none">
			<button
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				className="flex items-center justify-between w-full p-3 text-left hover:bg-card/50 transition-colors"
			>
				<div className="flex items-center gap-2">
					<ChevronRight
						className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}
					/>
					<span className="text-sm font-medium text-foreground">Quarantine</span>
					{totalCount > 0 ? (
						<span
							className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
							style={{
								backgroundColor: `${SEMANTIC_COLORS.error.from}20`,
								color: SEMANTIC_COLORS.error.from,
							}}
						>
							{totalCount} item{totalCount !== 1 ? "s" : ""}
						</span>
					) : (
						<span
							className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
							style={{
								backgroundColor: `${SEMANTIC_COLORS.success.from}20`,
								color: SEMANTIC_COLORS.success.from,
							}}
						>
							Empty
						</span>
					)}
				</div>
				<span className="text-xs text-muted-foreground">
					Rejected items held for inspection
				</span>
			</button>

			{isOpen && (
				<div className="border-t border-border/30 p-3 space-y-3">
					{totalCount === 0 ? (
						<p className="text-sm text-muted-foreground text-center py-2">
							No quarantined items — all validated data passed successfully.
						</p>
					) : (
						<>
							{/* Controls */}
							<div className="flex items-center justify-between gap-2">
								<select
									value={filterIntegration}
									onChange={(e) => setFilterIntegration(e.target.value)}
									className="text-xs rounded-md border border-border/50 bg-card/30 px-2 py-1 text-foreground"
								>
									<option value="all">All integrations</option>
									{integrationNames.map((name) => (
										<option key={name} value={name}>
											{name} ({(itemsByIntegration[name] ?? []).length})
										</option>
									))}
								</select>
								<Button
									variant="outline"
									size="sm"
									onClick={() => clearMutation.mutate()}
									disabled={clearMutation.isPending}
									className="h-7 text-xs gap-1.5"
								>
									{clearMutation.isPending ? (
										<Loader2 className="h-3 w-3 animate-spin" />
									) : (
										<Trash2 className="h-3 w-3" />
									)}
									Clear All
								</Button>
							</div>

							{/* Quarantine table */}
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b border-border/50">
											<th className="text-left p-2 font-medium text-muted-foreground uppercase text-xs tracking-wide w-8" />
											<th className="text-left p-2 font-medium text-muted-foreground uppercase text-xs tracking-wide">Time</th>
											<th className="text-left p-2 font-medium text-muted-foreground uppercase text-xs tracking-wide">Integration</th>
											<th className="text-left p-2 font-medium text-muted-foreground uppercase text-xs tracking-wide">Category</th>
											<th className="text-left p-2 font-medium text-muted-foreground uppercase text-xs tracking-wide">Error</th>
										</tr>
									</thead>
									<tbody>
										{filteredItems.map((item, i) => {
											const itemId = `${item.integration}:${item.category}:${item.timestamp}:${i}`;
											const isExpanded = expandedItems.has(itemId);
											const firstError = item.errors[0] ?? "Unknown error";

											return (
												<>
													<tr
														key={itemId}
														className="border-b border-border/20 last:border-b-0 cursor-pointer hover:bg-card/50 transition-colors"
														onClick={() => toggleItem(itemId)}
													>
														<td className="p-2 text-center">
															<ChevronRight
																className={`h-3 w-3 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}
															/>
														</td>
														<td className="p-2 text-xs text-muted-foreground font-mono whitespace-nowrap">
															{new Date(item.timestamp).toLocaleTimeString()}
														</td>
														<td className="p-2 text-xs font-medium text-foreground">{item.integration}</td>
														<td className="p-2 text-xs font-mono text-muted-foreground">{item.category}</td>
														<td className="p-2 text-xs text-muted-foreground truncate max-w-[300px]">
															{firstError}
														</td>
													</tr>
													{isExpanded && (
														<tr key={`${itemId}-detail`} className="border-b border-border/20 bg-card/20">
															<td colSpan={5} className="p-3">
																<div className="space-y-2">
																	<div>
																		<p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
																			Errors ({item.errors.length})
																		</p>
																		<ul className="space-y-1">
																			{item.errors.map((err, ei) => (
																				<li key={ei} className="text-xs font-mono text-red-400">
																					{err}
																				</li>
																			))}
																		</ul>
																	</div>
																	<div>
																		<p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
																			Raw Data
																		</p>
																		<pre className="text-xs font-mono text-muted-foreground bg-black/20 rounded p-2 overflow-auto max-h-40">
																			{JSON.stringify(item.raw, null, 2)?.slice(0, 2000)}
																		</pre>
																	</div>
																</div>
															</td>
														</tr>
													)}
												</>
											);
										})}
									</tbody>
								</table>
							</div>
						</>
					)}
				</div>
			)}
		</GlassmorphicCard>
	);
}
