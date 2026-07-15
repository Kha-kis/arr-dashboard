"use client";

/**
 * Composer create/edit dialog for notification rules (PR-3d).
 *
 * The condition half is edited as v1 `field_match` predicates and serialized
 * back to the existing flat v0 route contract. Edit mode joins the Automation
 * summary with the domain rule before initializing so action data and the
 * defaulted `enabled`/`priority` fields can never be overwritten by form seeds.
 */

import type { CreateNotificationRule, NotificationRuleResponse } from "@arr/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useIncognitoMode } from "@/contexts/IncognitoContext";
import {
	useCreateRule,
	useNotificationChannels,
	useNotificationRules,
	useUpdateRule,
} from "@/hooks/api/useNotifications";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { getErrorMessage } from "@/lib/error-utils";
import { automationKeys } from "@/lib/query-keys";
import { SEMANTIC_COLORS } from "@/lib/theme-gradients";
import { getInputStyles } from "@/lib/theme-input-styles";
import { useAutomationRules } from "../../../hooks/api/useAutomation";
import {
	decomposeNotificationDocument,
	type NotificationEditorState,
	toNotificationsV0Conditions,
} from "../lib/notification-rule-editor";
import { FieldMatchConditionEditor } from "./field-match-condition-editor";

interface NotificationRuleComposerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	editRuleId?: string | null;
}

type NotificationAction = NotificationRuleResponse["action"];

function localTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function freshEditorState(): NotificationEditorState {
	return {
		conditions: [{ id: "condition-0", field: "eventType", operator: "equals", value: "" }],
	};
}

