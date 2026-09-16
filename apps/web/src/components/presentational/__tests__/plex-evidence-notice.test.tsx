import type { PlexEvidenceSummary } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/api-client/base";
import { PlexEvidenceNotice, PlexQueryEvidenceNotice } from "../plex-evidence-notice";

const partialEvidence: PlexEvidenceSummary = {
	availability: "current",
	authority: "positive-only",
	attemptState: "partial",
	publicationLevel: "positive-only",
	completeness: "partial",
	reasonCodes: ["latest_attempt_partial"],
};

const lastKnownEvidence: PlexEvidenceSummary = {
	availability: "last-known",
	authority: "unavailable",
	attemptState: "error",
	publicationLevel: "unavailable",
	completeness: "unknown",
	reasonCodes: ["latest_attempt_failed"],
};

describe("PlexQueryEvidenceNotice", () => {
	it("identifies retained positive observations as last-known after a failed refresh", () => {
		render(
			<PlexEvidenceNotice
				evidence={{
					...partialEvidence,
					availability: "last-known",
					authority: "unavailable",
					attemptState: "error",
					reasonCodes: ["latest_attempt_failed"],
				}}
				hasDisplayedValues
			/>,
		);
		expect(screen.getByText("Showing last-known Plex values")).toBeInTheDocument();
		expect(screen.getByText(/omitted rows remain unknown/i)).toBeInTheDocument();
	});

	it("labels displayed positive observations as last-known during refresh", () => {
		render(
			<PlexEvidenceNotice
				evidence={{
					...partialEvidence,
					availability: "last-known",
					authority: "unavailable",
					attemptState: "in_progress",
					reasonCodes: ["latest_attempt_in_progress"],
				}}
				hasDisplayedValues
			/>,
		);
		expect(screen.getByText("Plex refresh in progress")).toBeInTheDocument();
		expect(
			screen.getByText(/Showing last-known Plex values while refresh is in progress/i),
		).toBeInTheDocument();
		expect(screen.getByText(/omitted rows remain unknown/i)).toBeInTheDocument();
	});

	it("distinguishes partial evidence while displaying confirmed rows", () => {
		render(<PlexEvidenceNotice evidence={partialEvidence} hasDisplayedValues />);

		expect(screen.getByText(/Plex values are incomplete/i)).toBeInTheDocument();
		expect(
			screen.getByText(/confirmed Plex rows are shown; omitted rows remain unknown/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/in_progress:/i)).not.toBeInTheDocument();
	});

	it("distinguishes retained last-known evidence while displaying rows", () => {
		render(<PlexEvidenceNotice evidence={lastKnownEvidence} hasDisplayedValues />);

		expect(screen.getByText(/Showing last-known Plex values/i)).toBeInTheDocument();
		expect(
			screen.getByText(/confirmed Plex rows are shown; omitted rows remain unknown/i),
		).toBeInTheDocument();
	});

	it.each([
		["partial", partialEvidence, /Plex values are incomplete/i],
		["last-known", lastKnownEvidence, /Showing last-known Plex values/i],
	] as const)("keeps %s state truthful when no rows are displayed", (_name, evidence, title) => {
		render(<PlexEvidenceNotice evidence={evidence} />);

		expect(screen.getByText(title)).toBeInTheDocument();
		expect(
			screen.getByText(/No Plex rows are being shown; absence remains unknown/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/confirmed Plex rows are shown/i)).not.toBeInTheDocument();
	});

	it("identifies degraded multi-source coverage without hiding displayed rows", () => {
		render(
			<PlexEvidenceNotice
				evidence={{ ...lastKnownEvidence, availability: "unavailable" }}
				hasDisplayedValues
			/>,
		);

		expect(screen.getByText(/Plex coverage is degraded/i)).toBeInTheDocument();
	});

	it("keeps unavailable and refresh-in-progress states bounded", () => {
		const unavailableEvidence: PlexEvidenceSummary = {
			...lastKnownEvidence,
			availability: "unavailable",
		};
		const { rerender } = render(<PlexEvidenceNotice evidence={unavailableEvidence} />);
		expect(screen.getByText(/Plex values are unavailable/i)).toBeInTheDocument();

		rerender(
			<PlexEvidenceNotice evidence={{ ...lastKnownEvidence, attemptState: "in_progress" }} />,
		);
		expect(screen.getByText(/Plex refresh in progress/i)).toBeInTheDocument();
		expect(screen.queryByText(/in_progress:/i)).not.toBeInTheDocument();
	});

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

		expect(screen.getByText(/Showing last-known Plex values/i)).toBeInTheDocument();
		expect(screen.getByText(/Series progress/i)).toBeInTheDocument();
		expect(
			screen.getByText(/No Plex rows are being shown; absence remains unknown/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/0%|0 watched|unwatched/i)).not.toBeInTheDocument();
	});

	it("keeps a strict 503 partial response incomplete without claiming rows", () => {
		const error = new ApiError("Plex cache evidence is unavailable", 503, {
			error: "Plex cache evidence is unavailable",
			evidence: partialEvidence,
		} as never);

		render(<PlexQueryEvidenceNotice error={error} label="Recently added" />);

		expect(screen.getByText(/Plex values are incomplete/i)).toBeInTheDocument();
		expect(
			screen.getByText(/No Plex rows are being shown; absence remains unknown/i),
		).toBeInTheDocument();
	});
});
