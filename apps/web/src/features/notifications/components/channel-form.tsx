"use client";

import { Loader2, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { INPUT_BASE_CLASSES, getInputStyles } from "@/lib/theme-input-styles";
// GradientButton doesn't accept type="submit", so we use a styled native button
import type { NotificationChannelType } from "@arr/shared";
import {
	useChannelTypes,
	useCreateChannel,
	useUpdateChannel,
} from "../../../hooks/api/useNotifications";
import { notificationsApi } from "../../../lib/api-client/notifications";
import { ToggleSwitch } from "../../../components/layout/config-primitives";

interface ChannelFormProps {
	channelId: string | null;
	onSave: () => void;
	onCancel: () => void;
}

export function ChannelForm({ channelId, onSave, onCancel }: ChannelFormProps) {
	const { gradient } = useThemeGradient();
	const createChannel = useCreateChannel();
	const updateChannel = useUpdateChannel();
	const { data: channelTypes = [] } = useChannelTypes();

	const [name, setName] = useState("");
	const [type, setType] = useState<NotificationChannelType>("DISCORD");
	const [enabled, setEnabled] = useState(true);
	const [config, setConfig] = useState<Record<string, unknown>>({});
	const [loading, setLoading] = useState(false);

	const isEdit = channelId !== null;

	useEffect(() => {
		if (channelId) {
			setLoading(true);
			notificationsApi
				.getChannelConfig(channelId)
				.then((ch) => {
					setName(ch.name);
					setType(ch.type);
					setEnabled(ch.enabled);
					setConfig(ch.config);
				})
				.finally(() => setLoading(false));
		}
	}, [channelId]);

	const typeFields = channelTypes.find((t) => t.type === type)?.formFields ?? [];

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			if (isEdit) {
				await updateChannel.mutateAsync({
					id: channelId,
					data: { name, enabled, config },
				});
			} else {
				await createChannel.mutateAsync({ name, type, enabled, config });
			}
			onSave();
		} catch {
			// Error handled by mutation
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	const isSaving = createChannel.isPending || updateChannel.isPending;

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<div className="flex items-center justify-between">
				<h4 className="text-h4">{isEdit ? "Edit Channel" : "New Channel"}</h4>
				<button
					type="button"
					onClick={onCancel}
					className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<label className="block">
					<span className="text-caption text-muted-foreground mb-1 block">Name</span>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="My Discord"
						required
						className={INPUT_BASE_CLASSES.input}
						onFocus={(e) => getInputStyles(gradient).applyFocus(e.currentTarget)}
						onBlur={(e) => getInputStyles(gradient).removeFocus(e.currentTarget)}
					/>
				</label>

				{!isEdit && (
					<label className="block">
						<span className="text-caption text-muted-foreground mb-1 block">Type</span>
						<select
							value={type}
							onChange={(e) => {
								setType(e.target.value as NotificationChannelType);
								setConfig({});
							}}
							className={INPUT_BASE_CLASSES.select}
						>
							{channelTypes.map((t) => (
								<option key={t.type} value={t.type}>
									{t.label}
								</option>
							))}
						</select>
					</label>
				)}
			</div>

			{/* Dynamic config fields */}
			{typeFields.length > 0 && (
				<div className="grid gap-4 sm:grid-cols-2">
					{typeFields.map((field) =>
						field.type === "boolean" ? (
							<div key={field.key}>
								<ToggleSwitch
									label={field.label}
									checked={!!config[field.key]}
									onChange={(v) => setConfig({ ...config, [field.key]: v })}
								/>
							</div>
						) : (
							<label key={field.key} className="block">
								<span className="text-caption text-muted-foreground mb-1 block">{field.label}</span>
								<input
									type={field.type}
									value={String(config[field.key] ?? "")}
									placeholder={field.placeholder}
									onChange={(e) =>
										setConfig({
											...config,
											[field.key]:
												field.type === "number" ? Number(e.target.value) : e.target.value,
										})
									}
									className={INPUT_BASE_CLASSES.input}
								/>
							</label>
						),
					)}
				</div>
			)}

			<div className="flex items-center justify-between pt-2">
				<ToggleSwitch
					label="Enabled"
					checked={enabled}
					onChange={(v) => setEnabled(v)}
				/>

				<button
					type="submit"
					disabled={isSaving || !name.trim()}
					className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
					style={{ backgroundColor: gradient.from }}
				>
					{isSaving ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<Save className="mr-2 h-4 w-4" />
					)}
					{isEdit ? "Update" : "Create"}
				</button>
			</div>
			{(createChannel.error || updateChannel.error) && (
				<p className="text-sm text-red-400 mt-2">
					{(createChannel.error || updateChannel.error)?.message || "Failed to save channel"}
				</p>
			)}
		</form>
	);
}
