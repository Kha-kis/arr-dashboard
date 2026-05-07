"use client";

/**
 * Approval dialog that lets an admin pick a quality profile, root folder, and
 * (optionally) tags + server before approving a Seerr request.
 *
 * Reuses the same `request-options` endpoint that the request-creation form uses,
 * so all configured Radarr/Sonarr servers + their profiles are already cached when
 * this dialog opens.
 */

import type { SeerrRequest, SeerrServerWithDetails } from "@arr/shared";
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

interface ApproveWithOptionsDialogProps {
	request: SeerrRequest;
	instanceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** Returns the server matching `serverId` or, if none match, the default/first server. */
function resolveSelectedServer(
	servers: SeerrServerWithDetails[],
	serverId: number | undefined,
): SeerrServerWithDetails | undefined {
	if (servers.length === 0) return undefined;
	if (serverId !== undefined) {
		const match = servers.find((s) => s.server.id === serverId);
		if (match) return match;
	}
	return servers.find((s) => s.server.isDefault) ?? servers[0];
}

export const ApproveWithOptionsDialog = ({
	request,
	instanceId,
	open,
	onOpenChange,
}: ApproveWithOptionsDialogProps) => {
	const profileFieldId = useId();
	const folderFieldId = useId();
	const serverFieldId = useId();

	const mediaType = request.type;
	const optionsQuery = useSeerrRequestOptions(instanceId, mediaType);
	const approveMutation = useApproveSeerrRequest();

	const servers = useMemo(() => optionsQuery.data?.servers ?? [], [optionsQuery.data?.servers]);

	// Filter to non-4K servers when the request is non-4K (and vice-versa) so
	// the admin can't pick a profile from an incompatible server.
	const filteredServers = useMemo(
		() => servers.filter((s) => s.server.is4k === request.is4k),
		[servers, request.is4k],
	);

	const [serverId, setServerId] = useState<number | undefined>(request.serverId);
	const [profileId, setProfileId] = useState<number | undefined>(request.profileId);
	const [rootFolder, setRootFolder] = useState<string | undefined>(request.rootFolder);

	const selectedServer = useMemo(
		() => resolveSelectedServer(filteredServers, serverId),
		[filteredServers, serverId],
	);

	// When the dialog opens or servers load, default selection to the request's
	// current values (or the server defaults if the request has none yet).
	useEffect(() => {
		if (!open || filteredServers.length === 0) return;
		const server = resolveSelectedServer(filteredServers, request.serverId);
		if (!server) return;
		setServerId(server.server.id);
		setProfileId(request.profileId ?? server.server.activeProfileId);
		setRootFolder(request.rootFolder ?? server.server.activeDirectory);
	}, [open, filteredServers, request.serverId, request.profileId, request.rootFolder]);

	// When the user changes server, reset profile + folder to that server's defaults.
	const handleServerChange = (nextServerId: number) => {
		const next = filteredServers.find((s) => s.server.id === nextServerId);
		if (!next) return;
		setServerId(next.server.id);
		setProfileId(next.server.activeProfileId);
		setRootFolder(next.server.activeDirectory);
	};

	const handleApprove = () => {
		const overrides: {
			serverId?: number;
			profileId?: number;
			rootFolder?: string;
		} = {};
		// Compare against the *effective* current values — the request's own fields
		// when set, otherwise the selected server's defaults. This way a confirm
		// without changes doesn't fire a pointless PUT or write `overridden: true`
		// to the audit log for first-time-routed requests.
		const effectiveServerId = request.serverId ?? selectedServer?.server.id;
		const effectiveProfileId = request.profileId ?? selectedServer?.server.activeProfileId;
		const effectiveRootFolder = request.rootFolder ?? selectedServer?.server.activeDirectory;

		if (serverId !== undefined && serverId !== effectiveServerId) {
			overrides.serverId = serverId;
		}
		if (profileId !== undefined && profileId !== effectiveProfileId) {
			overrides.profileId = profileId;
		}
		if (rootFolder && rootFolder !== effectiveRootFolder) {
			overrides.rootFolder = rootFolder;
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
				onError: () => toast.error("Failed to approve request"),
			},
		);
	};

	const isLoading = optionsQuery.isLoading;
	const hasError = optionsQuery.isError;
	const noServers = !isLoading && !hasError && filteredServers.length === 0;
	const submitDisabled = approveMutation.isPending || isLoading || noServers;

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

				{hasError && (
					<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
						Failed to load quality profiles from Seerr. Approving will fall back to the server
						defaults.
					</div>
				)}

				{noServers && (
					<div className="rounded-lg border border-border/40 bg-card/40 p-3 text-sm text-muted-foreground">
						No {request.is4k ? "4K " : ""}servers configured in Seerr for{" "}
						{mediaType === "movie" ? "movies" : "TV"}. Add a server in Seerr settings to customize
						approvals.
					</div>
				)}

				{!isLoading && filteredServers.length > 0 && selectedServer && (
					<div className="space-y-4">
						{filteredServers.length > 1 && (
							<div className="space-y-1.5">
								<label
									htmlFor={serverFieldId}
									className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
								>
									Server
								</label>
								<NativeSelect
									id={serverFieldId}
									value={serverId ?? ""}
									onChange={(e) => handleServerChange(Number(e.target.value))}
								>
									{filteredServers.map((s) => (
										<SelectOption key={s.server.id} value={s.server.id}>
											{s.server.name}
											{s.server.isDefault ? " (default)" : ""}
										</SelectOption>
									))}
								</NativeSelect>
							</div>
						)}

						<div className="space-y-1.5">
							<label
								htmlFor={profileFieldId}
								className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
							>
								Quality profile
							</label>
							<NativeSelect
								id={profileFieldId}
								value={profileId ?? ""}
								onChange={(e) => setProfileId(Number(e.target.value))}
							>
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
								value={rootFolder ?? ""}
								onChange={(e) => setRootFolder(e.target.value)}
							>
								{selectedServer.rootFolders.map((f) => (
									<SelectOption key={f.id} value={f.path}>
										{f.path}
										{f.path === selectedServer.server.activeDirectory ? " (server default)" : ""}
									</SelectOption>
								))}
							</NativeSelect>
						</div>
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
