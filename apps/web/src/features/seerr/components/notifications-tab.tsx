"use client";

import { Bell, Send, ToggleLeft, ToggleRight } from "lucide-react";
import { GlassmorphicCard, PremiumEmptyState, PremiumSkeleton, GradientButton } from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useSeerrNotifications,
	useUpdateSeerrNotification,
	useTestSeerrNotification,
} from "../../../hooks/api/useSeerr";

interface NotificationsTabProps {
	instanceId: string;
}

export const NotificationsTab = ({ instanceId }: NotificationsTabProps) => {
	const { data, isLoading } = useSeerrNotifications(instanceId);
	const updateMutation = useUpdateSeerrNotification();
	const testMutation = useTestSeerrNotification();

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

	if (agents.length === 0) {
		return (
			<PremiumEmptyState
				icon={Bell}
				title="No Notification Agents"
				description="No notification agents configured in this Seerr instance."
			/>
		);
	}

	return (
		<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
			{agents.map((agent, index) => {
				const ToggleIcon = agent.enabled ? ToggleRight : ToggleLeft;

				return (
					<div
						key={agent.id}
						className="animate-in fade-in slide-in-from-bottom-2 duration-300"
						style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
					>
						<GlassmorphicCard padding="md">
							<div className="flex items-center justify-between">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<Bell className="h-4 w-4 text-muted-foreground" />
										<h3 className="truncate text-sm font-semibold text-foreground">
											{agent.name}
										</h3>
									</div>
									<p className="mt-1 text-xs text-muted-foreground">
										{agent.enabled ? "Enabled" : "Disabled"}
									</p>
								</div>

								<div className="flex items-center gap-2">
									{agent.enabled && (
										<Button
											variant="secondary"
											size="sm"
											disabled={testMutation.isPending}
											onClick={() => testMutation.mutate({ instanceId, agentId: String(agent.id) })}
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
										disabled={updateMutation.isPending}
										onClick={() =>
											updateMutation.mutate({
												instanceId,
												agentId: String(agent.id),
												config: { enabled: !agent.enabled },
											})
										}
									>
										{agent.enabled ? "Disable" : "Enable"}
									</GradientButton>
								</div>
							</div>
						</GlassmorphicCard>
					</div>
				);
			})}
		</div>
	);
};
