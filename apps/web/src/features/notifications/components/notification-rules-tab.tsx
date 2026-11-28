"use client";

import type { RuleCondition } from "@arr/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Loader2, Minus, Plus, Shield, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { AsyncStateView } from "@/components/layout/async-state-view";
import { GradientButton, StatusBadge } from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { INPUT_BASE_CLASSES } from "@/lib/theme-input-styles";
import {
	useCreateRule,
	useDeleteRule,
	useNotificationChannels,
	useNotificationRules,
	useUpdateRule,
} from "../../../hooks/api/useNotifications";
import {
	NotificationRuleDeleteUnverifiedError,
	type NotificationRuleResponse,
	NotificationRuleSaveUnverifiedError,
	notificationsApi,
} from "../../../lib/api-client/notifications";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import { notificationKeys } from "../../../lib/query-keys";
import {
	type ConditionDraft,
	createConditionDraft,
	NotificationRuleConditionEditor,
	serializeConditions,
} from "./notification-rule-condition-editor";

const ACTION_LABELS: Record<string, string> = {
	suppress: "Suppress",
	throttle: "Throttle",
	route: "Route to channels",
	quiet_hours: "Quiet Hours",
};

const ACTION_DESCRIPTIONS: Record<string, string> = {
	suppress: "Block matching notifications from being sent",
	throttle: "Limit how often matching notifications fire",
	route: "Send matching notifications to specific channels only",
	quiet_hours: "Silence notifications during a scheduled time window",
};

const UNVERIFIED_DELETE_GUIDANCE =
	"Rule deletion outcome could not be verified. The rule may have been deleted. Recheck the rule list before a new deletion; the previous outcome remains unverified.";
const REJECTED_DELETE_GUIDANCE =
	"Rule could not be deleted. Review the current rule list before trying a new confirmation.";
const UNVERIFIED_SAVE_GUIDANCE =
	"Rule save outcome could not be verified. The rule may have been saved. Review the current rule list before a new save or toggle; the previous outcome remains unverified.";

interface RuleFormData {
	name: string;
	action: "suppress" | "throttle" | "route" | "quiet_hours";
	conditions: ConditionDraft[];
	priority: number;
	throttleMinutes: number;
	targetChannelIds: string[];
	quietHoursStart: string;
	quietHoursEnd: string;
	quietHoursTimezone: string;
}

const EMPTY_CONDITION: RuleCondition = { field: "eventType", operator: "equals", value: "" };

