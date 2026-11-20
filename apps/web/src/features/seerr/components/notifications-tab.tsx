"use client";

import type { SeerrNotificationAgent } from "@arr/shared";
import { AlertCircle, Bell, Send, Settings, ToggleLeft, ToggleRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { GradientButton, PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useSeerrNotifications,
	useTestSeerrNotification,
	useUpdateSeerrNotification,
} from "../../../hooks/api/useSeerr";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { AGENT_FIELDS } from "../lib/notification-agent-fields";
import { notifySeerrActionError } from "../lib/seerr-action-error";
import { AgentConfigDialog } from "./agent-config-dialog";

const SEERR_GRADIENT = SERVICE_GRADIENTS.seerr;

interface NotificationsTabProps {
	instanceId: string;
}

export const NotificationsTab = ({ instanceId }: NotificationsTabProps) => {
	const { data, isLoading, isError, isFetching, refetch } = useSeerrNotifications(instanceId);
	const updateMutation = useUpdateSeerrNotification();
	const testMutation = useTestSeerrNotification();
	const [configuringAgent, setConfiguringAgent] = useState<SeerrNotificationAgent | null>(null);

	if (isLoading) {
		return (
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				{Array.from({ length: 4 }).map((_, i) => (
					<PremiumSkeleton key={i} className="h-24 w-full rounded-xl" />
				))}
			</div>
		);
	}

	const agents = data?.agents ?? [];
	const retry = (
		<Button onClick={() => void refetch()} disabled={isFetching}>
			Retry
		</Button>
	);

	if (!data || (data.coverage === "unavailable" && !isError)) {
		return (
			<div className="space-y-3">
				<PremiumEmptyState
					icon={AlertCircle}
					title="Notification agents unavailable"
					description="Notification settings could not be verified. Retry to read the current configuration."
				/>
				<div className="flex justify-center">{retry}</div>
			</div>
		);
	}

	if (agents.length === 0 && !isError) {
		return (
			<PremiumEmptyState
				icon={Bell}
				title="No supported notification agents"
				description="This Seerr instance does not support any known notification agents."
			/>
		);
	}

	return (
		<>
			{isError || data.coverage === "partial" ? (
				<div
					role="alert"
					className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 p-4"
				>
					<div>
						<p className="font-medium">
							{isError
								? "Last-known notification settings"
								: "Some notification agents are unavailable"}
						</p>
						<p className="text-sm text-muted-foreground">
							{isError
								? "The latest read failed. Actions are disabled until settings can be verified again."
								: `${data.unavailableAgents.map((agent) => agent.name).join(", ")} could not be verified. Available agents remain usable.`}
						</p>
					</div>
					{retry}
				</div>
			) : null}
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				{agents.map((agent, index) => {
					const ToggleIcon = agent.enabled ? ToggleRight : ToggleLeft;
					const hasFields = !!AGENT_FIELDS[agent.id];
					const accent = agent.enabled
						? SEMANTIC_COLORS.success
						: { from: "#6b7280", to: "#9ca3af" };

					return (
						<div
							key={agent.id}
							className="group relative rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-[1px] hover:shadow-lg hover:shadow-black/10 animate-in fade-in slide-in-from-bottom-1 duration-300"
							style={{
								border: `1px solid ${SEERR_GRADIENT.from}10`,
								animationDelay: `${index * 50}ms`,
								animationFillMode: "backwards",
							}}
						>
							{/* Background gradient */}
							<div
								className="absolute inset-0 pointer-events-none"
								style={{
									background: `linear-gradient(135deg, ${accent.from}04, transparent 60%)`,
								}}
							/>

							{/* Hover glow */}
							<div
								className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200"
								style={{
									background: `radial-gradient(ellipse at top left, ${SEERR_GRADIENT.from}06, transparent 50%)`,
								}}
							/>

							{/* Accent bar */}
							<div
								className="absolute left-0 top-0 bottom-0 w-[3px]"
								style={{
									background: `linear-gradient(180deg, ${accent.from}, ${accent.to}70)`,
								}}
							/>

							<div className="relative flex items-center justify-between py-3.5 pl-5 pr-4">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2 mb-1">
										<span
											className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0"
											style={{
												backgroundColor: `${SEERR_GRADIENT.from}12`,
												color: SEERR_GRADIENT.from,
											}}
										>
											<Bell className="h-2.5 w-2.5" />
											Agent
										</span>
										<span
											className="h-[5px] w-[5px] rounded-full shrink-0"
											style={{
												backgroundColor: agent.enabled ? SEMANTIC_COLORS.success.text : "#6b7280",
											}}
										/>
										<span className="text-[11px] text-muted-foreground/40">
											{agent.enabled ? "Active" : "Inactive"}
										</span>
									</div>
									<h3 className="truncate text-[14px] font-semibold text-foreground leading-snug">
										{agent.name}
									</h3>
								</div>

								<div className="flex items-center gap-2 shrink-0">
									{hasFields && (
										<Button
											variant="secondary"
											size="sm"
											onClick={() => setConfiguringAgent(agent)}
											disabled={isError}
											className="gap-1.5 border-border/50 bg-card/50 text-xs opacity-0 group-hover:opacity-100 transition-opacity duration-200"
										>
											<Settings className="h-3 w-3" />
											Configure
										</Button>
									)}
									{agent.enabled && (
										<Button
											variant="secondary"
											size="sm"
											disabled={isError || testMutation.isPending}
											onClick={() =>
												testMutation.mutate(
													{ instanceId, agentId: String(agent.id) },
													{
														onSuccess: () => toast.success("Test notification sent"),
														onError: (error) =>
															notifySeerrActionError(error, "Test notification failed"),
													},
												)
											}
											className="gap-1.5 border-border/50 bg-card/50 text-xs"
										>
											<Send className="h-3 w-3" />
											Test
										</Button>
									)}
									<GradientButton
										size="sm"
										variant={agent.enabled ? "secondary" : "primary"}
										icon={ToggleIcon}
										disabled={isError || updateMutation.isPending}
										onClick={() =>
											updateMutation.mutate(
												{
													instanceId,
													agentId: String(agent.id),
													config: { enabled: !agent.enabled },
												},
												{
													onSuccess: () =>
														toast.success(agent.enabled ? "Agent disabled" : "Agent enabled"),
													onError: (error) =>
														notifySeerrActionError(error, "Failed to update agent"),
												},
											)
										}
									>
										{agent.enabled ? "Disable" : "Enable"}
									</GradientButton>
								</div>
							</div>
						</div>
					);
				})}
			</div>

			<AgentConfigDialog
				agent={isError ? null : (agents.find((agent) => agent.id === configuringAgent?.id) ?? null)}
				instanceId={instanceId}
				open={!isError && !!configuringAgent}
				onOpenChange={(open) => {
					if (!open) setConfiguringAgent(null);
				}}
			/>
		</>
	);
};
