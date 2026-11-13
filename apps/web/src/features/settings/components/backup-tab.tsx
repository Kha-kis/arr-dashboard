"use client";

import { useState } from "react";
import { useRestoreState } from "../../../hooks/api/useBackup";
import { BackupCreateCard } from "./backup-create-card";
import { BackupEncryptionSection } from "./backup-encryption-section";
import { BackupListSection } from "./backup-list-section";
import { BackupRestoreCard } from "./backup-restore-card";
import { BackupScheduleSection } from "./backup-schedule-section";

export const BackupTab = () => {
	const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);
	const [formLocked, setFormLocked] = useState(false);
	const restore = useRestoreState();
	const locked = formLocked || restore.pending || restore.handoff !== null;
	return (
		<div className="min-w-0 space-y-8">
			<fieldset disabled={locked} className="min-w-0 space-y-8">
				<BackupEncryptionSection />
				<BackupScheduleSection />
			</fieldset>
			<div className="grid gap-6 lg:grid-cols-2">
				<fieldset disabled={locked} className="min-w-0">
					<BackupCreateCard />
				</fieldset>
				<BackupRestoreCard
					key={selectedBackupId ?? "upload"}
					selectedBackupId={selectedBackupId}
					onSelectionClear={() => setSelectedBackupId(null)}
					onRecoveryStateChange={setFormLocked}
					requestError={requestError}
					onRequestErrorChange={setRequestError}
				/>
			</div>
			<fieldset disabled={locked} className="min-w-0">
				<BackupListSection
					onRestore={(id) => {
						setRequestError(null);
						setSelectedBackupId(id);
					}}
					disabled={locked}
				/>
			</fieldset>
		</div>
	);
};
