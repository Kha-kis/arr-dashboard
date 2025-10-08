import { useState } from "react";
import type { ManualImportSelection } from "../types";
import { hasValidSelections } from "../store";
import { useManualImportMutation } from "../../../hooks/api/useManualImport";

interface UseImportSubmissionParams {
	instanceId: string;
	service: "sonarr" | "radarr";
	importMode: "auto" | "copy" | "move";
	onSuccess: (importedCount: number) => void;
}

export const useImportSubmission = ({
	instanceId,
	service,
	importMode,
	onSuccess,
}: UseImportSubmissionParams) => {
	const [error, setError] = useState<string | undefined>();
	const mutation = useManualImportMutation();

	const submit = async (selections: Record<string, ManualImportSelection>) => {
		setError(undefined);

		const selectionsForThisService = Object.values(selections).filter(
			(selection) => selection.service === service,
		);

		if (selectionsForThisService.length === 0) {
			setError("Select at least one file to import.");
			return;
		}

		if (!hasValidSelections(selections, service)) {
			setError("At least one selected file is missing required mappings.");
			return;
		}

		try {
			await mutation.mutateAsync({
				instanceId,
				service,
				importMode,
				files: selectionsForThisService.map((selection) => selection.values),
			});
			const importedCount = selectionsForThisService.length;
			onSuccess(importedCount);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Manual import failed.";
			setError(message);
		}
	};

	return {
		submit,
		error,
		setError,
		isPending: mutation.isPending,
	};
};
