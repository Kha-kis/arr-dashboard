"use client";

import { AlertCircle, ArrowRight, Download, RefreshCw, Server } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
	GlassmorphicCard,
	PageLayout,
	PremiumEmptyState,
	PremiumPageHeader,
} from "../../../components/layout";
import { Alert, AlertDescription, Button } from "../../../components/ui";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import { getLinuxInstanceName, getLinuxIsoName } from "../../../lib/incognito";
import {
	PRIORITY_OPTIONS,
	priorityValue,
	type SabActionResult,
	type SabInstance,
	useSabCorrelation,
	useSabGlobalAction,
	useSabJobAction,
	useSabOverview,
} from "../lib/sabnzbd-model";

function privateName(value: string, incognito: boolean) {
	return incognito ? getLinuxIsoName(value) : value;
}

export function SabnzbdClient() {
	const [incognito] = useIncognitoMode();
	const [correlationInstanceId, setCorrelationInstanceId] = useState("");
	const [actionFeedback, setActionFeedback] = useState<string | null>(null);
	const correlation = useSabCorrelation(correlationInstanceId);
	const { data, isLoading, isError, isFetching, refetch } = useSabOverview();
	const jobAction = useSabJobAction();
	const globalAction = useSabGlobalAction();
	const showOutcome = (result: SabActionResult) => setActionFeedback(result.message);
	const applyJobAction = async (
		instanceId: string,
		nzoId: string,
		action: "pause" | "resume" | "delete" | "priority" | "category",
		extra: { priority?: "-1" | "0" | "1" | "2"; category?: string; confirmed?: boolean } = {},
	) => {
		try {
			showOutcome(await jobAction.mutateAsync({ instanceId, nzoId, action, ...extra }));
		} catch {
			setActionFeedback(
				"The SABnzbd command outcome could not be confirmed. Refresh the queue before acting again; the command was not replayed.",
			);
		}
	};
	const applyGlobalAction = async (id: string, action: "pause" | "resume") => {
		try {
			showOutcome(await globalAction.mutateAsync({ id, action }));
		} catch {
			setActionFeedback(
				"The queue command outcome could not be confirmed. Refresh status before acting again; the command was not replayed.",
			);
		}
	};

	return (
		<PageLayout>
			<div className="space-y-6">
				<PremiumPageHeader
					label="Download client"
					labelIcon={Download}
					title="SABnzbd"
					description="Read queue and recent history, and control only the SABnzbd instance you choose."
				/>
				{actionFeedback ? (
					<p role="status" aria-live="polite" className="text-sm text-muted-foreground">
						{actionFeedback}
					</p>
				) : null}
				{isError ? (
					<Alert variant="danger" role="alert">
						<AlertCircle className="h-4 w-4" />
						<AlertDescription className="flex items-center justify-between gap-3">
							<span>
								Could not load SABnzbd status. {data ? "Showing the last successful read." : ""}
							</span>
							<Button
								variant="secondary"
								size="sm"
								disabled={isFetching}
								onClick={() => void refetch()}
							>
								<RefreshCw className="h-4 w-4" /> Retry
							</Button>
						</AlertDescription>
					</Alert>
				) : null}
				{isLoading ? (
					<GlassmorphicCard>
						<div className="p-6 text-sm text-muted-foreground">Loading download clients…</div>
					</GlassmorphicCard>
				) : null}
				{!isLoading && data?.configured === false ? (
					<PremiumEmptyState
						icon={Server}
						title="No SABnzbd instance configured"
						description="Add SABnzbd under Settings → Services to view its queue and history."
					/>
				) : null}
				<div className="grid gap-5 xl:grid-cols-2">
					{(data?.instances ?? []).map((instance) => {
						const label = incognito ? getLinuxInstanceName(instance.label) : instance.label;
						return (
							<GlassmorphicCard key={instance.id}>
								<div className="space-y-5 p-5">
									<div className="flex flex-wrap items-start justify-between gap-3">
										<div>
											<h2 className="text-lg font-semibold">{label}</h2>
											<p className="text-sm text-muted-foreground">
												{instance.reachable
													? `${instance.status} · ${instance.version}`
													: "Connection unavailable"}
											</p>
										</div>
										<div className="flex flex-wrap gap-2">
											{instance.reachable ? (
												<Button
													size="sm"
													variant="secondary"
													disabled={correlation.isFetching}
													onClick={() => {
														if (correlationInstanceId === instance.id) void correlation.refetch();
														else setCorrelationInstanceId(instance.id);
													}}
												>
													{correlation.isFetching && correlationInstanceId === instance.id
														? "Matching…"
														: "Match library items"}
												</Button>
											) : null}
											{instance.reachable ? (
												<Button
													size="sm"
													variant="secondary"
													disabled={globalAction.isPending}
													onClick={() =>
														void applyGlobalAction(
															instance.id,
															instance.paused ? "resume" : "pause",
														)
													}
												>
													{instance.paused ? "Resume queue" : "Pause queue"}
												</Button>
											) : null}
											<Link
												className="inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-sm hover:bg-muted/50"
												href="/sabnzbd-activity"
											>
												History <ArrowRight className="h-4 w-4" />
											</Link>
										</div>
									</div>
									{instance.reachable ? (
										<QueueSummary instance={instance} />
									) : (
										<p className="text-sm text-muted-foreground">
											Check the service URL and saved API key in Settings. Provider details are not
											shown here.
										</p>
									)}
									{instance.error ? (
										<p role="status" className="text-sm text-amber-300">
											{instance.error}
										</p>
									) : null}
									<section aria-label={`Queue for ${label}`}>
										<div className="mb-2 flex items-center justify-between">
											<h3 className="font-medium">Queue</h3>
											<span className="text-xs text-muted-foreground">
												{instance.queueCoverage}
											</span>
										</div>
										{correlationInstanceId === instance.id && correlation.data ? (
											<p role="status" className="mb-2 text-xs text-muted-foreground">
												Read-only library matching is {correlation.data.coverage}. Only exact unique
												matches are shown.
											</p>
										) : null}
										{correlationInstanceId === instance.id && correlation.isError ? (
											<p role="status" className="mb-2 text-xs text-muted-foreground">
												Library matching is unavailable; no titles were inferred.
											</p>
										) : null}
										{instance.queue.length === 0 && instance.queueCoverage !== "unavailable" ? (
											<p className="text-sm text-muted-foreground">No active jobs.</p>
										) : null}
										<div className="space-y-2">
											{instance.queue.map((job) => {
												const match =
													correlationInstanceId === instance.id
														? correlation.data?.matches[job.nzoId]
														: undefined;
												return (
													<div
														key={job.nzoId}
														className="grid gap-1 rounded-xl border border-border/50 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
													>
														<div className="min-w-0">
															<p className="truncate text-sm font-medium">
																{privateName(job.name, incognito)}
															</p>
															<p className="text-xs text-muted-foreground">
																{job.status}
																{job.category ? ` · ${incognito ? "category" : job.category}` : ""}
															</p>
															{match ? (
																<p className="text-xs text-muted-foreground">
																	{match.service === "sonarr" ? "Sonarr" : "Radarr"} ·{" "}
																	{incognito
																		? getLinuxInstanceName(match.instanceLabel)
																		: match.instanceLabel}{" "}
																	· {privateName(match.title, incognito)}
																</p>
															) : null}
														</div>
														<div className="text-xs text-muted-foreground sm:text-right">
															{job.percentage} · {job.timeLeft || "time unknown"}
														</div>
														<p className="col-span-full text-xs text-muted-foreground">
															{job.sizeLeft || job.size}
														</p>

														<div className="col-span-full flex flex-wrap items-center gap-2 border-t border-border/40 pt-2">
															<Button
																size="sm"
																variant="secondary"
																disabled={jobAction.isPending}
																onClick={() =>
																	void applyJobAction(
																		instance.id,
																		job.nzoId,
																		job.status.toLowerCase() === "paused" ? "resume" : "pause",
																	)
																}
															>
																{job.status.toLowerCase() === "paused" ? "Resume" : "Pause"}
															</Button>
															<label className="flex items-center gap-1 text-xs text-muted-foreground">
																Priority
																<select
																	aria-label="Set priority"
																	className="h-8 max-w-28 rounded-lg border border-border bg-background px-2"
																	value={priorityValue(job.priority)}
																	disabled={jobAction.isPending}
																	onChange={(event) =>
																		void applyJobAction(instance.id, job.nzoId, "priority", {
																			priority: event.target.value as "-1" | "0" | "1" | "2",
																		})
																	}
																>
																	{PRIORITY_OPTIONS.map((option) => (
																		<option key={option.value} value={option.value}>
																			{option.label}
																		</option>
																	))}
																</select>
															</label>
															<label className="flex items-center gap-1 text-xs text-muted-foreground">
																Category
																<select
																	aria-label="Set category"
																	className="h-8 max-w-36 rounded-lg border border-border bg-background px-2"
																	value={job.category}
																	disabled={jobAction.isPending || instance.categories.length === 0}
																	onChange={(event) =>
																		void applyJobAction(instance.id, job.nzoId, "category", {
																			category: event.target.value,
																		})
																	}
																>
																	{instance.categories.map((category) => (
																		<option key={category} value={category}>
																			{incognito ? "category" : category}
																		</option>
																	))}
																</select>
															</label>
															<Button
																size="sm"
																variant="danger"
																disabled={jobAction.isPending}
																onClick={() => {
																	if (
																		confirm(
																			`Remove ${privateName(job.name, incognito)} from the SABnzbd queue? Downloaded files are not requested for deletion.`,
																		)
																	)
																		void applyJobAction(instance.id, job.nzoId, "delete", {
																			confirmed: true,
																		});
																}}
															>
																Remove
															</Button>
														</div>
													</div>
												);
											})}
										</div>
									</section>
									<section aria-label={`Recent history for ${label}`}>
										<div className="mb-2 flex items-center justify-between">
											<h3 className="font-medium">Recent history</h3>
											<span className="text-xs text-muted-foreground">
												{instance.historyCoverage}
											</span>
										</div>
										{instance.history.length === 0 && instance.historyCoverage !== "unavailable" ? (
											<p className="text-sm text-muted-foreground">No recent history items.</p>
										) : null}
										<div className="space-y-2">
											{instance.history.slice(0, 5).map((item) => (
												<div key={item.nzoId} className="rounded-xl border border-border/50 p-3">
													<p className="truncate text-sm font-medium">
														{privateName(item.name, incognito)}
													</p>
													<p className="text-xs text-muted-foreground">
														{item.status}
														{item.completedAt
															? ` · ${new Date(item.completedAt).toLocaleString()}`
															: ""}
													</p>
													{item.failMessage ? (
														<p className="mt-1 text-xs text-amber-300">
															{privateName(item.failMessage, incognito)}
														</p>
													) : null}
												</div>
											))}
										</div>
									</section>
								</div>
							</GlassmorphicCard>
						);
					})}
				</div>
			</div>
		</PageLayout>
	);
}

function QueueSummary({ instance }: { instance: SabInstance }) {
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<Metric label="Queued" value={instance.queueCount} />
			<Metric label="Speed" value={`${instance.speed || "—"}${instance.speed ? "/s" : ""}`} />
			<Metric label="Disk free" value={instance.diskFree || "—"} />
			<Metric label="Global queue" value={instance.paused ? "Paused" : "Running"} />
		</div>
	);
}

function Metric({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="rounded-xl bg-muted/30 p-3">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="truncate font-semibold">{value}</p>
		</div>
	);
}
