"use client";

import type { SeerrRequest } from "@arr/shared";
import {
	AlertTriangle,
	Bell,
	ClipboardList,
	History,
	Inbox,
	RefreshCw,
	Users,
	WifiOff,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	PremiumEmptyState,
	PremiumPageHeader,
	PremiumPageLoading,
	type PremiumTab,
	PremiumTabs,
} from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useApproveSeerrRequest,
	useClearSeerrCache,
	useDeclineSeerrRequest,
	useDeleteSeerrRequest,
	useRetrySeerrRequest,
	useSeerrRequestCount,
	useSeerrStatus,
} from "../../../hooks/api/useSeerr";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useSeerrInstances } from "../hooks/use-seerr-instances";
import { notifySeerrActionError } from "../lib/seerr-action-error";
import { isSeerrCircuitBreakerError } from "../lib/seerr-utils";
import { ApprovalQueueTab } from "./approval-queue-tab";
import { InstanceSelector } from "./instance-selector";
import { IssuesTab } from "./issues-tab";
import { NotificationsTab } from "./notifications-tab";
import { RequestsHistoryTab } from "./requests-history-tab";
import { UsersTab } from "./users-tab";

const RequestDetailModal = lazy(() =>
	import("./request-detail-modal").then((m) => ({ default: m.RequestDetailModal })),
);

const ApproveWithOptionsDialog = lazy(() =>
	import("./approve-with-options-dialog").then((m) => ({
		default: m.ApproveWithOptionsDialog,
	})),
);

const AuditLogTab = lazy(() => import("./audit-log-tab").then((m) => ({ default: m.AuditLogTab })));

export type RequestsTab = "approval" | "all" | "users" | "issues" | "notifications" | "history";

interface RequestSelection {
	instanceId: string;
	request: SeerrRequest;
}