const DEFAULT_FORM: Omit<RuleFormData, "conditions"> = {
	name: "",
	action: "suppress",
	priority: 0,
	throttleMinutes: 60,
	targetChannelIds: [],
	quietHoursStart: "22:00",
	quietHoursEnd: "08:00",
	quietHoursTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

function RuleErrorTitle({ detail, fallback }: { detail: string; fallback: string }) {
	const [incognitoMode] = useIncognitoMode();
	// Sonner can outlive this tab; project privacy from its own current context.
	return incognitoMode ? fallback : detail;
}

export function NotificationRulesTab() {
	const { gradient } = useThemeGradient();
	const queryClient = useQueryClient();
	const [incognitoMode, setIncognitoMode] = useIncognitoMode();
	const currentIncognito = useRef(incognitoMode);
	const formId = useId();
	const conditionSequence = useRef(1);
	const entrySequence = useRef(0);
	const nextEntryKey = () => entrySequence.current++;
	useEffect(() => {
		currentIncognito.current = incognitoMode;
	}, [incognitoMode]);
	const {
		data: rulesData,
		isLoading,
		isFetching,
		isError,
		error,
		refetch,
	} = useNotificationRules();
	const rules = rulesData ?? [];
	const hasRulesData = rulesData !== undefined;
	const { data: channels = [] } = useNotificationChannels();
	const createRule = useCreateRule();
	const updateRule = useUpdateRule();
	const deleteRule = useDeleteRule();

	const [showForm, setShowForm] = useState(false);
	const [editingRule, setEditingRule] = useState<NotificationRuleResponse | null>(null);
	const [formData, setFormData] = useState<RuleFormData>(() => ({
		...DEFAULT_FORM,
		conditions: [createConditionDraft(EMPTY_CONDITION, 0, () => 0, false)],
	}));
	const [conditionError, setConditionError] = useState(false);
	const [saveUnverified, setSaveUnverified] = useState(false);
	const [saveNeedsReview, setSaveNeedsReview] = useState(false);
	const [reviewingSave, setReviewingSave] = useState(false);
	const [saveReviewError, setSaveReviewError] = useState(false);
	const savePending = useRef(false);
	const saveBlocked = useRef(false);
	const saveReviewPending = useRef(false);
	const saveAttemptSequence = useRef(0);
	const saveReviewSequence = useRef(0);
	const editorSequence = useRef(0);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
		const confirmationTimer = confirmDeleteTimer;
		mounted.current = true;
		return () => {
			mounted.current = false;
			reviewSequence.current++;
			if (confirmationTimer.current !== undefined) clearTimeout(confirmationTimer.current);
		};
	}, []);

	const recheckDeletedRules = async () => {
		if (deletePending.current || deleteReviewPending.current) return;
		deleteReviewPending.current = true;
		const review = ++deleteReviewSequence.current;
		const attempt = deleteAttemptSequence.current;
		setReviewingDelete(true);
		setDeleteReviewError(false);
		try {
			await deleteRule.recheckRules();
			if (
				mounted.current &&
				review === deleteReviewSequence.current &&
				attempt === deleteAttemptSequence.current
			) {
				deleteBlocked.current.clear();
				// A current list permits only a new manual action, not a claim that
				// the earlier DELETE was acknowledged or should be replayed.
			}
		} catch {
			if (mounted.current && review === deleteReviewSequence.current) setDeleteReviewError(true);
		} finally {
			deleteReviewPending.current = false;
			if (mounted.current && review === deleteReviewSequence.current) setReviewingDelete(false);
		}
	};
	const hasUnverifiedDelete = Object.values(deleteFeedback).includes("unverified");
	const conditionDraft = (condition: RuleCondition, confirmed = true): ConditionDraft =>
		createConditionDraft(condition, conditionSequence.current++, nextEntryKey, confirmed);

	const advanceEditor = () => {
		editorSequence.current++;
		saveReviewSequence.current++;
		if (saveReviewPending.current) {
			// A review started for an older editor cannot authorize this draft.
			saveBlocked.current = true;
			setSaveNeedsReview(true);
		}
	};

	const reviewRuleSave = async () => {
		if (savePending.current || saveReviewPending.current) return;
		saveReviewPending.current = true;
		const review = ++saveReviewSequence.current;
		const attempt = saveAttemptSequence.current;
		const editor = editorSequence.current;
		setReviewingSave(true);
		setSaveReviewError(false);
		try {
			await queryClient.cancelQueries({ queryKey: notificationKeys.rules });
			await queryClient.fetchQuery({
				queryKey: notificationKeys.rules,
				staleTime: 0,
				retry: false,
				queryFn: () => notificationsApi.listRules(),
			});
			if (
				mounted.current &&
				review === saveReviewSequence.current &&
				attempt === saveAttemptSequence.current &&
				editor === editorSequence.current
			) {
				saveBlocked.current = false;
				setSaveNeedsReview(false);
				// Current rows permit only a new manual write, never retroactive
				// success or a replay of the prior uncertain operation.
			}
		} catch {
			if (mounted.current && review === saveReviewSequence.current) setSaveReviewError(true);
		} finally {
			saveReviewPending.current = false;
			if (mounted.current) setReviewingSave(false);
		}
	};

	const openCreate = () => {
		advanceEditor();
		setEditingRule(null);
		setConditionError(false);
		setFormData({ ...DEFAULT_FORM, conditions: [conditionDraft(EMPTY_CONDITION, false)] });
		setShowForm(true);
	};

	const openEdit = (rule: NotificationRuleResponse) => {
		advanceEditor();
		setEditingRule(rule);
		setConditionError(false);
		setFormData({
			name: rule.name,
			action: rule.action,
			conditions: rule.conditions.map((condition) => conditionDraft(condition)),
			priority: rule.priority,
			throttleMinutes: rule.throttleMinutes ?? 60,
			targetChannelIds: rule.targetChannelIds ?? [],
			quietHoursStart: rule.quietHoursStart ?? "22:00",
			quietHoursEnd: rule.quietHoursEnd ?? "08:00",
			quietHoursTimezone:
				rule.quietHoursTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
		setShowForm(true);
	};

	const cancelForm = () => {
		advanceEditor();
		setShowForm(false);
		setEditingRule(null);
		setConditionError(false);
	};

	const performRuleWrite = async (
		write: () => Promise<NotificationRuleResponse>,
		fallback: string,
		editor?: number,
	) => {
		if (
			currentIncognito.current ||
			savePending.current ||
			saveReviewPending.current ||
			saveBlocked.current
		)
			return;
		// Fence before dispatch; pending render alone misses same-tick clicks.
		savePending.current = true;
		const attempt = ++saveAttemptSequence.current;
		saveReviewSequence.current++;
		setSaveUnverified(false);
		setSaveReviewError(false);
		try {
			await write();
			if (
				mounted.current &&
				attempt === saveAttemptSequence.current &&
				editor !== undefined &&
				editor === editorSequence.current
			)
				cancelForm();
		} catch (error) {
			if (mounted.current && attempt === saveAttemptSequence.current) {
				if (error instanceof NotificationRuleSaveUnverifiedError) {
					saveBlocked.current = true;
					setSaveNeedsReview(true);
					setSaveUnverified(true);
				}
				toast.error(
					<RuleErrorTitle
						detail={currentIncognito.current ? fallback : getErrorMessage(error, fallback)}
						fallback={fallback}
					/>,
				);
			}
		} finally {
			if (attempt === saveAttemptSequence.current) savePending.current = false;
		}
	};

	const handleSave = () => {
		if (
			currentIncognito.current ||
			savePending.current ||
			saveReviewPending.current ||
			saveBlocked.current
		)
			return;
		const conditions = serializeConditions(formData.conditions);
		if (!conditions) {
			setConditionError(true);
			return;
		}
		setConditionError(false);
		const payload = {
			name: formData.name.trim(),
			action: formData.action,
			conditions,
			priority: formData.priority,
			...(formData.action === "throttle" && { throttleMinutes: formData.throttleMinutes }),
			...(formData.action === "route" && { targetChannelIds: formData.targetChannelIds }),
			...(formData.action === "quiet_hours" && {
				quietHoursStart: formData.quietHoursStart,
				quietHoursEnd: formData.quietHoursEnd,
				quietHoursTimezone: formData.quietHoursTimezone,
			}),
		};

		if (payload.conditions.length === 0) return;
		if (!payload.name) return;

		const editor = editorSequence.current;
		if (editingRule) {
			void performRuleWrite(
				() => updateRule.mutateAsync({ id: editingRule.id, data: payload }),
				"Failed to save rule",
				editor,
			);
		} else {
			void performRuleWrite(
				() => createRule.mutateAsync({ ...payload, enabled: true }),
				"Failed to save rule",
				editor,
			);
		}
	};

	const updateCondition = (draft: ConditionDraft) => {
		if (currentIncognito.current) return;
		setConditionError(false);
		setFormData((prev) => {
			const updated = prev.conditions.map((row) => (row.key === draft.key ? draft : row));
			return { ...prev, conditions: updated };
		});
	};

	const addCondition = () => {
		if (currentIncognito.current) return;
		setConditionError(false);
		const next = conditionDraft(EMPTY_CONDITION, false);
		setFormData((prev) => ({
			...prev,
			conditions: [...prev.conditions, next],
		}));
	};

	const removeCondition = (key: number) => {
		if (currentIncognito.current) return;
		setConditionError(false);
		setFormData((prev) => ({
			...prev,
			conditions: prev.conditions.filter((row) => row.key !== key),
		}));
	};

	const toggleChannel = (id: string) => {
		setFormData((prev) => ({
			...prev,
			targetChannelIds: prev.targetChannelIds.includes(id)
				? prev.targetChannelIds.filter((c) => c !== id)
				: [...prev.targetChannelIds, id],
		}));
	};

	const handleDelete = async (id: string) => {
		if (deletePending.current || deleteReviewPending.current || deleteBlocked.current.has(id))
			return;
		if (confirmDeleteTimer.current !== undefined) clearTimeout(confirmDeleteTimer.current);
		confirmDeleteTimer.current = undefined;
		if (confirmDeleteId === id) {
			deletePending.current = true;
			const attempt = ++deleteAttemptSequence.current;
			deleteReviewSequence.current++;
			setDeleteReviewError(false);
			setConfirmDeleteId(null);
			try {
				await deleteRule.mutateAsync(id);
				if (mounted.current && attempt === deleteAttemptSequence.current) {
					setDeleteFeedback((previous) => {
						const next = { ...previous };
						delete next[id];
						return next;
					});
				}
			} catch (error) {
				if (mounted.current && attempt === deleteAttemptSequence.current) {
					const unverified = error instanceof NotificationRuleDeleteUnverifiedError;
					if (unverified) deleteBlocked.current.add(id);
					setDeleteFeedback((previous) => ({
						...previous,
						[id]: unverified ? "unverified" : "rejected",
					}));
				}
			} finally {
				deletePending.current = false;
			}
		} else {
			setConfirmDeleteId(id);
			confirmDeleteTimer.current = setTimeout(() => {
				setConfirmDeleteId((previous) => (previous === id ? null : previous));
				confirmDeleteTimer.current = undefined;
			}, 3000);
		}
	};

	const toggleEnabled = (rule: NotificationRuleResponse) => {
		void performRuleWrite(
			() => updateRule.mutateAsync({ id: rule.id, data: { enabled: !rule.enabled } }),
			"Failed to update rule",
		);
	};

	const isSaving = createRule.isPending || updateRule.isPending;

	const inputClass = INPUT_BASE_CLASSES.input;

	// Delegate loading / error / first-run empty state to AsyncStateView so
	// wording, retry, and empty-state affordances match the rest of the app.
	// The empty branch is suppressed while the inline form is open — a user
	// creating their first rule shouldn't see the "you have no rules" CTA
	// under the form they're filling in.
	return (
		<>
			{saveUnverified && (
				<div role="alert" className="mb-4 space-y-2 rounded-xl border border-border/30 p-4">
					<p className="text-sm">{UNVERIFIED_SAVE_GUIDANCE}</p>
					<button
						type="button"
						onClick={() => void reviewRuleSave()}
						disabled={reviewingSave || isSaving}
						className="text-sm underline hover:text-foreground disabled:opacity-50"
					>
						{reviewingSave ? "Rechecking rule list..." : "Recheck rule list"}
					</button>
					{saveReviewError && (
						<p className="text-sm">
							Current rules could not be verified. Saving remains locked; review again.
						</p>
					)}
				</div>
			)}
			{hasRulesData && isError ? (
				<div role="alert" className="mb-4 rounded-xl border border-border/30 bg-muted/10 p-4">
					<p className="text-sm text-muted-foreground">
						Showing last-known rules. The latest refresh failed.
					</p>
					<GradientButton
						onClick={() => {
							void refetch();
						}}
						disabled={isFetching}
					>
						Try again
					</GradientButton>
				</div>
			) : hasRulesData && isFetching ? (
				<p role="status" aria-live="polite" className="mb-4 text-sm text-muted-foreground">
					Showing last-known rules while refreshing.
				</p>
			) : null}
			{Object.keys(deleteFeedback).length > 0 && (
				<div role="alert" className="mb-4 space-y-2 rounded-xl border border-border/30 p-4">
					<p className="text-sm">
						{hasUnverifiedDelete ? UNVERIFIED_DELETE_GUIDANCE : REJECTED_DELETE_GUIDANCE}
					</p>
					{hasUnverifiedDelete && (
						<button
							type="button"
							onClick={() => void recheckDeletedRules()}
							disabled={reviewingDelete || deleteRule.isPending}
							className="text-sm underline hover:text-foreground disabled:opacity-50"
						>
							{reviewingDelete ? "Rechecking rule list..." : "Recheck rule list"}
						</button>
					)}
					{deleteReviewError && (
						<p className="text-sm">
							Current rules could not be verified. Deletion remains locked; recheck again.
						</p>
					)}
				</div>
			)}
			<AsyncStateView
				isLoading={isLoading}
				isError={isError && !hasRulesData}
				error={incognitoMode ? undefined : error}
				errorDescription={
					incognitoMode
						? "Failed to load notification rules. Details are hidden in incognito mode."
						: undefined
				}
				isEmpty={rules.length === 0 && !showForm}
				onRetry={() => {
					void refetch();
				}}
				errorTitle="Couldn't load notification rules"
				emptyState={{
					icon: Shield,
					title: "No notification rules configured yet",
					description:
						"Rules let you suppress, throttle, route, or schedule quiet hours for notifications.",
					action: (
						<GradientButton onClick={openCreate}>
							<Plus className="mr-2 h-4 w-4" />
							Add your first rule
						</GradientButton>
					),
				}}
			>
				<div className="space-y-4">
					<div className="flex items-center justify-between">
						<p className="text-sm text-muted-foreground">
							Rules filter and route notifications before delivery. Higher priority rules run first.
						</p>
						{!showForm && (
							<GradientButton onClick={openCreate}>
								<Plus className="mr-2 h-4 w-4" />
								Add Rule
							</GradientButton>
						)}
					</div>

					{/* Inline form */}
					{showForm && (
						<div className="rounded-xl border border-border/30 bg-muted/10 p-4">
							<div className="space-y-5">
								<h3 className="font-semibold text-foreground">
									{editingRule ? "Edit Rule" : "New Rule"}
								</h3>
								{incognitoMode && (
									<div className="space-y-2">
										<p role="status" className="text-sm text-muted-foreground">
											Rule settings are hidden and editing is locked in incognito mode. Your draft
											is preserved.
										</p>
										<button
											type="button"
											onClick={() => setIncognitoMode(false)}
											className="text-sm underline hover:text-foreground"
										>
											Turn off incognito to edit
										</button>
									</div>
								)}
								<fieldset disabled={incognitoMode} className="space-y-5">
									{/* Name + priority row */}
									<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
										<div className="sm:col-span-2">
											<label
												htmlFor={`${formId}-name`}
												className="mb-1.5 block text-xs font-medium text-muted-foreground"
											>
												Rule name
											</label>
											<input
												id={`${formId}-name`}
												type="text"
												value={incognitoMode ? "" : formData.name}
												onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
												placeholder="e.g. Suppress hunt noise"
												className={inputClass}
												style={{ borderColor: formData.name ? undefined : undefined }}
												onFocus={(e) => (e.target.style.borderColor = gradient.from)}
												onBlur={(e) => (e.target.style.borderColor = "")}
											/>
										</div>
										<div>
											<label
												htmlFor={`${formId}-priority`}
												className="mb-1.5 block text-xs font-medium text-muted-foreground"
											>
												Priority (0 = first)
											</label>
											<input
												id={`${formId}-priority`}
												type="number"
												min={0}
												max={1000}
												value={formData.priority}
												onChange={(e) =>
													setFormData((p) => ({ ...p, priority: Number(e.target.value) }))
												}
												className={inputClass}
												onFocus={(e) => (e.target.style.borderColor = gradient.from)}
												onBlur={(e) => (e.target.style.borderColor = "")}
											/>
										</div>
									</div>

									{/* Action selector */}
									<fieldset>
										<legend className="mb-1.5 block text-xs font-medium text-muted-foreground">
											Action
										</legend>
										<div className="flex flex-wrap gap-2">
											{(["suppress", "throttle", "route", "quiet_hours"] as const).map((action) => (
												<button
													type="button"
													key={action}
													aria-pressed={formData.action === action}
													onClick={() => setFormData((p) => ({ ...p, action }))}
													className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors border ${
														formData.action === action
															? "text-white border-transparent"
															: "text-muted-foreground border-border/50 bg-card/30 hover:text-foreground"
													}`}
													style={
														formData.action === action
															? { backgroundColor: gradient.from }
															: undefined
													}
												>
													{ACTION_LABELS[action]}
												</button>
											))}
										</div>
										<p className="mt-1.5 text-xs text-muted-foreground">
											{ACTION_DESCRIPTIONS[formData.action]}
										</p>
									</fieldset>

									{/* Throttle sub-field */}
									{formData.action === "throttle" && (
										<div className="max-w-xs">
											<label
												htmlFor={`${formId}-throttle`}
												className="mb-1.5 block text-xs font-medium text-muted-foreground"
											>
												Throttle window (minutes)
											</label>
											<input
												id={`${formId}-throttle`}
												type="number"
												min={1}
												max={1440}
												value={formData.throttleMinutes}
												onChange={(e) =>
													setFormData((p) => ({ ...p, throttleMinutes: Number(e.target.value) }))
												}
												className={inputClass}
												onFocus={(e) => (e.target.style.borderColor = gradient.from)}
												onBlur={(e) => (e.target.style.borderColor = "")}
											/>
										</div>
									)}

									{/* Quiet hours sub-fields */}
									{formData.action === "quiet_hours" && (
										<div className="grid gap-3 sm:grid-cols-3">
											<div>
												<label
													htmlFor={`${formId}-quiet-start`}
													className="mb-1.5 block text-xs font-medium text-muted-foreground"
												>
													Start time
												</label>
												<input
													id={`${formId}-quiet-start`}
													type="time"
													value={incognitoMode ? "" : formData.quietHoursStart}
													onChange={(e) =>
														setFormData((p) => ({ ...p, quietHoursStart: e.target.value }))
													}
													className={inputClass}
													onFocus={(e) => (e.target.style.borderColor = gradient.from)}
													onBlur={(e) => (e.target.style.borderColor = "")}
												/>
											</div>
											<div>
												<label
													htmlFor={`${formId}-quiet-end`}
													className="mb-1.5 block text-xs font-medium text-muted-foreground"
												>
													End time
												</label>
												<input
													id={`${formId}-quiet-end`}
													type="time"
													value={incognitoMode ? "" : formData.quietHoursEnd}
													onChange={(e) =>
														setFormData((p) => ({ ...p, quietHoursEnd: e.target.value }))
													}
													className={inputClass}
													onFocus={(e) => (e.target.style.borderColor = gradient.from)}
													onBlur={(e) => (e.target.style.borderColor = "")}
												/>
											</div>
											<div>
												<label
													htmlFor={`${formId}-quiet-zone`}
													className="mb-1.5 block text-xs font-medium text-muted-foreground"
												>
													Timezone
												</label>
												<input
													id={`${formId}-quiet-zone`}
													type="text"
													value={incognitoMode ? "" : formData.quietHoursTimezone}
													onChange={(e) =>
														setFormData((p) => ({ ...p, quietHoursTimezone: e.target.value }))
													}
													placeholder="America/New_York"
													className={inputClass}
													onFocus={(e) => (e.target.style.borderColor = gradient.from)}
													onBlur={(e) => (e.target.style.borderColor = "")}
												/>
											</div>
										</div>
									)}

									{/* Route sub-field: channel multi-select */}
									{formData.action === "route" && (
										<fieldset>
											<legend className="mb-1.5 block text-xs font-medium text-muted-foreground">
												Target channels
											</legend>
											{channels.length === 0 ? (
												<p className="text-xs text-muted-foreground">No channels configured yet.</p>
											) : (
												<div className="flex flex-wrap gap-2">
													{channels.map((ch) => {
														const selected = formData.targetChannelIds.includes(ch.id);
														return (
															<button
																type="button"
																key={ch.id}
																aria-pressed={selected}
																onClick={() => toggleChannel(ch.id)}
																className={`rounded-lg px-3 py-1.5 text-sm border transition-colors ${
																	selected
																		? "text-white border-transparent"
																		: "text-muted-foreground border-border/50 bg-card/30 hover:text-foreground"
																}`}
																style={selected ? { backgroundColor: gradient.from } : undefined}
															>
																{incognitoMode ? getLinuxInstanceName(ch.name) : ch.name}
															</button>
														);
													})}
												</div>
											)}
										</fieldset>
									)}

									{/* Conditions */}
									<fieldset>
										<legend className="mb-2 text-xs font-medium text-muted-foreground">
											Conditions
										</legend>
										<div className="mb-2 flex items-center justify-between">
											<button
												type="button"
												onClick={addCondition}
												className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
											>
												<Plus className="h-3 w-3" />
												Add condition
											</button>
										</div>
										<div className="space-y-2">
											{formData.conditions.map((draft) => (
												<div key={draft.key} className="flex items-start gap-2">
													<NotificationRuleConditionEditor
														draft={draft}
														incognitoMode={incognitoMode}
														inputClass={inputClass}
														nextEntryKey={nextEntryKey}
														onChange={updateCondition}
													/>
													<button
														type="button"
														onClick={() => removeCondition(draft.key)}
														disabled={formData.conditions.length === 1}
														className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-red-400 disabled:opacity-30 transition-colors"
														title="Remove condition"
													>
														<Minus className="h-4 w-4" />
													</button>
												</div>
											))}
										</div>
										<p className="mt-1.5 text-xs text-muted-foreground">
											All conditions must match for the rule to apply.
										</p>
										{conditionError && (
											<p role="alert" className="mt-2 text-sm text-muted-foreground">
												Complete each condition: choose a field and confirm its value. Numbers must
												be finite. Complete or remove new rows, or choose Keep empty value.
											</p>
										)}
									</fieldset>
								</fieldset>

								{/* Actions */}
								<div className="flex items-center gap-3 pt-1">
									<GradientButton
										onClick={handleSave}
										disabled={isSaving || incognitoMode || saveNeedsReview || reviewingSave}
									>
										{isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
										{editingRule ? "Update Rule" : "Create Rule"}
									</GradientButton>
									<button
										type="button"
										onClick={cancelForm}
										className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground bg-card/30 border border-border/50 transition-colors"
									>
										Cancel
									</button>
								</div>
							</div>
						</div>
					)}

					{/* Rules list. Empty state is handled by the outer AsyncStateView when
			    no form is open — falling through to this block means there is
			    either at least one rule OR the inline form is mid-edit. */}
					{rules.length > 0 && (
						<div className="space-y-3">
							{rules.map((rule, index) => (
								<div key={rule.id} className="rounded-xl border border-border/30 bg-muted/10 p-3">
									<div
										className="flex items-start gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300"
										style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
									>
										<div
											className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg mt-0.5"
											style={{ backgroundColor: gradient.fromLight }}
										>
											<Shield className="h-5 w-5" style={{ color: gradient.from }} />
										</div>

										<div className="min-w-0 flex-1 space-y-1">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-medium">
													{incognitoMode ? "Notification rule" : rule.name}
												</span>
												<StatusBadge status={rule.enabled ? "success" : "warning"}>
													{rule.enabled ? "Active" : "Disabled"}
												</StatusBadge>
												<span
													className="rounded px-2 py-0.5 text-xs font-medium"
													style={{
														backgroundColor: gradient.fromLight,
														color: gradient.from,
													}}
												>
													{ACTION_LABELS[rule.action]}
												</span>
												<span className="text-xs text-muted-foreground">
													Priority {rule.priority}
												</span>
											</div>
											<p className="text-xs text-muted-foreground">
												{rule.conditions.length} condition
												{rule.conditions.length !== 1 ? "s" : ""}
												{rule.action === "throttle" && rule.throttleMinutes
													? ` · ${rule.throttleMinutes}m window`
													: ""}
												{rule.action === "route" && rule.targetChannelIds?.length
													? ` · ${rule.targetChannelIds.length} channel${rule.targetChannelIds.length !== 1 ? "s" : ""}`
													: ""}
												{rule.action === "quiet_hours" && rule.quietHoursStart && rule.quietHoursEnd
													? incognitoMode
														? " · Schedule hidden in incognito mode"
														: ` · ${rule.quietHoursStart}–${rule.quietHoursEnd} ${rule.quietHoursTimezone ?? "UTC"}`
													: ""}
											</p>
										</div>

										<div className="flex items-center gap-1 shrink-0">
											<button
												type="button"
												onClick={() => toggleEnabled(rule)}
												disabled={isSaving || incognitoMode || saveNeedsReview || reviewingSave}
												className="rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-card/50 transition-colors"
												title={rule.enabled ? "Disable rule" : "Enable rule"}
											>
												{rule.enabled ? (
													<ChevronDown className="h-4 w-4" />
												) : (
													<ChevronUp className="h-4 w-4" />
												)}
											</button>
											<button
												type="button"
												onClick={() => openEdit(rule)}
												className="rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-card/50 transition-colors"
												title="Edit rule"
											>
												<Shield className="h-4 w-4" />
											</button>
											<button
												type="button"
												onClick={() => void handleDelete(rule.id)}
												disabled={
													deleteRule.isPending ||
													reviewingDelete ||
													deleteBlocked.current.has(rule.id)
												}
												className={`rounded-md p-2 text-muted-foreground hover:bg-card/50 transition-colors ${
													confirmDeleteId === rule.id ? "text-red-400" : "hover:text-red-400"
												}`}
												title={
													confirmDeleteId === rule.id ? "Click again to confirm" : "Delete rule"
												}
											>
												{confirmDeleteId === rule.id ? (
													<span className="text-xs font-medium">Confirm?</span>
												) : (
													<Trash2 className="h-4 w-4" />
												)}
											</button>
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			</AsyncStateView>
		</>
	);
}
