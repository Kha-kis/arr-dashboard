"use client";

import { useState } from "react";
import { Inbox, ClipboardList, Users, AlertTriangle, Bell, RefreshCw } from "lucide-react";
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
import { useSeerrRequestCount } from "../../../hooks/api/useSeerr";
import { ApprovalQueueTab } from "./approval-queue-tab";
import { RequestsHistoryTab } from "./requests-history-tab";
import { UsersTab } from "./users-tab";
import { IssuesTab } from "./issues-tab";
import { NotificationsTab } from "./notifications-tab";
import { InstanceSelector } from "./instance-selector";

export type RequestsTab = "approval" | "all" | "users" | "issues" | "notifications";

export const RequestsClient = () => {
	const { gradient: _themeGradient } = useThemeGradient();
	const { seerrInstances, defaultInstance, isLoading } = useSeerrInstances();
	const [activeTab, setActiveTab] = useState<RequestsTab>("approval");
	const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

	// Resolve current instance
	const currentInstanceId = selectedInstanceId ?? defaultInstance?.id ?? "";
	const currentInstance = seerrInstances.find((s) => s.id === currentInstanceId) ?? null;

	// Fetch request counts for badge
	const { data: counts, refetch: refetchCounts } = useSeerrRequestCount(currentInstanceId);

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
						{activeTab === "approval" && <ApprovalQueueTab instanceId={currentInstanceId} />}
						{activeTab === "all" && <RequestsHistoryTab instanceId={currentInstanceId} />}
						{activeTab === "users" && <UsersTab instanceId={currentInstanceId} />}
						{activeTab === "issues" && <IssuesTab instanceId={currentInstanceId} />}
						{activeTab === "notifications" && <NotificationsTab instanceId={currentInstanceId} />}
					</>
				)}
			</div>
		</>
	);
};
