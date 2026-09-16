import type { HistorySourceV2 } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const incognitoState = vi.hoisted(() => ({ enabled: false }));

import { HistorySourceStatus } from "../history-source-status";

vi.mock("../../../../lib/incognito", () => ({
	getLinuxInstanceName: () => "Masked instance",
	useIncognitoMode: () => [incognitoState.enabled],
}));

const source: HistorySourceV2 = {
	instanceId: "instance-1",
	instanceName: "Private Host",
	service: "sonarr",
	providerStatus: {
		availability: "last-known",
		evidence: "positive-only",
		observedAt: "2026-09-01T00:00:00.000Z",
		ageSeconds: 1,
		latestAttempt: "successful",
		reasonCodes: ["positive-only"],
	},
	retainedObservationCount: 2,
};

describe("HistorySourceStatus", () => {
	beforeEach(() => {
		incognitoState.enabled = false;
	});
	it("shows bounded availability and retained wording only", () => {
		render(<HistorySourceStatus source={source} />);
		expect(screen.getByRole("status")).toHaveTextContent("last-known");
		expect(screen.getByRole("status")).toHaveTextContent("2 retained");
		expect(screen.queryByText(/reason|revision|cursor|epoch/i)).not.toBeInTheDocument();
	});

	it("masks the instance label in incognito mode", () => {
		incognitoState.enabled = true;
		render(<HistorySourceStatus source={source} />);
		expect(screen.getByRole("status")).toHaveTextContent("Masked instance");
		expect(screen.getByRole("status")).not.toHaveTextContent("Private Host");
	});
});