export const RequestsClient = () => {
	const { gradient: _themeGradient } = useThemeGradient();
	const {
		seerrInstances,
		defaultInstance,
		isLoading,
		error: instancesError,
		hasFailedInitialRead,
		isFetching: isFetchingInstances,
		refetch: refetchInstances,
	} = useSeerrInstances();
	const hasConnectionError = !!instancesError || hasFailedInitialRead;
	const [activeTab, setActiveTab] = useState<RequestsTab>("approval");
	const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
	const [selectedRequest, setSelectedRequest] = useState<RequestSelection | null>(null);
	const [approveOptionsRequest, setApproveOptionsRequest] = useState<RequestSelection | null>(null);

	// Deep-link: ?tab=<id> pre-selects a tab, ?user=<id> pre-selects requester filter on "All Requests" tab
	const searchParams = useSearchParams();
	const deepLinkTab = searchParams.get("tab") as RequestsTab | null;
	const deepLinkUserId = searchParams.get("user");
	const [initialUserFilter, setInitialUserFilter] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (
			deepLinkTab &&
			["approval", "all", "users", "issues", "notifications", "history"].includes(deepLinkTab)
		) {
			setActiveTab(deepLinkTab);
		}
		if (deepLinkUserId) {
			const parsed = Number(deepLinkUserId);
			if (Number.isInteger(parsed) && parsed > 0) {
				setInitialUserFilter(deepLinkUserId);
				setActiveTab("all");
			}
		} else {
			setInitialUserFilter(undefined);
		}
	}, [deepLinkTab, deepLinkUserId]);

	// Resolve current instance
	const currentInstanceId = selectedInstanceId ?? defaultInstance?.id ?? "";
	const currentInstance = seerrInstances.find((s) => s.id === currentInstanceId) ?? null;
	const enabledInstanceId = currentInstance?.id;
	const activeRequest = selectedRequest?.instanceId === enabledInstanceId ? selectedRequest : null;
	const activeOptions =
		approveOptionsRequest?.instanceId === enabledInstanceId ? approveOptionsRequest : null;

	useEffect(() => {
		setSelectedRequest((selection) =>
			selection?.instanceId === enabledInstanceId ? selection : null,
		);
		setApproveOptionsRequest((selection) =>
			selection?.instanceId === enabledInstanceId ? selection : null,
		);
	}, [enabledInstanceId]);

	const openRequest = (request: SeerrRequest) =>
		setSelectedRequest({ instanceId: currentInstanceId, request });
	const openApprovalOptions = (request: SeerrRequest) =>
		setApproveOptionsRequest({ instanceId: currentInstanceId, request });
	const closeRequest = () =>
		setSelectedRequest((selection) => (selection === activeRequest ? null : selection));
	const closeApprovalOptions = () =>
		setApproveOptionsRequest((selection) => (selection === activeOptions ? null : selection));
	const closeCompletedRequest = (instanceId: string, requestId: number) => {
		const keepOtherSelection = (selection: RequestSelection | null) =>
			selection?.instanceId === instanceId && selection.request.id === requestId ? null : selection;
		setSelectedRequest(keepOtherSelection);
		setApproveOptionsRequest(keepOtherSelection);
	};

	// Fetch request counts for badge
	const {
		data: counts,
		refetch: refetchCounts,
		error: countsError,
	} = useSeerrRequestCount(currentInstanceId);
	const isCircuitBreakerError = isSeerrCircuitBreakerError(countsError);
	const { data: seerrStatus } = useSeerrStatus(currentInstanceId);

	// Mutation hooks for modal actions
	const approveMutation = useApproveSeerrRequest();
	const declineMutation = useDeclineSeerrRequest();
	const deleteMutation = useDeleteSeerrRequest();
	const retryMutation = useRetrySeerrRequest();
	const clearCacheMutation = useClearSeerrCache();

	if (isLoading && !hasConnectionError) {
		return <PremiumPageLoading showHeader cardCount={4} />;
	}

	const connectionNotice = hasConnectionError && (
		<div
			role="alert"
			aria-busy={isFetchingInstances}
			className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/50 bg-warning/10 p-4 text-sm text-warning"
		>
			<p>
				{seerrInstances.length > 0
					? "Seerr connections could not be verified. Showing last-known connections; availability may have changed."
					: "Unable to verify Seerr connections. Retry to check again."}
			</p>
			<Button
				variant="secondary"
				onClick={() => void refetchInstances()}
				disabled={isFetchingInstances}
				className="gap-2"
			>
				<RefreshCw className={`h-4 w-4${isFetchingInstances ? " animate-spin" : ""}`} />
				Retry
			</Button>
		</div>
	);

	// Only a successful connection read can confirm an empty configuration.
	if (seerrInstances.length === 0) {
		return (
			<>
				<PremiumPageHeader
					label="Request Management"
					labelIcon={Inbox}
					title="Requests"
					gradientTitle
					description="Manage media requests from Seerr"
				/>
				<div
					className="animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
				>
					{hasConnectionError ? (
						connectionNotice
					) : (
						<PremiumEmptyState
							icon={Inbox}
							title="No Seerr Instances"
							description="Add a Seerr instance in Settings to manage media requests, user quotas, and notifications."
							action={
								<a href="/settings">
									<Button variant="secondary" className="gap-2 border-border/50 bg-card/50">
										Go to Settings
									</Button>
								</a>
							}
						/>
					)}
				</div>
			</>
		);
	}

	const tabs: PremiumTab[] = [
		{ id: "approval", label: "Approval Queue", icon: Inbox, badge: counts?.pending },
		{ id: "all", label: "All Requests", icon: ClipboardList },
		{ id: "users", label: "Users", icon: Users },
		{ id: "issues", label: "Issues", icon: AlertTriangle },
		{ id: "notifications", label: "Notifications", icon: Bell },
		{ id: "history", label: "History", icon: History },
	];

	return (
		<>
			<PremiumPageHeader
				label="Request Management"
				labelIcon={Inbox}
				title="Requests"
				gradientTitle
				description="Manage media requests, user quotas, and notifications from your Seerr instance"
				actions={
					<div className="flex items-center gap-3">
						{seerrStatus && (
							<div className="hidden sm:flex items-center gap-2 rounded-lg border border-border/30 bg-muted/10 px-3 py-1.5 text-xs text-muted-foreground">
								<span>v{seerrStatus.version}</span>
								{seerrStatus.updateAvailable && (
									<span className="rounded-md bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
										Update Available
										{seerrStatus.commitsBehind > 0 &&
											` (${seerrStatus.commitsBehind} commits behind)`}
									</span>
								)}
							</div>
						)}
						{seerrInstances.length > 1 && (
							<InstanceSelector
								instances={seerrInstances}
								selectedId={currentInstanceId}
								onSelect={setSelectedInstanceId}
							/>
						)}
						<Button
							variant="secondary"
							aria-label="Clear server-side cache"
							onClick={() => {
								clearCacheMutation.mutate(
									{ instanceId: currentInstanceId },
									{
										onSuccess: (result) =>
											toast.success(
												result.cleared > 0
													? `Cleared ${result.cleared} cached item${result.cleared !== 1 ? "s" : ""}`
													: "Cache already empty",
											),
										onError: () => toast.error("Failed to clear cache"),
									},
								);
							}}
							disabled={clearCacheMutation.isPending}
							className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80 hidden sm:flex"
							title="Clear server-side cache (genres, issue counts)"
						>
							{clearCacheMutation.isPending ? (
								<RefreshCw className="h-4 w-4 animate-spin" />
							) : (
								<RefreshCw className="h-4 w-4" />
							)}
							<span className="hidden lg:inline">Clear Cache</span>
						</Button>
						<Button
							variant="secondary"
							onClick={() => void refetchCounts()}
							className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80"
						>
							<RefreshCw className="h-4 w-4" />
							Refresh
						</Button>
					</div>
				}
			/>

			{connectionNotice}

			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
			>
				<PremiumTabs
					tabs={tabs}
					activeTab={activeTab}
					onTabChange={(tabId) => setActiveTab(tabId as RequestsTab)}
				/>
			</div>

			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
			>
				{currentInstance && isCircuitBreakerError ? (
					<PremiumEmptyState
						icon={WifiOff}
						title="Seerr Instance Unreachable"
						description="The circuit breaker has opened because the Seerr instance is not responding. The dashboard will retry automatically."
					/>
				) : currentInstance ? (
					<>
						{activeTab === "approval" && (
							<ApprovalQueueTab
								instanceId={currentInstanceId}
								onSelectRequest={openRequest}
								onOpenApproveOptions={openApprovalOptions}
							/>
						)}
						{activeTab === "all" && (
							<RequestsHistoryTab
								instanceId={currentInstanceId}
								onSelectRequest={openRequest}
								initialUserFilter={initialUserFilter}
							/>
						)}
						{activeTab === "users" && (
							<UsersTab key={currentInstanceId} instanceId={currentInstanceId} />
						)}
						{activeTab === "issues" && <IssuesTab instanceId={currentInstanceId} />}
						{activeTab === "notifications" && <NotificationsTab instanceId={currentInstanceId} />}
						{activeTab === "history" && (
							<Suspense>
								<AuditLogTab instanceId={currentInstanceId} />
							</Suspense>
						)}
					</>
				) : null}
			</div>

			{/* Detail modal — lazy loaded on first click */}
			{activeRequest && (
				<Suspense>
					<RequestDetailModal
						request={activeRequest.request}
						instanceId={activeRequest.instanceId}
						onClose={closeRequest}
						onApprove={(requestId) =>
							approveMutation.mutate(
								{ instanceId: activeRequest.instanceId, requestId },
								{
									onSuccess: () => {
										toast.success("Request approved");
										closeCompletedRequest(activeRequest.instanceId, requestId);
									},
									onError: (error) => notifySeerrActionError(error, "Failed to approve request"),
								},
							)
						}
						onApproveWithOptions={(req) => {
							setApproveOptionsRequest({ instanceId: activeRequest.instanceId, request: req });
							closeRequest();
						}}
						onDecline={(requestId) =>
							declineMutation.mutate(
								{ instanceId: activeRequest.instanceId, requestId },
								{
									onSuccess: () => {
										toast.success("Request declined");
										closeCompletedRequest(activeRequest.instanceId, requestId);
									},
									onError: (error) => notifySeerrActionError(error, "Failed to decline request"),
								},
							)
						}
						onRetry={(requestId) =>
							retryMutation.mutate(
								{ instanceId: activeRequest.instanceId, requestId },
								{
									onSuccess: () => {
										toast.success("Request retried");
										closeCompletedRequest(activeRequest.instanceId, requestId);
									},
									onError: (error) => notifySeerrActionError(error, "Failed to retry request"),
								},
							)
						}
						onDelete={(requestId) =>
							deleteMutation.mutate(
								{ instanceId: activeRequest.instanceId, requestId },
								{
									onSuccess: () => {
										toast.success("Request deleted");
										closeCompletedRequest(activeRequest.instanceId, requestId);
									},
									onError: (error) => notifySeerrActionError(error, "Failed to delete request"),
								},
							)
						}
					/>
				</Suspense>
			)}

			{activeOptions && (
				<Suspense>
					<ApproveWithOptionsDialog
						request={activeOptions.request}
						instanceId={activeOptions.instanceId}
						open
						onOpenChange={(open) => {
							if (!open) closeApprovalOptions();
						}}
					/>
				</Suspense>
			)}
		</>
	);
};