export function NotificationRuleComposerDialog({
	open,
	onOpenChange,
	editRuleId,
}: NotificationRuleComposerDialogProps) {
	const { gradient } = useThemeGradient();
	const [incognito] = useIncognitoMode();
	const queryClient = useQueryClient();
	const isEdit = Boolean(editRuleId);

	const { data: automation } = useAutomationRules();
	const { data: notificationRules } = useNotificationRules();
	const { data: channels = [] } = useNotificationChannels();
	const createRule = useCreateRule();
	const updateRule = useUpdateRule();

	const summary = useMemo(
		() =>
			editRuleId
				? automation?.rules.find(
						(rule) => rule.context === "notifications" && rule.id === editRuleId,
					)
				: undefined,
		[automation, editRuleId],
	);
	const rule = useMemo(
		() =>
			editRuleId ? notificationRules?.find((candidate) => candidate.id === editRuleId) : undefined,
		[notificationRules, editRuleId],
	);

	const editDataReady = !isEdit || (Boolean(summary) && Boolean(rule));

	const [name, setName] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [priority, setPriority] = useState(0);
	const [action, setAction] = useState<NotificationAction>("suppress");
	const [throttleMinutes, setThrottleMinutes] = useState(60);
	const [targetChannelIds, setTargetChannelIds] = useState<string[]>([]);
	const [quietHoursStart, setQuietHoursStart] = useState("22:00");
	const [quietHoursEnd, setQuietHoursEnd] = useState("08:00");
	const [quietHoursTimezone, setQuietHoursTimezone] = useState(localTimezone);
	const [editorState, setEditorState] = useState<NotificationEditorState>(freshEditorState);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || (isEdit && !editDataReady)) return;
		setError(null);
		if (isEdit && summary && rule) {
			setName(rule.name);
			setEnabled(rule.enabled);
			setPriority(rule.priority);
			setAction(rule.action);
			setThrottleMinutes(rule.throttleMinutes ?? 60);
			setTargetChannelIds(rule.targetChannelIds ?? []);
			setQuietHoursStart(rule.quietHoursStart ?? "22:00");
			setQuietHoursEnd(rule.quietHoursEnd ?? "08:00");
			setQuietHoursTimezone(rule.quietHoursTimezone ?? localTimezone());
			setEditorState(
				summary.document ? decomposeNotificationDocument(summary.document) : freshEditorState(),
			);
			return;
		}

		setName("");
		setEnabled(true);
		setPriority(0);
		setAction("suppress");
		setThrottleMinutes(60);
		setTargetChannelIds([]);
		setQuietHoursStart("22:00");
		setQuietHoursEnd("08:00");
		setQuietHoursTimezone(localTimezone());
		setEditorState(freshEditorState());
	}, [open, isEdit, editDataReady, summary, rule]);

	const inputStyles = getInputStyles(gradient);
	const inputClass = `${inputStyles.base} focus:outline-hidden`;
	const labelClass = "mb-1 block text-xs text-muted-foreground";
	const isSaving = createRule.isPending || updateRule.isPending;

	const toggleChannel = (id: string) => {
		setTargetChannelIds((current) =>
			current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id],
		);
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (isSaving || (isEdit && !editDataReady)) return;
		if (!name.trim()) {
			setError("Give the rule a name.");
			return;
		}
		if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
			setError("Priority must be a whole number from 0 to 1000.");
			return;
		}
		if (
			action === "throttle" &&
			(!Number.isInteger(throttleMinutes) || throttleMinutes < 1 || throttleMinutes > 1440)
		) {
			setError("Throttle minutes must be a whole number from 1 to 1440.");
			return;
		}
		if (action === "route" && targetChannelIds.length === 0) {
			setError("Choose at least one target channel.");
			return;
		}
		if (action === "quiet_hours" && (!quietHoursStart || !quietHoursEnd)) {
			setError("Enter both quiet-hours times.");
			return;
		}

		const result = toNotificationsV0Conditions(editorState);
		if (!result.conditions) {
			setError(result.error ?? "This rule isn't valid yet.");
			return;
		}

		const payload: CreateNotificationRule = {
			name: name.trim(),
			enabled,
			priority,
			action,
			conditions: result.conditions,
			...(action === "throttle" ? { throttleMinutes } : {}),
			...(action === "route" ? { targetChannelIds } : {}),
			...(action === "quiet_hours" ? { quietHoursStart, quietHoursEnd, quietHoursTimezone } : {}),
		};

		try {
			if (isEdit && editRuleId) {
				await updateRule.mutateAsync({ id: editRuleId, data: payload });
			} else {
				await createRule.mutateAsync(payload);
			}
			await queryClient.invalidateQueries({ queryKey: automationKeys.all });
			onOpenChange(false);
		} catch (err) {
			setError(getErrorMessage(err, "Could not save the rule."));
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Notification Rule" : "New Notification Rule"}</DialogTitle>
					<DialogDescription>
						Match notification fields, then suppress, throttle, route, or defer the event.
					</DialogDescription>
				</DialogHeader>

				{isEdit && !editDataReady ? (
					<div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
						Loading rule…
					</div>
				) : (
					<form
						onSubmit={handleSubmit}
						className="mt-2 space-y-5"
						onFocus={(event) => {
							const target = event.target;
							if (
								(target instanceof HTMLInputElement && target.type !== "checkbox") ||
								target instanceof HTMLSelectElement
							) {
								inputStyles.applyFocus(target);
							}
						}}
						onBlur={(event) => {
							const target = event.target;
							if (
								(target instanceof HTMLInputElement && target.type !== "checkbox") ||
								target instanceof HTMLSelectElement
							) {
								inputStyles.removeFocus(target);
							}
						}}
					>
						<div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
							<label>
								<span className={labelClass}>Rule name</span>
								<input
									type="text"
									value={name}
									onChange={(event) => setName(event.target.value)}
									placeholder="e.g., Route failed hunts"
									required
									className={inputClass}
								/>
							</label>
							<label>
								<span className={labelClass}>Priority (0 first)</span>
								<input
									type="number"
									min={0}
									max={1000}
									value={priority}
									onChange={(event) => setPriority(event.target.valueAsNumber)}
									className={inputClass}
								/>
							</label>
						</div>

						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">Enabled</span>
							<Switch
								aria-label="Enabled"
								checked={enabled}
								onCheckedChange={setEnabled}
								style={enabled ? { backgroundColor: gradient.from } : undefined}
							/>
						</div>

						<div className="space-y-3 rounded-xl border border-border/50 bg-card/30 p-4 backdrop-blur-sm">
							<span className="text-sm font-medium">Conditions</span>
							<FieldMatchConditionEditor
								state={editorState}
								onChange={setEditorState}
								inputClass={inputClass}
								labelClass={labelClass}
							/>
						</div>

						<div className="space-y-3 rounded-xl border border-border/50 bg-card/30 p-4 backdrop-blur-sm">
							<label>
								<span className={labelClass}>Action</span>
								<select
									value={action}
									onChange={(event) => setAction(event.target.value as NotificationAction)}
									className={inputClass}
								>
									<option value="suppress">Suppress notification</option>
									<option value="throttle">Throttle matching notifications</option>
									<option value="route">Route to selected channels</option>
									<option value="quiet_hours">Quiet hours</option>
								</select>
							</label>

							{action === "throttle" && (
								<label>
									<span className={labelClass}>Minimum minutes between notifications</span>
									<input
										type="number"
										min={1}
										max={1440}
										value={throttleMinutes}
										onChange={(event) => setThrottleMinutes(event.target.valueAsNumber)}
										className={inputClass}
									/>
								</label>
							)}

							{action === "route" && (
								<div>
									<span className={labelClass}>Target channels</span>
									{channels.length === 0 ? (
										<p className="text-xs text-muted-foreground">
											Create a notification channel in Settings before authoring a route rule.
										</p>
									) : (
										<div className="grid gap-2 sm:grid-cols-2">
											{channels.map((channel, index) => (
												<label
													key={channel.id}
													className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-sm"
												>
													<input
														type="checkbox"
														checked={targetChannelIds.includes(channel.id)}
														onChange={() => toggleChannel(channel.id)}
													/>
													<span>{incognito ? `Channel ${index + 1}` : channel.name}</span>
												</label>
											))}
										</div>
									)}
								</div>
							)}

							{action === "quiet_hours" && (
								<div className="grid gap-3 sm:grid-cols-3">
									<label>
										<span className={labelClass}>Start</span>
										<input
											type="time"
											value={quietHoursStart}
											onChange={(event) => setQuietHoursStart(event.target.value)}
											className={inputClass}
										/>
									</label>
									<label>
										<span className={labelClass}>End</span>
										<input
											type="time"
											value={quietHoursEnd}
											onChange={(event) => setQuietHoursEnd(event.target.value)}
											className={inputClass}
										/>
									</label>
									<label>
										<span className={labelClass}>Timezone</span>
										<input
											type="text"
											value={quietHoursTimezone}
											onChange={(event) => setQuietHoursTimezone(event.target.value)}
											className={inputClass}
										/>
									</label>
								</div>
							)}
						</div>

						{error && (
							<div
								className="rounded-md border px-3 py-2 text-xs"
								style={{
									borderColor: SEMANTIC_COLORS.error.border,
									backgroundColor: SEMANTIC_COLORS.error.bg,
									color: SEMANTIC_COLORS.error.text,
								}}
							>
								{error}
							</div>
						)}

						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => onOpenChange(false)}
								className="rounded-lg border border-border/50 px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={isSaving}
								className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-60"
								style={{
									background: `linear-gradient(to right, ${gradient.from}, ${gradient.to})`,
								}}
							>
								{isSaving ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : (
									<Save className="h-4 w-4" />
								)}
								{isEdit ? "Save changes" : "Create rule"}
							</button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
