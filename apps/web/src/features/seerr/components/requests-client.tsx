"use client";

import { useState, lazy, Suspense } from "react";
import { Inbox, ClipboardList, Users, AlertTriangle, Bell, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { SeerrRequest } from "@arr/shared";
import { Button } from "../../../components/ui";
import {
	PremiumPageHeader,
	PremiumTabs,
	PremiumPageLoading,
	PremiumEmptyState,
	type PremiumTab,
} from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useSeerrInstances } from "../hooks/use-seerr-instances";
import {
	useSeerrRequestCount,
	useSeerrStatus,
	useApproveSeerrRequest,
	useDeclineSeerrRequest,
	useDeleteSeerrRequest,
	useRetrySeerrRequest,
} from "../../../hooks/api/useSeerr";
import { ApprovalQueueTab } from "./approval-queue-tab";
import { RequestsHistoryTab } from "./requests-history-tab";
import { UsersTab } from "./users-tab";
import { IssuesTab } from "./issues-tab";
import { NotificationsTab } from "./notifications-tab";
import { InstanceSelector } from "./instance-selector";

const RequestDetailModal = lazy(() =>
	import("./request-detail-modal").then((m) => ({ default: m.RequestDetailModal })),
);

export type RequestsTab = "approval" | "all" | "users" | "issues" | "notifications";

export const RequestsClient = () => {
	const { gradient: _themeGradient } = useThemeGradient();
	const { seerrInstances, defaultInstance, isLoading } = useSeerrInstances();
	const [activeTab, setActiveTab] = useState<RequestsTab>("approval");
	const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
	const [selectedRequest, setSelectedRequest] = useState<SeerrRequest | null>(null);

	// Resolve current instance
	const currentInstanceId = selectedInstanceId ?? defaultInstance?.id ?? "";
	const currentInstance = seerrInstances.find((s) => s.id === currentInstanceId) ?? null;

	// Fetch request counts for badge
	const { data: counts, refetch: refetchCounts } = useSeerrRequestCount(currentInstanceId);
	const { data: seerrStatus } = useSeerrStatus(currentInstanceId);

	// Mutation hooks for modal actions
	const approveMutation = useApproveSeerrRequest();
	const declineMutation = useDeclineSeerrRequest();
	const deleteMutation = useDeleteSeerrRequest();
	const retryMutation = useRetrySeerrRequest();

	if (isLoading) {
		return <PremiumPageLoading showHeader cardCount={4} />;
	}

	// No Seerr instances configured
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
							<div className="hidden sm:flex items-center gap-2 rounded-lg border border-border/50 bg-card/30 px-3 py-1.5 text-xs text-muted-foreground">
								<span>v{seerrStatus.version}</span>
								{seerrStatus.updateAvailable && (
									<span className="rounded-md bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
										Update Available{seerrStatus.commitsBehind > 0 && ` (${seerrStatus.commitsBehind} commits behind)`}
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
							onClick={() => void refetchCounts()}
							className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80"
						>
							<RefreshCw className="h-4 w-4" />
							Refresh
						</Button>
					</div>
				}
			/>

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
				{currentInstance && (
					<>
						{activeTab === "approval" && <ApprovalQueueTab instanceId={currentInstanceId} onSelectRequest={setSelectedRequest} />}
						{activeTab === "all" && <RequestsHistoryTab instanceId={currentInstanceId} onSelectRequest={setSelectedRequest} />}
						{activeTab === "users" && <UsersTab instanceId={currentInstanceId} />}
						{activeTab === "issues" && <IssuesTab instanceId={currentInstanceId} />}
						{activeTab === "notifications" && <NotificationsTab instanceId={currentInstanceId} />}
					</>
				)}
			</div>

			{/* Detail modal — lazy loaded on first click */}
			{selectedRequest && (
				<Suspense>
					<RequestDetailModal
						request={selectedRequest}
						instanceId={currentInstanceId}
						onClose={() => setSelectedRequest(null)}
						onApprove={(requestId) =>
							approveMutation.mutate(
								{ instanceId: currentInstanceId, requestId },
								{
									onSuccess: () => {
										toast.success("Request approved");
										setSelectedRequest(null);
									},
									onError: () => toast.error("Failed to approve request"),
								},
							)
						}
						onDecline={(requestId) =>
							declineMutation.mutate(
								{ instanceId: currentInstanceId, requestId },
								{
									onSuccess: () => {
										toast.success("Request declined");
										setSelectedRequest(null);
									},
									onError: () => toast.error("Failed to decline request"),
								},
							)
						}
						onRetry={(requestId) =>
							retryMutation.mutate(
								{ instanceId: currentInstanceId, requestId },
								{
									onSuccess: () => {
										toast.success("Request retried");
										setSelectedRequest(null);
									},
									onError: () => toast.error("Failed to retry request"),
								},
							)
						}
						onDelete={(requestId) =>
							deleteMutation.mutate(
								{ instanceId: currentInstanceId, requestId },
								{
									onSuccess: () => {
										toast.success("Request deleted");
										setSelectedRequest(null);
									},
									onError: () => toast.error("Failed to delete request"),
								},
							)
						}
					/>
				</Suspense>
			)}
		</>
	);
};
