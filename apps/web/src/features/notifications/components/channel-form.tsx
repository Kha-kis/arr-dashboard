"use client";

import { Loader2, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useThemeGradient } from "@/hooks/useThemeGradient";
// GradientButton doesn't accept type="submit", so we use a styled native button
import type { NotificationChannelType } from "@arr/shared";
import { useCreateChannel, useUpdateChannel } from "../../../hooks/api/useNotifications";
import { notificationsApi } from "../../../lib/api-client/notifications";

const CHANNEL_TYPES = [
	{
		value: "DISCORD",
		label: "Discord",
		fields: [{ key: "webhookUrl", label: "Webhook URL", type: "url" }],
	},
	{
		value: "TELEGRAM",
		label: "Telegram",
		fields: [
			{ key: "botToken", label: "Bot Token", type: "password" },
			{ key: "chatId", label: "Chat ID", type: "text" },
		],
	},
	{
		value: "EMAIL",
		label: "Email (SMTP)",
		fields: [
			{ key: "host", label: "SMTP Host", type: "text" },
			{ key: "port", label: "Port", type: "number" },
			{ key: "secure", label: "Use TLS", type: "boolean" },
			{ key: "user", label: "Username", type: "text" },
			{ key: "password", label: "Password", type: "password" },
			{ key: "from", label: "From Address", type: "email" },
			{ key: "to", label: "To Address", type: "email" },
		],
	},
	{
		value: "PUSHBULLET",
		label: "Pushbullet",
		fields: [{ key: "apiToken", label: "API Token", type: "password" }],
	},
	{
		value: "PUSHOVER",
		label: "Pushover",
		fields: [
			{ key: "userKey", label: "User Key", type: "password" },
			{ key: "apiToken", label: "API Token", type: "password" },
		],
	},
	{
		value: "GOTIFY",
		label: "Gotify",
		fields: [
			{ key: "serverUrl", label: "Server URL", type: "url" },
			{ key: "appToken", label: "App Token", type: "password" },
		],
	},
] as const;

interface ChannelFormProps {
	channelId: string | null;
	onSave: () => void;
	onCancel: () => void;
}

export function ChannelForm({ channelId, onSave, onCancel }: ChannelFormProps) {
	const { gradient } = useThemeGradient();
	const createChannel = useCreateChannel();
	const updateChannel = useUpdateChannel();

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

	const typeConfig = CHANNEL_TYPES.find((t) => t.value === type);

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
						className="w-full rounded-md border border-border/50 bg-background/50 px-3 py-2 text-sm focus:outline-none focus:ring-2"
						style={{ focusRingColor: gradient.from } as React.CSSProperties}
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
							className="w-full rounded-md border border-border/50 bg-background/50 px-3 py-2 text-sm"
						>
							{CHANNEL_TYPES.map((t) => (
								<option key={t.value} value={t.value}>
									{t.label}
								</option>
							))}
						</select>
					</label>
				)}
			</div>

			{/* Dynamic config fields */}
			{typeConfig && (
				<div className="grid gap-4 sm:grid-cols-2">
					{typeConfig.fields.map((field) =>
						field.type === "boolean" ? (
							<label key={field.key} className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={!!config[field.key]}
									onChange={(e) => setConfig({ ...config, [field.key]: e.target.checked })}
								/>
								{field.label}
							</label>
						) : (
							<label key={field.key} className="block">
								<span className="text-caption text-muted-foreground mb-1 block">{field.label}</span>
								<input
									type={field.type}
									value={String(config[field.key] ?? "")}
									onChange={(e) =>
										setConfig({
											...config,
											[field.key]:
												field.type === "number" ? Number(e.target.value) : e.target.value,
										})
									}
									className="w-full rounded-md border border-border/50 bg-background/50 px-3 py-2 text-sm focus:outline-none"
								/>
							</label>
						),
					)}
				</div>
			)}

			<div className="flex items-center justify-between pt-2">
				<label className="flex items-center gap-2 text-sm">
					<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
					Enabled
				</label>

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
		</form>
	);
}
