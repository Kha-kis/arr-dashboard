import type {
	ManualImportCandidate,
	ManualImportCandidateRadarr,
	ManualImportCandidateSonarr,
	ManualImportRejection,
	ManualImportSubmissionFile,
} from "@arr/shared";

export type ManualImportService = "sonarr" | "radarr" | "lidarr" | "readarr";

export type ManualImportCandidateUnion = ManualImportCandidate;
export type ManualImportSonarrCandidate = ManualImportCandidateSonarr;
export type ManualImportRadarrCandidate = ManualImportCandidateRadarr;

export type ManualImportSelection = {
	candidateId: ManualImportCandidateUnion["id"];
	service: ManualImportService;
	instanceId: string;
	downloadId: string;
	values: ManualImportSubmissionFile;
	rejected?: boolean;
};

export type ManualImportState = {
	selections: ManualImportSelection[];
	rejectedFiles: string[];
	lastError?: string;
};

export type ManualImportResult = {
	status: "success";
	imported: number;
};

export type ManualImportModalProps = {
	instanceId: string;
	instanceName: string;
	service: ManualImportService;
	downloadId?: string;
	folder?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCompleted?: (result: ManualImportResult) => void;
};

export type ManualImportCandidateRow = {
	candidate: ManualImportCandidateUnion;
	rejected: boolean;
	rejectionReason?: string;
};

export { ManualImportCandidate, ManualImportRejection, ManualImportSubmissionFile };
