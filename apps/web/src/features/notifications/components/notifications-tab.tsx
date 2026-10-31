"use client";

import {
	type NotificationTestResult,
	notificationFailureCategorySchema,
	notificationFailureMessage,
} from "@arr/shared";

import {
	Bell,
	Check,
	Globe,
	Hash,
	Loader2,
	Mail,
	Plus,
	Send,
	Server,
	Settings2,
	TestTube,
	Trash2,
	X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
	DomainStatusBadge,
	deriveNotificationChannelStatus,
	GradientButton,
} from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import {
	useChannelTypes,
	useDeleteChannel,
	useNotificationChannels,
	useTestChannel,
} from "../../../hooks/api/useNotifications";
import { ApiError } from "../../../lib/api-client/base";
import {
	type NotificationChannel,
	NotificationChannelDeleteUnverifiedError,
} from "../../../lib/api-client/notifications";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import { ChannelForm } from "./channel-form";
import { NotificationLogTable } from "./notification-log-table";
import { SubscriptionGrid as SubscriptionGridView } from "./subscription-grid";

const NotificationRulesTab = lazy(() =>
	import("./notification-rules-tab").then((m) => ({ default: m.NotificationRulesTab })),
);
const NotificationStatistics = lazy(() =>
	import("./notification-statistics").then((m) => ({ default: m.NotificationStatistics })),
);
const BrowserPushCard = lazy(() =>
	import("./browser-push-card").then((m) => ({ default: m.BrowserPushCard })),
);
const AggregationConfig = lazy(() =>
	import("./aggregation-config").then((m) => ({ default: m.AggregationConfig })),
);

type SubTab = "channels" | "subscriptions" | "logs" | "rules" | "statistics";

const ICON_MAP: Record<string, typeof Bell> = {
	Bell,
	Globe,
	Hash,
	Mail,
	Send,
	Server,
};

const UNVERIFIED_TEST_GUIDANCE =
	"Test outcome was not confirmed. The request may have completed. Check provider delivery and saved Test status before another Test.";
const TEST_STATUS_UNSAVED =
	"Test status was not saved for the current settings. Review current settings before testing again.";

const UNVERIFIED_DELETE_GUIDANCE =
	"Deletion outcome could not be verified. The channel may have been deleted. Recheck the channel list before a new deletion; the previous outcome remains unverified.";
const REJECTED_DELETE_GUIDANCE =
	"Channel could not be deleted. Review the current channel list before trying a new confirmation.";

function testErrorGuidance(error: unknown): { message: string; statusUnsaved: boolean } {
	if (
		!(error instanceof ApiError) ||
		error.status !== 400 ||
		typeof error.payload !== "object" ||
		error.payload === null
	) {
		return { message: UNVERIFIED_TEST_GUIDANCE, statusUnsaved: false };
	}
	const category = notificationFailureCategorySchema.safeParse(
		"failureCategory" in error.payload ? error.payload.failureCategory : undefined,
	);
	return {
		message:
			category.success && category.data !== "unknown"
				? notificationFailureMessage(category.data)
				: UNVERIFIED_TEST_GUIDANCE,
		statusUnsaved: "statusRecorded" in error.payload && error.payload.statusRecorded === false,
	};
}

