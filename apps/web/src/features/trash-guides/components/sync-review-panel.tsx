"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import { useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui/dialog";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useAcknowledgeSyncReview, useSyncHistory } from "../../../hooks/api/useSync";
import { getLinuxInstanceName, getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { getSyncHistoryStatusLabel } from "../lib/sync-history-status";

const PAGE_SIZE = 20;

export function SyncReviewPanel() {
	const services = useServicesQuery();
	const [selectedId, setSelectedId] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [incognito] = useIncognitoMode();
	const selectId = useId();
	const headingId = useId();
	const instances =
		services.data?.filter(
			(instance) => instance.service === "sonarr" || instance.service === "radarr",
		) ?? [];
	const selected = instances.find((instance) => instance.id === selectedId);
	const instanceLabel = (instance: ServiceInstanceSummary, index: number) =>
		incognito ? `${getLinuxInstanceName(instance.label)} ${index + 1}` : instance.label;

	return (
		<section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-border p-6">
			<div>
				<h2 id={headingId} className="text-lg font-semibold">
					Sync history and review
				</h2>
				<p className="text-sm text-muted-foreground">
					Select an instance to inspect its sync history. Uncertain results need review of the
					current ARR state.
				</p>
			</div>
			{services.isError ? (
				<div role="alert" className="space-y-2">
					<p>Instances are unavailable. Retry before reviewing syncs.</p>
					<Button variant="outline" onClick={() => void services.refetch()}>
						Retry instances
					</Button>
				</div>
			) : (
				<>
					<label htmlFor={selectId} className="block text-sm font-medium">
						Sync review instance
					</label>
					<select
						id={selectId}
						value={selected?.id ?? ""}
						disabled={services.isFetching || submitting}
						onChange={(event) => setSelectedId(event.target.value)}
						className="w-full rounded-lg border border-border bg-background p-2 text-foreground sm:max-w-md"
					>
						<option value="">Select a Sonarr or Radarr instance</option>
						{instances.map((instance, index) => (
							<option key={instance.id} value={instance.id}>
								{instanceLabel(instance, index)}
							</option>
						))}
					</select>
					{services.isPending ? (
						<p role="status">Loading instances…</p>
					) : instances.length === 0 ? (
						<p>No Sonarr or Radarr instances are available.</p>
					) : null}
					{selected ? (
						<InstanceSyncHistory
							key={selected.id}
							instanceId={selected.id}
							instanceLabel={instanceLabel(selected, instances.indexOf(selected))}
							ready={!services.isFetching}
							onSubmittingChange={setSubmitting}
						/>
					) : null}
				</>
			)}
		</section>
	);
}

function InstanceSyncHistory({
	instanceId,
	instanceLabel,
	ready,
	onSubmittingChange,
}: {
	instanceId: string;
	instanceLabel: string;
	ready: boolean;
	onSubmittingChange: (pending: boolean) => void;
}) {
	const [offset, setOffset] = useState(0);
	const history = useSyncHistory(instanceId, { limit: PAGE_SIZE, offset });
	const acknowledge = useAcknowledgeSyncReview();
	const submitting = useRef(false);
	const refreshButton = useRef<HTMLButtonElement>(null);
	const [selection, setSelection] = useState<{ id: string; revision: number } | null>(null);
	const [accepted, setAccepted] = useState(false);
	const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
	const [incognito] = useIncognitoMode();
	const checkboxId = useId();
	const available = ready && history.isSuccess && !history.isFetching;
	const busy = acknowledge.isPending || history.isFetching;
	const target =
		available && selection?.revision === history.dataUpdatedAt
			? history.data.syncs.find(
					(sync) =>
						sync.id === selection.id && sync.status === "UNCERTAIN" && sync.backupId === null,
				)
			: undefined;
	const templateLabel = (name: string) =>
		incognito ? getLinuxIsoName(name) : name || "Unavailable template";
	const clearConfirmation = () => {
		setSelection(null);
		setAccepted(false);
	};
	const changePage = (nextOffset: number) => {
		if (busy || !available || submitting.current) return;
		clearConfirmation();
		setNotice(null);
		setOffset(nextOffset);
	};
	const refresh = () => {
		if (acknowledge.isPending || submitting.current) return;
		clearConfirmation();
		void history.refetch();
	};
	const confirm = async () => {
		if (!target || !accepted || !available || acknowledge.isPending || submitting.current) return;
		submitting.current = true;
		onSubmittingChange(true);
		setNotice(null);
		try {
			// The server rechecks ownership, current status, backup linkage and CAS.
			const result = await acknowledge.mutateAsync({ syncId: target.id, instanceId });
			if (result?.success !== true || result.status !== "FAILED")
				throw new Error("Unverified review acknowledgment");
			setNotice({
				error: false,
				message:
					"Manual review recorded. No rollback was performed. Other operations may still need review.",
			});
		} catch {
			setNotice({
				error: true,
				message:
					"Manual review could not be recorded. Refresh sync history and review the current ARR state before trying again.",
			});
		} finally {
			clearConfirmation();
			// The existing hook invalidation does not match paginated history keys.
			// Refresh this page after success or refusal, without changing the POST result.
			await history.refetch();
			submitting.current = false;
			onSubmittingChange(false);
		}
	};

	return (
		<div className="space-y-4">
			{notice ? <p role={notice.error ? "alert" : "status"}>{notice.message}</p> : null}
			<Button ref={refreshButton} variant="outline" onClick={refresh} disabled={busy || !ready}>
				Refresh sync history
			</Button>
			{history.isPending ? (
				<p role="status">Loading sync history…</p>
			) : history.isError ? (
				<p role="alert">
					Sync history is unavailable. Refresh before reviewing or recording any action.
				</p>
			) : history.data ? (
				<>
					<p className="text-sm text-muted-foreground">
						Page {offset / PAGE_SIZE + 1} · {history.data.total} total syncs
					</p>
					{history.isFetching ? <p role="status">Refreshing sync history…</p> : null}
					{!history.data.syncs.some((sync) => sync.status === "UNCERTAIN") ? (
						<p>No uncertain syncs on this page.</p>
					) : null}
					{history.data.syncs.length === 0 ? (
						<p>No syncs on this page.</p>
					) : (
						<ul className="space-y-3">
							{history.data.syncs.map((sync) => (
								<li key={sync.id} className="space-y-2 rounded-lg border border-border p-4">
									<h3 className="break-words font-medium">{templateLabel(sync.templateName)}</h3>
									<p className="text-sm">
										{getSyncHistoryStatusLabel(sync.status)} · Started{" "}
										{new Date(sync.startedAt).toLocaleString()}
									</p>
									{sync.status === "UNCERTAIN" ? (
										sync.backupId === null ? (
											<>
												<p className="text-sm text-muted-foreground">
													No rollback ledger is linked. Review the current ARR state before
													accepting it manually.
												</p>
												<Button
													variant="outline"
													disabled={!available || acknowledge.isPending}
													onClick={() => {
														setAccepted(false);
														setSelection({ id: sync.id, revision: history.dataUpdatedAt });
													}}
												>
													Review current ARR state
												</Button>
											</>
										) : (
											<p className="text-sm text-muted-foreground">
												{typeof sync.backupId === "string"
													? "This sync has a rollback ledger. Manual acceptance is unavailable here; use the existing ledger recovery workflow."
													: "Backup linkage is unavailable. Refresh history before manual review."}
											</p>
										)
									) : null}
								</li>
							))}
						</ul>
					)}
					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							disabled={!available || busy || offset === 0}
							onClick={() => changePage(Math.max(0, offset - PAGE_SIZE))}
						>
							Previous sync page
						</Button>
						<Button
							variant="outline"
							disabled={!available || busy || offset + PAGE_SIZE >= history.data.total}
							onClick={() => changePage(offset + PAGE_SIZE)}
						>
							Next sync page
						</Button>
					</div>
				</>
			) : null}
			<Dialog
				open={!!target}
				onOpenChange={(open) => {
					if (!open && !acknowledge.isPending) clearConfirmation();
				}}
			>
				<DialogContent
					className="max-w-lg w-[calc(100%-2rem)]"
					onCloseAutoFocus={(event) => {
						// The reviewed row may disappear after invalidation; keep focus in the panel.
						event.preventDefault();
						refreshButton.current?.focus();
					}}
				>
					<DialogHeader>
						<DialogTitle>Record manual review</DialogTitle>
						<DialogDescription>
							Review {target ? templateLabel(target.templateName) : "this sync"} on {instanceLabel}{" "}
							in ARR before continuing. This records your acceptance of the current state. It does
							not roll back changes or resolve other operations that need review.
						</DialogDescription>
					</DialogHeader>
					<div className="flex items-start gap-3">
						<Checkbox
							id={checkboxId}
							checked={accepted}
							disabled={acknowledge.isPending}
							onCheckedChange={(checked) => setAccepted(checked === true)}
						/>
						<label htmlFor={checkboxId} className="text-sm">
							I reviewed the current ARR state and accept it.
						</label>
					</div>
					<DialogFooter>
						<Button variant="outline" disabled={acknowledge.isPending} onClick={clearConfirmation}>
							Cancel
						</Button>
						<Button
							disabled={!accepted || !target || acknowledge.isPending}
							onClick={() => void confirm()}
						>
							{acknowledge.isPending ? "Recording review…" : "Record manual review"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
