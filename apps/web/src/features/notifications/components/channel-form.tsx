"use client";

// GradientButton doesn't accept type="submit", so we use a styled native button
import {
	type NotificationChannelEditState,
	type NotificationChannelType,
	REDACTED_NOTIFICATION_CONFIG_VALUE,
} from "@arr/shared";
import { AlertTriangle, Loader2, Save, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { getInputStyles, INPUT_BASE_CLASSES } from "@/lib/theme-input-styles";
import { ToggleSwitch } from "../../../components/layout/config-primitives";
import {
	useChannelTypes,
	useCreateChannel,
	useUpdateChannel,
} from "../../../hooks/api/useNotifications";
import { ApiError } from "../../../lib/api-client/base";
import {
	NotificationChannelCreateUnverifiedError,
	NotificationChannelUpdateUnverifiedError,
	notificationsApi,
} from "../../../lib/api-client/notifications";
import { useIncognitoMode } from "../../../lib/incognito";
import { BrowserPushReconnect } from "./browser-push-reconnect";

interface ChannelFormProps {
	channelId: string | null;
	onSave: () => void;
	onSaved?: (channelId: string | null) => void;
	onCancel: () => void;
}

const repairWarning =
	"Channel settings cannot be read. Re-enter the full configuration. The channel, event subscriptions, rules and history are retained. This does not recover lost secrets or repair an encryption key.";

export function ChannelForm({ channelId, onSave, onSaved, onCancel }: ChannelFormProps) {
	// A new selection must not inherit drafts or late reads from another channel.
	return (
		<ChannelFormContent
			key={channelId === null ? "new-channel" : `edit:${channelId}`}
			channelId={channelId}
			onSave={onSave}
			onSaved={onSaved}
			onCancel={onCancel}
		/>
	);
}

function ChannelFormContent({ channelId, onSave, onSaved, onCancel }: ChannelFormProps) {
	const { gradient } = useThemeGradient();
	const [incognitoMode, setIncognitoMode] = useIncognitoMode();
	const createChannel = useCreateChannel();
	const updateChannel = useUpdateChannel();
	const {
		data: channelTypes = [],
		isLoading: typesLoading,
		isError: typesError,
		refetch: reloadTypes,
	} = useChannelTypes();

	const [name, setName] = useState("");
	const [type, setType] = useState<NotificationChannelType>("DISCORD");
	const [enabled, setEnabled] = useState(true);
	const [config, setConfig] = useState<Record<string, unknown>>({});
	const [loading, setLoading] = useState(channelId !== null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [configRevision, setConfigRevision] = useState<string | null>(null);
	const [saveNeedsReload, setSaveNeedsReload] = useState(false);
	const [createNeedsReview, setCreateNeedsReview] = useState(false);
	const [repairState, setRepairState] = useState<NotificationChannelEditState | null>(null);
	const [repairEditing, setRepairEditing] = useState(false);
	const [checkingRepair, setCheckingRepair] = useState(false);
	const [repairError, setRepairError] = useState<string | null>(null);
	const [cancelled, setCancelled] = useState(false);
	// Each explicit retry creates a distinct read request without changing drafts.
	const [readRequest, setReadRequest] = useState(() => ({ channelId }));
	const mounted = useRef(true);
	const repairRead = useRef<AbortController | null>(null);
	const repairReadSequence = useRef(0);
	const submitting = useRef(false);
	const fieldId = useId();

	const isEdit = channelId !== null;
	const isSaving = createChannel.isPending || updateChannel.isPending;

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			repairRead.current?.abort();
		};
	}, []);

	useEffect(() => {
		let active = true;
		if (readRequest.channelId) {
			setLoading(true);
			setLoadError(null);
			notificationsApi
				.getChannelConfig(readRequest.channelId)
				.then((ch) => {
					if (!active || !mounted.current) return;
					if (
						ch.id !== readRequest.channelId ||
						typeof ch.configRevision !== "string" ||
						!/^[a-f0-9]{64}$/.test(ch.configRevision)
					) {
						setLoadError("Channel settings could not be loaded. Retry loading or close this form.");
						return;
					}
					setName(ch.name);
					setType(ch.type);
					setEnabled(ch.enabled);
					setConfig(ch.config);
					setConfigRevision(ch.configRevision);
					setSaveNeedsReload(false);
					setSaveError(null);
				})
				.catch(() => {
					if (active && mounted.current)
						setLoadError("Channel settings could not be loaded. Retry loading or close this form.");
				})
				.finally(() => {
					if (active && mounted.current) setLoading(false);
				});
		}
		return () => {
			active = false;
		};
	}, [readRequest]);

	const selectedType = channelTypes.find((t) => t.type === type);
	const typeFields = selectedType?.formFields ?? [];
	const repairTypeAvailable = channelTypes.some(
		(descriptor) => descriptor.type === repairState?.type && descriptor.formFields.length > 0,
	);

	const handleCancel = () => {
		mounted.current = false;
		repairReadSequence.current++;
		repairRead.current?.abort();
		setCancelled(true);
		onCancel();
	};

	const retryConfigRead = () => {
		repairReadSequence.current++;
		repairRead.current?.abort();
		repairRead.current = null;
		setCheckingRepair(false);
		setRepairState(null);
		setRepairError(null);
		setRepairEditing(false);
		setReadRequest({ channelId });
	};

	const checkRepairOptions = async () => {
		if (!channelId || !mounted.current || repairRead.current || isSaving || submitting.current)
			return;
		const controller = new AbortController();
		repairRead.current = controller;
		const sequence = ++repairReadSequence.current;
		setCheckingRepair(true);
		setRepairState(null);
		setRepairError(null);
		try {
			const current = await notificationsApi.getChannelEditState(channelId, controller.signal);
			if (!mounted.current || controller.signal.aborted || sequence !== repairReadSequence.current)
				return;
			setRepairState(current);
			setRepairEditing(false);
			setLoadError("Channel settings could not be loaded. Retry loading or close this form.");
		} catch {
			if (mounted.current && !controller.signal.aborted && sequence === repairReadSequence.current)
				setRepairError(
					"Channel repair options could not be verified. Retry loading or check again.",
				);
		} finally {
			if (sequence === repairReadSequence.current) {
				repairRead.current = null;
				if (mounted.current) setCheckingRepair(false);
			}
		}
	};

	const enterRepair = () => {
		if (
			incognitoMode ||
			checkingRepair ||
			repairError ||
			!mounted.current ||
			typesLoading ||
			typesError ||
			!repairTypeAvailable ||
			repairState?.state !== "repair-required" ||
			repairState.id !== channelId
		)
			return;
		setName(repairState.name);
		setType(repairState.type);
		setEnabled(repairState.enabled);
		setConfig({});
		setConfigRevision(repairState.configRevision);
		setLoadError(null);
		setSaveError(null);
		setSaveNeedsReload(false);
		setRepairEditing(true);
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (
			incognitoMode ||
			!mounted.current ||
			submitting.current ||
			checkingRepair ||
			loading ||
			loadError ||
			typesLoading ||
			typesError ||
			!selectedType ||
			(repairEditing && typeFields.length === 0) ||
			isSaving ||
			saveNeedsReload ||
			createNeedsReview ||
			(isEdit && !configRevision)
		)
			return;
		setSaveError(null);
		const submittedConfig = { ...config };
		for (const field of typeFields) {
			const value = submittedConfig[field.key];
			// An untouched unchecked toggle is still an explicit false configuration.
			if (field.type === "boolean" && value === undefined) submittedConfig[field.key] = false;
			if (
				field.type !== "headers" ||
				value === undefined ||
				value === REDACTED_NOTIFICATION_CONFIG_VALUE
			)
				continue;
			let headers: unknown = value;
			try {
				if (typeof value === "string") headers = value.trim() ? JSON.parse(value) : {};
			} catch {
				headers = null;
			}
			if (
				typeof headers !== "object" ||
				headers === null ||
				Array.isArray(headers) ||
				!Object.values(headers).every((item) => typeof item === "string")
			) {
				setSaveError("Custom headers must be a JSON object with string values.");
				return;
			}
			submittedConfig[field.key] = headers;
		}
		submitting.current = true;
		try {
			if (isEdit) {
				await updateChannel.mutateAsync({
					id: channelId,
					data: repairEditing
						? { config: submittedConfig, expectedRevision: configRevision ?? undefined }
						: {
								name,
								enabled,
								config: submittedConfig,
								expectedRevision: configRevision ?? undefined,
							},
				});
			} else {
				await createChannel.mutateAsync({ name, type, enabled, config: submittedConfig });
			}
			// The acknowledged write still matters after changing editors or tabs.
			onSaved?.(channelId);
			if (mounted.current) onSave();
		} catch (error) {
			if (mounted.current) {
				const conflict =
					error instanceof ApiError &&
					error.status === 409 &&
					typeof error.payload === "object" &&
					error.payload !== null &&
					"code" in error.payload &&
					error.payload.code === "CHANNEL_SETTINGS_CONFLICT";
				const unverified = error instanceof NotificationChannelUpdateUnverifiedError;
				const createUnverified = error instanceof NotificationChannelCreateUnverifiedError;
				setCreateNeedsReview(createUnverified);
				setSaveNeedsReload(conflict || unverified);
				const message = createUnverified
					? "Creation outcome could not be verified. The channel may have been created. Review the channel list before another Create. Your draft is preserved."
					: unverified
						? "Save outcome could not be verified. Your change may have been saved. Reload current settings to check before retrying."
						: conflict
							? "Settings changed elsewhere. Your draft has not been saved. Reload current settings to review and reapply your changes."
							: "Channel settings could not be saved. Check the fields, reopen the form if values changed, and retry.";
				setSaveError(message);
				toast.error(message);
			}
		} finally {
			submitting.current = false;
		}
	};

	if (cancelled) return null;

	if (loading || typesLoading) {
		return (
			<div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
				<div role="status" aria-busy="true" className="flex items-center gap-2">
					<Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
					<span>Loading channel settings...</span>
				</div>
				<button
					type="button"
					onClick={handleCancel}
					className="text-sm underline hover:text-foreground"
				>
					Go back
				</button>
			</div>
		);
	}

	if (loadError || typesError || !selectedType || (repairEditing && typeFields.length === 0)) {
		return (
			<div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
				<AlertTriangle className="h-6 w-6" />
				<p role="alert" className="text-sm">
					{repairError ??
						(repairState?.state === "repair-required"
							? repairState.type === "BROWSER_PUSH"
								? "Manual browser configuration cannot be re-entered. Reconnect this selected channel to this browser using the action below."
								: repairTypeAvailable
									? repairWarning
									: `${repairWarning} Configuration field definitions are unavailable. Retry loading or close this form.`
							: repairState?.state === "readable"
								? "Channel settings are readable. Retry loading the current settings."
								: loadError) ??
						"Channel field definitions are unavailable. Retry loading or close this form."}
				</p>
				<button
					type="button"
					onClick={() => {
						if (loadError) retryConfigRead();
						if (
							typesError ||
							(!loadError && !selectedType) ||
							(repairState && !repairTypeAvailable)
						)
							void reloadTypes();
					}}
					className="text-sm underline hover:text-foreground"
				>
					Retry loading
				</button>
				{loadError && channelId && (
					<button
						type="button"
						onClick={() => void checkRepairOptions()}
						disabled={checkingRepair}
						aria-busy={checkingRepair}
						className="text-sm underline hover:text-foreground disabled:opacity-50"
					>
						Check repair options
					</button>
				)}
				{repairState?.state === "repair-required" && (
					<button
						type="button"
						onClick={enterRepair}
						disabled={incognitoMode || checkingRepair || typesError || !repairTypeAvailable}
						className="text-sm underline hover:text-foreground disabled:opacity-50"
					>
						Re-enter configuration
					</button>
				)}
				{repairState?.state === "repair-required" &&
				repairState.type === "BROWSER_PUSH" &&
				repairState.id === channelId &&
				!checkingRepair &&
				!repairError &&
				channelId ? (
					<BrowserPushReconnect channelId={channelId} onSaved={onSaved} onSave={onSave} />
				) : null}
				<button
					type="button"
					onClick={handleCancel}
					className="text-sm underline hover:text-foreground"
				>
					Go back
				</button>
			</div>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<div className="flex items-center justify-between">
				<h4 className="text-h4">
					{repairEditing
						? "Replace Channel Configuration"
						: isEdit
							? "Edit Channel"
							: "New Channel"}
				</h4>
				<button
					type="button"
					aria-label="Close channel form"
					disabled={isSaving}
					onClick={handleCancel}
					className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
				>
					<X className="h-4 w-4" />
				</button>
			</div>
			{repairEditing && (
				<p role="status" className="text-sm text-muted-foreground">
					{repairWarning}
				</p>
			)}
			{incognitoMode && (
				<div className="space-y-2">
					<p role="status" className="text-sm text-muted-foreground">
						Channel settings are hidden and editing is locked in incognito mode. Your draft is
						preserved.
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
			<fieldset disabled={isSaving || incognitoMode} className="space-y-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<label className="block">
						<span className="text-caption text-muted-foreground mb-1 block">Name</span>
						<input
							type="text"
							value={incognitoMode ? "" : name}
							onChange={(e) => setName(e.target.value)}
							placeholder={incognitoMode ? "Hidden in incognito mode" : "My Discord"}
							required
							readOnly={repairEditing}
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
						{typeFields.map((field) => {
							const retained = config[field.key] === REDACTED_NOTIFICATION_CONFIG_VALUE;
							const value =
								incognitoMode || retained
									? ""
									: field.type === "headers" && typeof config[field.key] === "object"
										? JSON.stringify(config[field.key], null, 2)
										: String(config[field.key] ?? "");
							const placeholder = incognitoMode
								? "Hidden in incognito mode"
								: retained
									? "Stored value retained; enter a replacement"
									: field.placeholder;
							return field.type === "boolean" ? (
								<div key={field.key}>
									<ToggleSwitch
										label={field.label}
										checked={!!config[field.key]}
										onChange={(v) => setConfig((previous) => ({ ...previous, [field.key]: v }))}
									/>
								</div>
							) : (
								<div key={field.key} className="space-y-1">
									<label htmlFor={`${fieldId}-${field.key}`} className="block">
										<span className="text-caption text-muted-foreground mb-1 block">
											{field.label}
										</span>
										{field.type === "headers" ? (
											<textarea
												id={`${fieldId}-${field.key}`}
												value={value}
												placeholder={placeholder ?? '{"Header-Name":"value"}'}
												onChange={(e) =>
													setConfig((previous) => ({ ...previous, [field.key]: e.target.value }))
												}
												className={INPUT_BASE_CLASSES.input}
												rows={3}
												spellCheck={false}
											/>
										) : (
											<input
												id={`${fieldId}-${field.key}`}
												type={field.type}
												value={value}
												placeholder={placeholder}
												required={field.required && !retained}
												onChange={(e) =>
													setConfig((previous) => ({
														...previous,
														[field.key]:
															field.type === "number" ? Number(e.target.value) : e.target.value,
													}))
												}
												className={INPUT_BASE_CLASSES.input}
											/>
										)}
									</label>
									{retained && !field.required && (
										<button
											type="button"
											className="text-caption text-muted-foreground underline"
											onClick={() =>
												setConfig((previous) => ({
													...previous,
													[field.key]: field.type === "headers" ? {} : "",
												}))
											}
										>
											Clear stored {field.label}
										</button>
									)}
								</div>
							);
						})}
					</div>
				)}

				<div className="flex items-center justify-between pt-2">
					<fieldset disabled={repairEditing}>
						<ToggleSwitch
							label="Enabled"
							checked={incognitoMode ? false : enabled}
							onChange={(v) => setEnabled(v)}
						/>
					</fieldset>

					<button
						type="submit"
						disabled={
							isSaving || saveNeedsReload || createNeedsReview || (!repairEditing && !name.trim())
						}
						className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
						style={{ backgroundColor: gradient.from }}
					>
						{isSaving ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Save className="mr-2 h-4 w-4" />
						)}
						{repairEditing ? "Save replacement" : isEdit ? "Update" : "Create"}
					</button>
				</div>
				{saveError && (
					<p role="alert" className="text-sm text-destructive mt-2">
						{saveError}
					</p>
				)}
				{saveNeedsReload && (
					<button
						type="button"
						onClick={() => {
							if (repairEditing) void checkRepairOptions();
							else retryConfigRead();
						}}
						disabled={checkingRepair}
						className="text-sm underline hover:text-foreground"
					>
						Reload current settings (discards draft)
					</button>
				)}
			</fieldset>
			{createNeedsReview && (
				<button
					type="button"
					onClick={handleCancel}
					className="text-sm underline hover:text-foreground"
				>
					Review channel list (discards draft)
				</button>
			)}
		</form>
	);
}
