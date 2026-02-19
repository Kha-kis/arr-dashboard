"use client";

import { useState, useEffect, useId } from "react";
import { Settings, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { SeerrNotificationAgent } from "@arr/shared";
import {
	LegacyDialog,
	LegacyDialogHeader,
	LegacyDialogTitle,
	LegacyDialogDescription,
	LegacyDialogContent,
	LegacyDialogFooter,
	LegacyDialogClose,
	Input,
	Switch,
} from "../../../components/ui";
import { SimpleFormField } from "../../../components/ui/simple-form-field";
import { GradientButton } from "../../../components/layout/premium-components";
import { useUpdateSeerrNotification } from "../../../hooks/api/useSeerr";
import { AGENT_FIELDS, type AgentField } from "../lib/notification-agent-fields";

interface AgentConfigDialogProps {
	agent: SeerrNotificationAgent | null;
	instanceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export const AgentConfigDialog = ({ agent, instanceId, open, onOpenChange }: AgentConfigDialogProps) => {
	const formId = useId();
	const [draft, setDraft] = useState<Record<string, unknown>>({});
	const updateMutation = useUpdateSeerrNotification();

	// Sync draft from agent options when the dialog opens with a new agent
	useEffect(() => {
		if (open && agent) {
			setDraft({ ...agent.options });
		}
	}, [open, agent]);

	if (!agent) return null;

	const fields = AGENT_FIELDS[agent.id];
	if (!fields) return null;

	const hasChanges = JSON.stringify(draft) !== JSON.stringify(agent.options);

	const handleFieldChange = (key: string, value: unknown) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
	};

	const handleSave = () => {
		updateMutation.mutate(
			{ instanceId, agentId: String(agent.id), config: { options: draft } },
			{
				onSuccess: () => {
					toast.success(`${agent.name} configuration saved`);
					onOpenChange(false);
				},
				onError: () => toast.error(`Failed to save ${agent.name} configuration`),
			},
		);
	};

	const handleToggleEnabled = () => {
		updateMutation.mutate(
			{ instanceId, agentId: String(agent.id), config: { enabled: !agent.enabled } },
			{
				onSuccess: () => toast.success(`${agent.name} ${agent.enabled ? "disabled" : "enabled"}`),
				onError: () => toast.error(`Failed to ${agent.enabled ? "disable" : "enable"} ${agent.name}`),
			},
		);
	};

	return (
		<LegacyDialog open={open} onOpenChange={onOpenChange} size="md">
			<LegacyDialogClose onClick={() => onOpenChange(false)} />
			<LegacyDialogHeader>
				<LegacyDialogTitle>
					<div className="flex items-center gap-2">
						<Settings className="h-5 w-5" />
						{agent.name} Configuration
					</div>
				</LegacyDialogTitle>
				<LegacyDialogDescription>
					Configure notification settings for the {agent.name} agent.
				</LegacyDialogDescription>
			</LegacyDialogHeader>

			<LegacyDialogContent className="space-y-4">
				<div className="flex items-center justify-between rounded-xl border border-border/50 bg-background/50 px-4 py-3">
					<div>
						<p className="text-sm font-medium text-foreground">Enable Agent</p>
						<p className="text-xs text-muted-foreground">
							{agent.enabled ? "This agent is active and sending notifications" : "Enable to start receiving notifications"}
						</p>
					</div>
					<Switch
						checked={agent.enabled}
						onCheckedChange={handleToggleEnabled}
						disabled={updateMutation.isPending}
					/>
				</div>

				{fields.map((field) => (
					<AgentFieldInput
						key={field.key}
						field={field}
						value={draft[field.key]}
						onChange={(v) => handleFieldChange(field.key, v)}
						formId={formId}
					/>
				))}
			</LegacyDialogContent>

			<LegacyDialogFooter>
				<GradientButton
					size="sm"
					variant="primary"
					disabled={!hasChanges || updateMutation.isPending}
					onClick={handleSave}
					icon={updateMutation.isPending ? Loader2 : undefined}
				>
					{updateMutation.isPending ? "Saving..." : "Save"}
				</GradientButton>
			</LegacyDialogFooter>
		</LegacyDialog>
	);
};

// ---------------------------------------------------------------------------
// Field renderer — maps AgentField type to the appropriate input control
// ---------------------------------------------------------------------------

interface AgentFieldInputProps {
	field: AgentField;
	value: unknown;
	onChange: (value: unknown) => void;
	formId: string;
}

const AgentFieldInput = ({ field, value, onChange, formId }: AgentFieldInputProps) => {
	const inputId = `${formId}-${field.key}`;

	if (field.type === "boolean") {
		return (
			<div className="flex items-center justify-between rounded-xl border border-border/50 bg-background/50 px-4 py-3">
				<label htmlFor={inputId} className="text-sm font-medium text-foreground">
					{field.label}
				</label>
				<Switch
					id={inputId}
					checked={!!value}
					onCheckedChange={(checked) => onChange(checked)}
				/>
			</div>
		);
	}

	const inputType = field.type === "url" ? "url" : field.type === "number" ? "number" : field.type === "password" ? "password" : "text";

	return (
		<SimpleFormField label={field.label} htmlFor={inputId}>
			<Input
				id={inputId}
				premium
				type={inputType}
				placeholder={field.placeholder}
				value={value != null ? String(value) : ""}
				onChange={(e) => {
					const raw = e.target.value;
					onChange(field.type === "number" ? (raw === "" ? "" : Number(raw)) : raw);
				}}
			/>
		</SimpleFormField>
	);
};
