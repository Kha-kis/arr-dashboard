import type { PlexEvidenceSummary } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/api-client/base";
import { PlexQueryEvidenceNotice } from "../plex-evidence-notice";

describe("PlexQueryEvidenceNotice", () => {
	it("renders progress evidence as unavailable without fabricating 0%", () => {
		const evidence: PlexEvidenceSummary = {
			availability: "last-known",
			authority: "unavailable",
			attemptState: "error",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: ["latest_attempt_failed"],
		};
		const error = new ApiError("Plex cache evidence is unavailable", 503, {
			error: "Plex cache evidence is unavailable",
			evidence,
		} as never);

		render(<PlexQueryEvidenceNotice error={error} label="Series progress" />);

		expect(screen.getByText(/Plex values are unavailable/i)).toBeInTheDocument();
		expect(screen.getByText(/Series progress/i)).toBeInTheDocument();
		expect(screen.queryByText(/0%|0 watched|unwatched/i)).not.toBeInTheDocument();
	});
});
