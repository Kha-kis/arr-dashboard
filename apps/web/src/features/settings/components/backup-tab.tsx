import { BackupCreateCard } from "./backup-create-card";
import { BackupEncryptionSection } from "./backup-encryption-section";
import { BackupListSection } from "./backup-list-section";
import { BackupRestoreCard } from "./backup-restore-card";
import { BackupScheduleSection } from "./backup-schedule-section";

export const BackupTab = () => {
	return (
		<div className="space-y-8">
			<BackupEncryptionSection />
			<BackupScheduleSection />
			<div className="grid gap-6 lg:grid-cols-2">
				<BackupCreateCard />
				<BackupRestoreCard />
			</div>
			<BackupListSection />
		</div>
	);
};
