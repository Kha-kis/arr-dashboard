"use client";

import {
	Bell,
	Check,
	Loader2,
	Mail,
	Plus,
	Send,
	Settings2,
	TestTube,
	Trash2,
	X,
} from "lucide-react";
import { useState } from "react";
import {
	GlassmorphicCard,
	GradientButton,
	StatusBadge,
} from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import {
	useDeleteChannel,
	useNotificationChannels,
	useTestChannel,
} from "../../../hooks/api/useNotifications";
import type { NotificationChannel } from "../../../lib/api-client/notifications";
import { ChannelForm } from "./channel-form";
import { NotificationLogTable } from "./notification-log-table";
import { SubscriptionGrid as SubscriptionGridView } from "./subscription-grid";

type SubTab = "channels" | "subscriptions" | "logs";

const CHANNEL_TYPE_LABELS: Record<string, { label: string; icon: typeof Bell }> = {
	DISCORD: { label: "Discord", icon: Send },
	TELEGRAM: { label: "Telegram", icon: Send },
	EMAIL: { label: "Email", icon: Mail },
	BROWSER_PUSH: { label: "Browser Push", icon: Bell },
	PUSHBULLET: { label: "Pushbullet", icon: Send },
	PUSHOVER: { label: "Pushover", icon: Send },
};

export function NotificationsTab() {
	const { gradient } = useThemeGradient();
	const [subTab, setSubTab] = useState<SubTab>("channels");
	const [showForm, setShowForm] = useState(false);
	const [editingChannel, setEditingChannel] = useState<string | null>(null);

	const { data: channels = [], isLoading: channelsLoading } = useNotificationChannels();
	const deleteChannel = useDeleteChannel();
	const testChannel = useTestChannel();

	const subTabs: { id: SubTab; label: string }[] = [
		{ id: "channels", label: "Channels" },
		{ id: "subscriptions", label: "Events" },
		{ id: "logs", label: "Delivery Log" },
	];

	return (
		<div className="space-y-6">
			{/* Sub-tab navigation */}
			<div className="flex gap-2">
				{subTabs.map((tab) => (
					<button
						type="button"
						key={tab.id}
						onClick={() => setSubTab(tab.id)}
						className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
							subTab === tab.id
								? "text-white"
								: "text-muted-foreground hover:text-foreground bg-card/30"
						}`}
						style={subTab === tab.id ? { backgroundColor: gradient.from } : undefined}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Channels tab */}
			{subTab === "channels" && (
				<div className="space-y-4">
					<div className="flex items-center justify-between">
						<p className="text-sm text-muted-foreground">
							Configure notification channels to receive alerts about events.
						</p>
						<GradientButton
							onClick={() => {
								setEditingChannel(null);
								setShowForm(true);
							}}
						>
							<Plus className="mr-2 h-4 w-4" />
							Add Channel
						</GradientButton>
					</div>

					{showForm && (
						<GlassmorphicCard padding="md">
							<ChannelForm
								channelId={editingChannel}
								onSave={() => setShowForm(false)}
								onCancel={() => setShowForm(false)}
							/>
						</GlassmorphicCard>
					)}

					{channelsLoading ? (
						<div className="flex items-center justify-center py-12">
							<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
						</div>
					) : channels.length === 0 ? (
						<GlassmorphicCard padding="lg">
							<div className="text-center py-8">
								<Bell className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
								<p className="text-muted-foreground">No notification channels configured yet.</p>
							</div>
						</GlassmorphicCard>
					) : (
						<div className="space-y-3">
							{channels.map((channel, index) => (
								<ChannelRow
									key={channel.id}
									channel={channel}
									index={index}
									gradient={gradient}
									onEdit={() => {
										setEditingChannel(channel.id);
										setShowForm(true);
									}}
									onDelete={() => deleteChannel.mutate(channel.id)}
									onTest={() => testChannel.mutate(channel.id)}
									isDeleting={deleteChannel.isPending}
									isTesting={testChannel.isPending && testChannel.variables === channel.id}
									testResult={
										testChannel.isSuccess && testChannel.variables === channel.id
											? testChannel.data
											: undefined
									}
								/>
							))}
						</div>
					)}
				</div>
			)}

			{/* Subscriptions tab */}
			{subTab === "subscriptions" && <SubscriptionGridView />}

			{/* Logs tab */}
			{subTab === "logs" && <NotificationLogTable />}
		</div>
	);
}

function ChannelRow({
	channel,
	index,
	gradient,
	onEdit,
	onDelete,
	onTest,
	isDeleting,
	isTesting,
	testResult,
}: {
	channel: NotificationChannel;
	index: number;
	gradient: { from: string; fromLight: string };
	onEdit: () => void;
	onDelete: () => void;
	onTest: () => void;
	isDeleting: boolean;
	isTesting: boolean;
	testResult?: { success: boolean; error?: string };
}) {
	const typeInfo = CHANNEL_TYPE_LABELS[channel.type] ?? {
		label: channel.type,
		icon: Bell,
	};
	const Icon = typeInfo.icon;

	return (
		<GlassmorphicCard padding="sm">
			<div
				className="flex items-center gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300"
				style={{
					animationDelay: `${index * 30}ms`,
					animationFillMode: "backwards",
				}}
			>
				<div
					className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
					style={{ backgroundColor: gradient.fromLight }}
				>
					<Icon className="h-5 w-5" style={{ color: gradient.from }} />
				</div>

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="font-medium truncate">{channel.name}</span>
						<StatusBadge status={channel.enabled ? "success" : "warning"}>
							{channel.enabled ? "Active" : "Disabled"}
						</StatusBadge>
						<span className="text-xs text-muted-foreground">{typeInfo.label}</span>
					</div>
					{channel.lastTestedAt && (
						<p className="text-xs text-muted-foreground mt-0.5">
							Last tested: {new Date(channel.lastTestedAt).toLocaleDateString()}
							{channel.lastTestResult === "success" ? (
								<Check className="inline ml-1 h-3 w-3 text-emerald-400" />
							) : (
								<X className="inline ml-1 h-3 w-3 text-red-400" />
							)}
						</p>
					)}
				</div>

				<div className="flex items-center gap-2">
					{testResult && (
						<span className={`text-xs ${testResult.success ? "text-emerald-400" : "text-red-400"}`}>
							{testResult.success ? "Sent!" : testResult.error}
						</span>
					)}
					<button
						type="button"
						onClick={onTest}
						disabled={isTesting}
						className="rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-card/50 transition-colors"
						title="Send test notification"
					>
						{isTesting ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<TestTube className="h-4 w-4" />
						)}
					</button>
					<button
						type="button"
						onClick={onEdit}
						className="rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-card/50 transition-colors"
						title="Edit channel"
					>
						<Settings2 className="h-4 w-4" />
					</button>
					<button
						type="button"
						onClick={onDelete}
						disabled={isDeleting}
						className="rounded-md p-2 text-muted-foreground hover:text-red-400 hover:bg-card/50 transition-colors"
						title="Delete channel"
					>
						<Trash2 className="h-4 w-4" />
					</button>
				</div>
			</div>
		</GlassmorphicCard>
	);
}
