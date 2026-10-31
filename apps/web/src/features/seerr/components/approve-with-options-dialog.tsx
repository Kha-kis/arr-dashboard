"use client";

/**
 * Approval dialog that lets an admin pick a quality profile, root folder, and
 * (optionally) tags + server before approving a Seerr request.
 *
 * Reuses the same `request-options` endpoint that the request-creation form uses,
 * so all configured Radarr/Sonarr servers + their profiles are already cached when
 * this dialog opens.
 */

import type { SeerrRequest } from "@arr/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { GradientButton } from "../../../components/layout/premium-components";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	NativeSelect,
	SelectOption,
} from "../../../components/ui";
import { useApproveSeerrRequest, useSeerrRequestOptions } from "../../../hooks/api/useSeerr";
import { getLinuxSavePath, getLinuxServerName, useIncognitoMode } from "../../../lib/incognito";
import { notifySeerrActionError } from "../lib/seerr-action-error";
import {
	getRequestOptionsState,
	hasVerifiedRequestOptions,
	resolveRequestOptionsServer,
} from "../lib/request-options-state";

interface ApproveWithOptionsDialogProps {
	request: SeerrRequest;
	instanceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export const ApproveWithOptionsDialog = ({
	request,
	instanceId,
	open,
	onOpenChange,
}: ApproveWithOptionsDialogProps) => {
	const [incognitoMode] = useIncognitoMode();
	const profileFieldId = useId();
	const folderFieldId = useId();
	const serverFieldId = useId();

	const mediaType = request.type;
	const optionsQuery = useSeerrRequestOptions(instanceId, mediaType);
	const approveMutation = useApproveSeerrRequest();
	const { coverage, servers } = useMemo(
		() => getRequestOptionsState(optionsQuery.data),
		[optionsQuery.data],
	);

	// Filter to non-4K servers when the request is non-4K (and vice-versa) so
	// the admin can't pick a profile from an incompatible server.
	const filteredServers = useMemo(
		() => servers.filter((s) => s.server.is4k === request.is4k),
		[servers, request.is4k],
	);

	const [serverId, setServerId] = useState<number | undefined>(request.serverId ?? undefined);
	const [profileId, setProfileId] = useState<number | undefined>(request.profileId ?? undefined);
	const [rootFolder, setRootFolder] = useState<string | undefined>(request.rootFolder ?? undefined);
	const [clearedTagIds, setClearedTagIds] = useState<Set<number>>(new Set());
	const selectedTags = useMemo(
		() => (request.tags ?? []).filter((id) => !clearedTagIds.has(id)),
		[request.tags, clearedTagIds],
	);

	const selectedServer = useMemo(
		() => resolveRequestOptionsServer(filteredServers, serverId, coverage),
		[filteredServers, serverId, coverage],
	);
	const effectiveProfileId = profileId ?? selectedServer?.server.activeProfileId;
	const effectiveRootFolder = rootFolder ?? selectedServer?.server.activeDirectory;
	const verifiedSelection = hasVerifiedRequestOptions(
		selectedServer,
		profileId,
		rootFolder,
		selectedTags,
	);
	const unavailableTagIds = selectedServer
		? selectedTags.filter((id) => !selectedServer.tags.some((tag) => tag.id === id))
		: [];

	// Reset for a newly opened/requested dialog, never for a query refresh.
	useEffect(() => {
		if (!open) return;
		setServerId(request.serverId ?? undefined);
		setProfileId(request.profileId ?? undefined);
		setRootFolder(request.rootFolder ?? undefined);
		setClearedTagIds(new Set());
	}, [open, request.id, request.serverId, request.profileId, request.rootFolder]);

	// When the user changes server, reset profile + folder to that server's defaults.
	const handleServerChange = (nextServerId: number) => {
		const next = filteredServers.find((s) => s.server.id === nextServerId);
		if (!next) return;
		setServerId(next.server.id);
		setProfileId(next.server.activeProfileId);
		setRootFolder(next.server.activeDirectory);
	};

	// Local, explicit intent only: keep verified tags and wait for Approve to write.
	const handleClearUnavailableTags = () => {
		if (busy || unavailable || approveMutation.isPending || !selectedServer) return;
		setServerId(selectedServer.server.id);
		setClearedTagIds((previous) => new Set([...previous, ...unavailableTagIds]));
	};

	const handleApprove = () => {
		if (submitDisabled || !selectedServer || !verifiedSelection) return;
		const overrides: {
			serverId?: number;
			profileId?: number;
			rootFolder?: string;
			tags?: number[];
		} = {};
		// Compare against the request's original/default routing values — the request's own fields
		// when set, otherwise the original server's defaults. This way a confirm
		// without changes doesn't fire a pointless PUT or write `overridden: true`
		// to the audit log for first-time-routed requests.
		const originalServer = resolveRequestOptionsServer(
			filteredServers,
			request.serverId ?? undefined,
			coverage,
		);
		const originalServerId = request.serverId ?? originalServer?.server.id;
		const originalProfileId = request.profileId ?? originalServer?.server.activeProfileId;
		const originalRootFolder = request.rootFolder ?? originalServer?.server.activeDirectory;

		if (coverage === "partial" || selectedServer.server.id !== originalServerId) {
			overrides.serverId = selectedServer.server.id;
		}
		if (coverage === "partial" || effectiveProfileId !== originalProfileId) {
			overrides.profileId = effectiveProfileId;
		}
		if (coverage === "partial" || effectiveRootFolder !== originalRootFolder) {
			overrides.rootFolder = effectiveRootFolder;
		}
		if (clearedTagIds.size > 0) {
			// Omitted tags mean preserve upstream tags; [] means explicit removal.
			overrides.serverId = selectedServer.server.id;
			overrides.tags = selectedTags;
		}

		approveMutation.mutate(
			{
				instanceId,
				requestId: request.id,
				overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
			},
			{
				onSuccess: () => {
					toast.success(
						Object.keys(overrides).length > 0
							? "Request approved with custom profile"
							: "Request approved",
					);
					onOpenChange(false);
				},
				onError: (error) => notifySeerrActionError(error, "Failed to approve request"),
			},
		);
	};

	const isLoading = optionsQuery.isLoading;
	const hasError = optionsQuery.isError;
	const busy = isLoading || optionsQuery.isFetching;
	const noServers = !busy && !hasError && coverage === "complete" && filteredServers.length === 0;
	const unavailable = hasError || coverage === "unknown" || coverage === "unavailable";
	const showRecovery =
		!isLoading && (unavailable || coverage === "partial" || (!verifiedSelection && !noServers));
	const submitDisabled = approveMutation.isPending || busy || unavailable || !verifiedSelection;
	const profileAvailable = selectedServer?.profiles.some((p) => p.id === effectiveProfileId);
	const folderAvailable = selectedServer?.rootFolders.some((f) => f.path === effectiveRootFolder);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Approve with quality profile</DialogTitle>
					<DialogDescription>
						Pick the profile, root folder, and server for this request. Defaults to the current
						selection.
					</DialogDescription>
				</DialogHeader>

				{isLoading && (
					<div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						Loading options…
					</div>
				)}

				{showRecovery && (
					<div
						role="alert"
						className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-foreground"
					>
						<p>
							{unavailable
								? "Request options are unavailable. Retry before approving."
								: coverage === "partial"
									? "Some request options are unavailable. Select a verified server before approving."
									: "Selected request options are unavailable. Select verified options before approving."}
						</p>
						{optionsQuery.data && (hasError || coverage === "unknown") && (
							<p>Displayed choices are last-known and cannot be used until verified.</p>
						)}
						{unavailableTagIds.length > 0 && (
							<div className="space-y-2">
								<p>
									Some existing request tags are unavailable on the selected server. Clearing them
									keeps all other tags and is applied only when you approve.
								</p>
								<Button
									type="button"
									variant="secondary"
									disabled={busy || unavailable || approveMutation.isPending}
									onClick={handleClearUnavailableTags}
								>
									Clear unavailable tags
								</Button>
							</div>
						)}
						<Button
							type="button"
							variant="secondary"
							disabled={busy || approveMutation.isPending}
							onClick={() => {
								void optionsQuery.refetch();
							}}
						>
							{busy ? "Retrying…" : "Retry"}
						</Button>
					</div>
				)}

				{noServers && (
					<div className="rounded-lg border border-border/40 bg-card/40 p-3 text-sm text-muted-foreground">
						No {request.is4k ? "4K " : ""}servers configured in Seerr for{" "}
						{mediaType === "movie" ? "movies" : "TV"}. Add a server in Seerr settings to customize
						approvals.
					</div>
				)}

				{!isLoading && filteredServers.length > 0 && (
					<div className="space-y-4">
						{(filteredServers.length > 1 || coverage !== "complete" || !selectedServer) && (
							<div className="space-y-1.5">
								<label
									htmlFor={serverFieldId}
									className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
								>
									Server
								</label>
								<NativeSelect
									id={serverFieldId}
									value={selectedServer?.server.id ?? ""}
									onChange={(e) => {
										if (e.target.value !== "") handleServerChange(Number(e.target.value));
									}}
								>
									{!selectedServer && (
										<SelectOption value="" disabled>
											Select a verified server
										</SelectOption>
									)}
									{filteredServers.map((s, index) => (
										<SelectOption key={s.server.id} value={s.server.id}>
											{incognitoMode
												? `${getLinuxServerName(s.server.name)} ${index + 1}`
												: s.server.name}
											{s.server.isDefault ? " (default)" : ""}
										</SelectOption>
									))}
								</NativeSelect>
							</div>
						)}

						{selectedServer && (
							<>
								<div className="space-y-1.5">
									<label
										htmlFor={profileFieldId}
										className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
									>
										Quality profile
									</label>
									<NativeSelect
										id={profileFieldId}
										value={profileAvailable ? effectiveProfileId : ""}
										onChange={(e) => {
											if (e.target.value === "") return;
											setServerId(selectedServer.server.id);
											setProfileId(Number(e.target.value));
										}}
									>
										{!profileAvailable && (
											<SelectOption value="" disabled>
												Select a verified profile
											</SelectOption>
										)}
										{selectedServer.profiles.map((p) => (
											<SelectOption key={p.id} value={p.id}>
												{p.name}
												{p.id === selectedServer.server.activeProfileId ? " (server default)" : ""}
											</SelectOption>
										))}
									</NativeSelect>
								</div>

								<div className="space-y-1.5">
									<label
										htmlFor={folderFieldId}
										className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
									>
										Root folder
									</label>
									<NativeSelect
										id={folderFieldId}
										value={folderAvailable ? effectiveRootFolder : ""}
										onChange={(e) => {
											if (e.target.value === "") return;
											setServerId(selectedServer.server.id);
											setRootFolder(e.target.value);
										}}
									>
										{!folderAvailable && (
											<SelectOption value="" disabled>
												Select a verified root folder
											</SelectOption>
										)}
										{selectedServer.rootFolders.map((f, index) => (
											<SelectOption key={f.id} value={f.path}>
												{incognitoMode ? `${getLinuxSavePath(f.path)} ${index + 1}` : f.path}
												{f.path === selectedServer.server.activeDirectory
													? " (server default)"
													: ""}
											</SelectOption>
										))}
									</NativeSelect>
								</div>
							</>
						)}
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="secondary"
						onClick={() => onOpenChange(false)}
						disabled={approveMutation.isPending}
					>
						Cancel
					</Button>
					<GradientButton onClick={handleApprove} disabled={submitDisabled}>
						{approveMutation.isPending ? (
							<span className="flex items-center gap-2">
								<Loader2 className="h-4 w-4 animate-spin" />
								Approving…
							</span>
						) : (
							"Approve"
						)}
					</GradientButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
