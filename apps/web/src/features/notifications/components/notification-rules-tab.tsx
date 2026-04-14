"use client";

import { ChevronDown, ChevronUp, Loader2, Minus, Plus, Shield, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { RuleCondition } from "@arr/shared";
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
import type { NotificationRuleResponse } from "../../../lib/api-client/notifications";
import { getErrorMessage } from "../../../lib/error-utils";

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

const FIELD_OPTIONS = [
	{ value: "eventType", label: "Event Type" },
	{ value: "title", label: "Title" },
	{ value: "body", label: "Body" },
];

const OPERATOR_OPTIONS = [
	{ value: "equals", label: "equals" },
	{ value: "not_equals", label: "not equals" },
	{ value: "contains", label: "contains" },
	{ value: "in", label: "in (comma-separated)" },
];

interface RuleFormData {
	name: string;
	action: "suppress" | "throttle" | "route" | "quiet_hours";
	conditions: RuleCondition[];
	priority: number;
	throttleMinutes: number;
	targetChannelIds: string[];
	quietHoursStart: string;
	quietHoursEnd: string;
	quietHoursTimezone: string;
}

const EMPTY_CONDITION: RuleCondition = { field: "eventType", operator: "equals", value: "" };

const DEFAULT_FORM: RuleFormData = {
	name: "",
	action: "suppress",
	conditions: [{ ...EMPTY_CONDITION }],
	priority: 0,
	throttleMinutes: 60,
	targetChannelIds: [],
	quietHoursStart: "22:00",
	quietHoursEnd: "08:00",
	quietHoursTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

function conditionsFromRule(rule: NotificationRuleResponse): RuleCondition[] {
	return rule.conditions.map((c) => ({ ...c }));
}

export function NotificationRulesTab() {
	const { gradient } = useThemeGradient();
	const { data: rules = [], isLoading, isError, refetch } = useNotificationRules();
	const { data: channels = [] } = useNotificationChannels();
	const createRule = useCreateRule();
	const updateRule = useUpdateRule();
	const deleteRule = useDeleteRule();

	const [showForm, setShowForm] = useState(false);
	const [editingRule, setEditingRule] = useState<NotificationRuleResponse | null>(null);
	const [formData, setFormData] = useState<RuleFormData>({ ...DEFAULT_FORM });
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	const openCreate = () => {
		setEditingRule(null);
		setFormData({ ...DEFAULT_FORM, conditions: [{ ...EMPTY_CONDITION }] });
		setShowForm(true);
	};

	const openEdit = (rule: NotificationRuleResponse) => {
		setEditingRule(rule);
		setFormData({
			name: rule.name,
			action: rule.action,
			conditions: conditionsFromRule(rule),
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
		setShowForm(false);
		setEditingRule(null);
	};

	const handleSave = () => {
		const payload = {
			name: formData.name.trim(),
			action: formData.action,
			conditions: formData.conditions.filter((c) => String(c.value).trim() !== ""),
			priority: formData.priority,
			enabled: true,
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

		const errorHandler = {
			onError: (err: Error) => toast.error(getErrorMessage(err, "Failed to save rule")),
		};
		if (editingRule) {
			updateRule.mutate(
				{ id: editingRule.id, data: payload },
				{ onSuccess: cancelForm, ...errorHandler },
			);
		} else {
			createRule.mutate(payload, { onSuccess: cancelForm, ...errorHandler });
		}
	};

	const updateCondition = (index: number, patch: Partial<RuleCondition>) => {
		setFormData((prev) => {
			const updated = prev.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c));
			return { ...prev, conditions: updated };
		});
	};

	const addCondition = () => {
		setFormData((prev) => ({
			...prev,
			conditions: [...prev.conditions, { ...EMPTY_CONDITION }],
		}));
	};

	const removeCondition = (index: number) => {
		setFormData((prev) => ({
			...prev,
			conditions: prev.conditions.filter((_, i) => i !== index),
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

	const handleDelete = (id: string) => {
		if (confirmDeleteId === id) {
			deleteRule.mutate(id, {
				onError: (err) => toast.error(getErrorMessage(err, "Failed to delete rule")),
			});
			setConfirmDeleteId(null);
		} else {
			setConfirmDeleteId(id);
			setTimeout(() => setConfirmDeleteId(null), 3000);
		}
	};

	const toggleEnabled = (rule: NotificationRuleResponse) => {
		updateRule.mutate(
			{ id: rule.id, data: { enabled: !rule.enabled } },
			{ onError: (err) => toast.error(getErrorMessage(err, "Failed to update rule")) },
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
		<AsyncStateView
			isLoading={isLoading}
			isError={isError}
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

							{/* Name + priority row */}
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
								<div className="sm:col-span-2">
									<label className="mb-1.5 block text-xs font-medium text-muted-foreground">
										Rule name
									</label>
									<input
										type="text"
										value={formData.name}
										onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
										placeholder="e.g. Suppress hunt noise"
										className={inputClass}
										style={{ borderColor: formData.name ? undefined : undefined }}
										onFocus={(e) => (e.target.style.borderColor = gradient.from)}
										onBlur={(e) => (e.target.style.borderColor = "")}
									/>
								</div>
								<div>
									<label className="mb-1.5 block text-xs font-medium text-muted-foreground">
										Priority (0 = first)
									</label>
									<input
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
							<div>
								<label className="mb-1.5 block text-xs font-medium text-muted-foreground">
									Action
								</label>
								<div className="flex flex-wrap gap-2">
									{(["suppress", "throttle", "route", "quiet_hours"] as const).map((action) => (
										<button
											type="button"
											key={action}
											onClick={() => setFormData((p) => ({ ...p, action }))}
											className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors border ${
												formData.action === action
													? "text-white border-transparent"
													: "text-muted-foreground border-border/50 bg-card/30 hover:text-foreground"
											}`}
											style={
												formData.action === action ? { backgroundColor: gradient.from } : undefined
											}
										>
											{ACTION_LABELS[action]}
										</button>
									))}
								</div>
								<p className="mt-1.5 text-xs text-muted-foreground">
									{ACTION_DESCRIPTIONS[formData.action]}
								</p>
							</div>

							{/* Throttle sub-field */}
							{formData.action === "throttle" && (
								<div className="max-w-xs">
									<label className="mb-1.5 block text-xs font-medium text-muted-foreground">
										Throttle window (minutes)
									</label>
									<input
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
										<label className="mb-1.5 block text-xs font-medium text-muted-foreground">
											Start time
										</label>
										<input
											type="time"
											value={formData.quietHoursStart}
											onChange={(e) =>
												setFormData((p) => ({ ...p, quietHoursStart: e.target.value }))
											}
											className={inputClass}
											onFocus={(e) => (e.target.style.borderColor = gradient.from)}
											onBlur={(e) => (e.target.style.borderColor = "")}
										/>
									</div>
									<div>
										<label className="mb-1.5 block text-xs font-medium text-muted-foreground">
											End time
										</label>
										<input
											type="time"
											value={formData.quietHoursEnd}
											onChange={(e) =>
												setFormData((p) => ({ ...p, quietHoursEnd: e.target.value }))
											}
											className={inputClass}
											onFocus={(e) => (e.target.style.borderColor = gradient.from)}
											onBlur={(e) => (e.target.style.borderColor = "")}
										/>
									</div>
									<div>
										<label className="mb-1.5 block text-xs font-medium text-muted-foreground">
											Timezone
										</label>
										<input
											type="text"
											value={formData.quietHoursTimezone}
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
								<div>
									<label className="mb-1.5 block text-xs font-medium text-muted-foreground">
										Target channels
									</label>
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
														onClick={() => toggleChannel(ch.id)}
														className={`rounded-lg px-3 py-1.5 text-sm border transition-colors ${
															selected
																? "text-white border-transparent"
																: "text-muted-foreground border-border/50 bg-card/30 hover:text-foreground"
														}`}
														style={selected ? { backgroundColor: gradient.from } : undefined}
													>
														{ch.name}
													</button>
												);
											})}
										</div>
									)}
								</div>
							)}

							{/* Conditions */}
							<div>
								<div className="mb-2 flex items-center justify-between">
									<label className="text-xs font-medium text-muted-foreground">Conditions</label>
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
									{formData.conditions.map((cond, i) => (
										<div key={`cond-${i}`} className="flex items-center gap-2">
											<select
												value={cond.field}
												onChange={(e) => updateCondition(i, { field: e.target.value })}
												className={`${inputClass} flex-1`}
												onFocus={(e) => (e.target.style.borderColor = gradient.from)}
												onBlur={(e) => (e.target.style.borderColor = "")}
											>
												{FIELD_OPTIONS.map((f) => (
													<option key={f.value} value={f.value}>
														{f.label}
													</option>
												))}
											</select>
											<select
												value={cond.operator}
												onChange={(e) =>
													updateCondition(i, {
														operator: e.target.value as RuleCondition["operator"],
													})
												}
												className={`${inputClass} flex-1`}
												onFocus={(e) => (e.target.style.borderColor = gradient.from)}
												onBlur={(e) => (e.target.style.borderColor = "")}
											>
												{OPERATOR_OPTIONS.map((o) => (
													<option key={o.value} value={o.value}>
														{o.label}
													</option>
												))}
											</select>
											<input
												type="text"
												value={String(cond.value)}
												onChange={(e) => updateCondition(i, { value: e.target.value })}
												placeholder="Value"
												className={`${inputClass} flex-[2]`}
												onFocus={(e) => (e.target.style.borderColor = gradient.from)}
												onBlur={(e) => (e.target.style.borderColor = "")}
											/>
											<button
												type="button"
												onClick={() => removeCondition(i)}
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
							</div>

							{/* Actions */}
							<div className="flex items-center gap-3 pt-1">
								<GradientButton onClick={handleSave} disabled={isSaving}>
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
											<span className="font-medium">{rule.name}</span>
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
												? ` · ${rule.quietHoursStart}–${rule.quietHoursEnd} ${rule.quietHoursTimezone ?? "UTC"}`
												: ""}
										</p>
									</div>

									<div className="flex items-center gap-1 shrink-0">
										<button
											type="button"
											onClick={() => toggleEnabled(rule)}
											disabled={updateRule.isPending}
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
											onClick={() => handleDelete(rule.id)}
											disabled={deleteRule.isPending}
											className={`rounded-md p-2 text-muted-foreground hover:bg-card/50 transition-colors ${
												confirmDeleteId === rule.id ? "text-red-400" : "hover:text-red-400"
											}`}
											title={confirmDeleteId === rule.id ? "Click again to confirm" : "Delete rule"}
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
	);
}