export function NotificationsTab() {
	const { gradient } = useThemeGradient();
	const [subTab, setSubTab] = useState<SubTab>("channels");
	const [showForm, setShowForm] = useState(false);
	const [editingChannel, setEditingChannel] = useState<string | null>(null);

	const {
		data: channelsData,
		isLoading: channelsLoading,
		isError: channelsError,
		isFetching: channelsFetching,
		refetch: refetchChannels,
	} = useNotificationChannels();
	const channels = channelsData ?? [];
	const { data: channelTypes = [] } = useChannelTypes();
	const deleteChannel = useDeleteChannel();
	const testChannel = useTestChannel();
	const testingChannel = useRef<string | null>(null);
	const [deleteFeedback, setDeleteFeedback] = useState<Record<string, "unverified" | "rejected">>(
		{},
	);
	const [reviewingDelete, setReviewingDelete] = useState(false);
	const [deleteReviewError, setDeleteReviewError] = useState(false);
	const deleteBlocked = useRef(new Set<string>());
	const deletePending = useRef(false);
	const deleteReviewPending = useRef(false);
	const deleteAttemptSequence = useRef(0);
	const deleteReviewSequence = useRef(0);
	const mounted = useRef(true);

	useEffect(() => {
		const reviewSequence = deleteReviewSequence;
		mounted.current = true;
		return () => {
			mounted.current = false;
			reviewSequence.current++;
		};
	}, []);

	const handleDeleteChannel = async (id: string) => {
		if (deletePending.current || deleteReviewPending.current || deleteBlocked.current.has(id))
			return;
		deletePending.current = true;
		const attempt = ++deleteAttemptSequence.current;
		deleteReviewSequence.current++;
		setDeleteReviewError(false);
		try {
			await deleteChannel.mutateAsync(id);
			if (mounted.current && attempt === deleteAttemptSequence.current) {
				setDeleteFeedback((previous) => {
					const next = { ...previous };
					delete next[id];
					return next;
				});
			}
		} catch (error) {
			if (mounted.current && attempt === deleteAttemptSequence.current) {
				const unverified = error instanceof NotificationChannelDeleteUnverifiedError;
				if (unverified) deleteBlocked.current.add(id);
				setDeleteFeedback((previous) => ({
					...previous,
					[id]: unverified ? "unverified" : "rejected",
				}));
			}
		} finally {
			deletePending.current = false;
		}
	};

	const recheckDeletedChannels = async () => {
		if (deletePending.current || deleteReviewPending.current) return;
		deleteReviewPending.current = true;
		const review = ++deleteReviewSequence.current;
		const attempt = deleteAttemptSequence.current;
		setReviewingDelete(true);
		setDeleteReviewError(false);
		try {
			await deleteChannel.recheckChannels();
			if (
				mounted.current &&
				review === deleteReviewSequence.current &&
				attempt === deleteAttemptSequence.current
			) {
				deleteBlocked.current.clear();
				// Keep prior uncertainty visible. A fresh list permits only a new manual
				// two-step action; it does not certify the previous mutation's outcome.
			}
		} catch {
			if (mounted.current && review === deleteReviewSequence.current) setDeleteReviewError(true);
		} finally {
			deleteReviewPending.current = false;
			if (mounted.current && review === deleteReviewSequence.current) setReviewingDelete(false);
		}
	};
	const hasUnverifiedDelete = Object.values(deleteFeedback).includes("unverified");

	const channelTypeLookup = useMemo(() => {
		const map: Record<string, { label: string; icon: typeof Bell }> = {};
		for (const ct of channelTypes) {
			map[ct.type] = { label: ct.label, icon: ICON_MAP[ct.icon] ?? Bell };
		}
		return map;
	}, [channelTypes]);

	const subTabs: { id: SubTab; label: string }[] = [
		{ id: "channels", label: "Channels" },
		{ id: "subscriptions", label: "Events" },
		{ id: "logs", label: "Delivery Log" },
		{ id: "rules", label: "Rules" },
		{ id: "statistics", label: "Statistics" },
	];

	const lazyFallback = (
		<div className="flex items-center justify-center py-12">
			<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
		</div>
	);

	return (
		<div className="space-y-6">
			{/* Sub-tab navigation */}
			<div className="flex flex-wrap gap-2">
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
					<Suspense fallback={null}>
						<BrowserPushCard />
					</Suspense>

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
						<div className="rounded-xl border border-border/30 bg-muted/10 p-4">
							<ChannelForm
								channelId={editingChannel}
								onSave={() => setShowForm(false)}
								onSaved={(channelId) => {
									// An older save must not discard a newer Test of another channel.
									if (channelId !== null && testingChannel.current === channelId) {
										testingChannel.current = null;
										testChannel.reset();
									}
								}}
								onCancel={() => setShowForm(false)}
							/>
						</div>
					)}

					{Object.keys(deleteFeedback).length > 0 && (
						<div role="alert" className="space-y-2 rounded-xl border border-border/30 p-4">
							<p className="text-sm">
								{hasUnverifiedDelete ? UNVERIFIED_DELETE_GUIDANCE : REJECTED_DELETE_GUIDANCE}
							</p>
							{hasUnverifiedDelete && (
								<button
									type="button"
									onClick={() => void recheckDeletedChannels()}
									disabled={reviewingDelete || deleteChannel.isPending}
									className="text-sm underline hover:text-foreground disabled:opacity-50"
								>
									{reviewingDelete ? "Rechecking channel list..." : "Recheck channel list"}
								</button>
							)}
							{deleteReviewError && (
								<p className="text-sm">
									Current channels could not be verified. Deletion remains locked; recheck again.
								</p>
							)}
						</div>
					)}

					{!channelsError && channelsFetching && !channelsLoading && (
						<p role="status" className="text-sm text-muted-foreground">
							Showing last-known notification channels; checking current settings.
						</p>
					)}
					{channelsError && (
						<div role="alert" className="space-y-2 rounded-xl border border-border/30 p-4">
							<p className="text-sm">
								{channelsData !== undefined
									? "Showing last-known notification channels; refresh failed."
									: "Couldn't load notification channels. Configured channels have not been verified."}
							</p>
							<GradientButton onClick={() => void refetchChannels()} disabled={channelsFetching}>
								Retry notification channels
							</GradientButton>
						</div>
					)}

					{channelsLoading ? (
						<div
							role="status"
							aria-label="Loading notification channels"
							className="flex items-center justify-center py-12"
						>
							<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
						</div>
					) : channels.length === 0 &&
						(channelsError || channelsFetching) ? null : channels.length === 0 ? (
						<div className="rounded-xl border border-border/30 bg-muted/10 p-6">
							<div className="text-center py-8">
								<Bell className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
								<p className="text-muted-foreground">No notification channels configured yet.</p>
							</div>
						</div>
					) : (
						<div className="space-y-3">
							{channels.map((channel, index) => (
								<ChannelRow
									key={channel.id}
									channel={channel}
									index={index}
									gradient={gradient}
									channelTypeLookup={channelTypeLookup}
									onEdit={() => {
										setEditingChannel(channel.id);
										setShowForm(true);
									}}
									onDelete={() => void handleDeleteChannel(channel.id)}
									onTest={() => {
										testingChannel.current = channel.id;
										testChannel.mutate(channel.id);
									}}
									isDeleting={
										deleteChannel.isPending ||
										reviewingDelete ||
										deleteBlocked.current.has(channel.id)
									}
									isTesting={testChannel.isPending && testChannel.variables === channel.id}
									isTestError={testChannel.isError && testChannel.variables === channel.id}
									testError={testChannel.variables === channel.id ? testChannel.error : undefined}
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

			{/* Rules tab */}
			{subTab === "rules" && (
				<div className="space-y-8">
					<Suspense fallback={lazyFallback}>
						<NotificationRulesTab />
					</Suspense>
					<Suspense fallback={null}>
						<AggregationConfig />
					</Suspense>
				</div>
			)}

			{/* Statistics tab */}
			{subTab === "statistics" && (
				<Suspense fallback={lazyFallback}>
					<NotificationStatistics />
				</Suspense>
			)}
		</div>
	);
}

function ChannelRow({
	channel,
	index,
	gradient,
	channelTypeLookup,
	onEdit,
	onDelete,
	onTest,
	isDeleting,
	isTesting,
	isTestError,
	testError,
	testResult,
}: {
	channel: NotificationChannel;
	index: number;
	gradient: { from: string; fromLight: string };
	channelTypeLookup: Record<string, { label: string; icon: typeof Bell }>;
	onEdit: () => void;
	onDelete: () => void;
	onTest: () => void;
	isDeleting: boolean;
	isTesting: boolean;
	isTestError: boolean;
	testError?: unknown;
	testResult?: NotificationTestResult;
}) {
	const [incognitoMode] = useIncognitoMode();
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const failure = testErrorGuidance(testError);

	useEffect(() => {
		if (!confirmingDelete) return;
		const timer = setTimeout(() => setConfirmingDelete(false), 3000);
		return () => clearTimeout(timer);
	}, [confirmingDelete]);

	const handleDelete = () => {
		if (isDeleting) return;
		if (confirmingDelete) {
			onDelete();
			setConfirmingDelete(false);
		} else {
			setConfirmingDelete(true);
		}
	};

	const typeInfo = channelTypeLookup[channel.type] ?? {
		label: channel.type,
		icon: Bell,
	};
	const Icon = typeInfo.icon;

	return (
		<div className="rounded-xl border border-border/30 bg-muted/10 p-3">
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
						<span className="font-medium truncate">
							{incognitoMode ? getLinuxInstanceName(channel.name) : channel.name}
						</span>
						<DomainStatusBadge
							status={deriveNotificationChannelStatus({
								enabled: channel.enabled,
								lastTestedAt: channel.lastTestedAt,
								lastTestResult: channel.lastTestResult,
							})}
						/>
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
						onClick={handleDelete}
						disabled={isDeleting}
						className={`rounded-md p-2 text-muted-foreground hover:bg-card/50 transition-colors ${
							confirmingDelete ? "text-red-400" : "hover:text-red-400"
						}`}
						title={confirmingDelete ? "Click again to confirm delete" : "Delete channel"}
					>
						{confirmingDelete ? (
							<span className="text-xs font-medium">Confirm?</span>
						) : (
							<Trash2 className="h-4 w-4" />
						)}
					</button>
				</div>
			</div>
			{(isTestError || testResult) && (
				<fieldset className="mt-3 min-w-0 space-y-1 text-xs">
					<legend className="font-medium">Last test attempt</legend>
					<p className="text-muted-foreground">
						This result does not verify settings changed afterward.
					</p>
					{isTestError && (
						<span role="alert" className="text-muted-foreground">
							{failure.message} {failure.statusUnsaved ? TEST_STATUS_UNSAVED : null}
						</span>
					)}
					{testResult && (
						<span
							role={testResult.success ? "status" : "alert"}
							className={testResult.success ? "text-emerald-400" : "text-red-400"}
						>
							{testResult.success
								? testResult.statusRecorded
									? "Test passed."
									: "Test passed, but its status was not saved for the current settings. Do not repeat the test solely to save its status."
								: notificationFailureMessage(testResult.failureCategory)}
							{!testResult.success && !testResult.statusRecorded ? ` ${TEST_STATUS_UNSAVED}` : null}
						</span>
					)}
				</fieldset>
			)}
		</div>
	);
}
