"use client";

import { AlertCircle, ArrowLeft, ArrowRight, History, RefreshCw } from "lucide-react";
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
	type SabActionResult,
	useSabHistory,
	useSabHistoryAction,
	useSabOverview,
} from "../lib/sabnzbd-model";

export function SabnzbdActivityClient() {
	const [incognito] = useIncognitoMode();
	const {
		data: overview,
		isLoading: overviewLoading,
		isError: overviewError,
		refetch: refetchOverview,
	} = useSabOverview();
	const [selected, setSelected] = useState("");
	const [actionFeedback, setActionFeedback] = useState<string | null>(null);
	const [start, setStart] = useState(0);
	const activeId = selected || overview?.instances[0]?.id || "";
	const { data, isLoading, isError, isFetching, refetch } = useSabHistory(activeId, start);
	const active = overview?.instances.find((instance) => instance.id === activeId);
	const historyAction = useSabHistoryAction();
	const performHistoryAction = async (nzoId: string, action: "retry" | "remove") => {
		try {
			const result = (await historyAction.mutateAsync({
				instanceId: activeId,
				nzoId,
				action,
			})) as SabActionResult;
			setActionFeedback(result.message);
		} catch {
			setActionFeedback(
				"The history command outcome could not be confirmed. Refresh history before acting again; the command was not replayed.",
			);
		}
	};

	return (
		<PageLayout>
			<div className="space-y-6">
				<PremiumPageHeader
					label="Download client"
					labelIcon={History}
					title="SABnzbd history"
					description="Review paginated provider history. Failed jobs are not retried automatically."
				/>
				<div className="flex flex-wrap items-center gap-3">
					{overview?.instances.length ? (
						<label className="flex items-center gap-2 text-sm">
							Instance
							<select
								className="h-10 rounded-xl border border-border bg-background px-3"
								value={activeId}
								onChange={(event) => {
									setSelected(event.target.value);
									setStart(0);
								}}
							>
								{overview.instances.map((item) => (
									<option key={item.id} value={item.id}>
										{incognito ? getLinuxInstanceName(item.label) : item.label}
									</option>
								))}
							</select>
						</label>
					) : null}
					<Link
						className="inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-sm hover:bg-muted/50"
						href="/sabnzbd"
					>
						<ArrowLeft className="h-4 w-4" />
						Queue
					</Link>
				</div>
				{actionFeedback ? (
					<p role="status" aria-live="polite" className="text-sm text-muted-foreground">
						{actionFeedback}
					</p>
				) : null}
				{overviewError || isError ? (
					<Alert variant="danger" role="alert">
						<AlertCircle className="h-4 w-4" />
						<AlertDescription className="flex items-center justify-between gap-3">
							<span>
								History could not be verified.{data ? " Showing the last successful page." : ""}
							</span>
							<Button
								variant="secondary"
								size="sm"
								disabled={isFetching || overviewLoading}
								onClick={() => {
									void refetchOverview();
									void refetch();
								}}
							>
								<RefreshCw className="h-4 w-4" />
								Retry
							</Button>
						</AlertDescription>
					</Alert>
				) : null}
				{overviewLoading || isLoading ? (
					<GlassmorphicCard>
						<div className="p-6 text-sm text-muted-foreground">Loading history…</div>
					</GlassmorphicCard>
				) : null}
				{!overviewLoading && !overviewError && overview?.configured === false ? (
					<PremiumEmptyState
						icon={History}
						title="No SABnzbd instance configured"
						description="Add an instance under Settings → Services."
					/>
				) : null}
				{!overviewLoading && !active && overview?.configured ? (
					<GlassmorphicCard>
						<div className="p-5 text-sm text-muted-foreground">
							Select an enabled SABnzbd instance to view its history.
						</div>
					</GlassmorphicCard>
				) : null}
				{active && data ? (
					<GlassmorphicCard>
						<div className="space-y-4 p-5">
							<div className="flex flex-wrap items-start justify-between gap-2">
								<div>
									<h2 className="text-lg font-semibold">
										{incognito ? getLinuxInstanceName(active.label) : active.label}
									</h2>
									<p className="text-sm text-muted-foreground">
										Showing {data.items.length} of {data.total} records · {data.coverage} coverage
									</p>
								</div>
							</div>
							{data.items.length === 0 ? (
								<p className="py-6 text-center text-sm text-muted-foreground">
									No records on this page.
								</p>
							) : (
								<div className="space-y-2">
									{data.items.map((item) => (
										<article key={item.nzoId} className="rounded-xl border border-border/50 p-4">
											<div className="flex flex-wrap items-start justify-between gap-2">
												<div className="min-w-0">
													<h3 className="truncate font-medium">
														{incognito ? getLinuxIsoName(item.name) : item.name}
													</h3>
													<p className="text-sm text-muted-foreground">
														{item.status}
														{item.category ? ` · ${incognito ? "category" : item.category}` : ""}
													</p>
												</div>
												<time className="text-xs text-muted-foreground">
													{item.completedAt
														? new Date(item.completedAt).toLocaleString()
														: "Completion time unavailable"}
												</time>
											</div>
											{item.failMessage ? (
												<p className="mt-2 text-sm text-amber-300">
													{incognito ? getLinuxIsoName(item.failMessage) : item.failMessage}
												</p>
											) : null}

											<div className="mt-3 flex flex-wrap gap-2">
												{item.status.toLowerCase().includes("fail") ? (
													<Button
														variant="secondary"
														size="sm"
														disabled={historyAction.isPending}
														onClick={() => {
															if (
																confirm(
																	`Retry ${incognito ? "this failed item" : getLinuxIsoName(item.name)} once in SABnzbd?`,
																)
															)
																void performHistoryAction(item.nzoId, "retry");
														}}
													>
														Retry failed item
													</Button>
												) : null}
												<Button
													variant="danger"
													size="sm"
													disabled={historyAction.isPending}
													onClick={() => {
														if (
															confirm(
																"Remove this item from SABnzbd history? Downloaded files are not requested for deletion.",
															)
														)
															void performHistoryAction(item.nzoId, "remove");
													}}
												>
													Remove from history
												</Button>
											</div>
										</article>
									))}
								</div>
							)}
							<div className="flex items-center justify-between border-t border-border/50 pt-4">
								<Button
									variant="secondary"
									disabled={start === 0 || isFetching}
									onClick={() => setStart(Math.max(0, start - 20))}
								>
									<ArrowLeft className="h-4 w-4" />
									Previous
								</Button>
								<span className="text-xs text-muted-foreground">
									Page {Math.floor(start / 20) + 1}
								</span>
								<Button
									variant="secondary"
									disabled={isFetching || start + data.items.length >= data.total}
									onClick={() => setStart(start + 20)}
								>
									Next
									<ArrowRight className="h-4 w-4" />
								</Button>
							</div>
						</div>
					</GlassmorphicCard>
				) : null}
			</div>
		</PageLayout>
	);
}
