import type {
	ProviderObservationAvailability,
	ProviderObservationStatus,
	ProviderObservationStatusEnvelope,
} from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	ProviderObservationNotice,
	resolveProviderObservationAvailability,
} from "../provider-observation-notice";

function envelope(
	...availabilities: ProviderObservationAvailability[]
): ProviderObservationStatusEnvelope {
	return {
		availability: availabilities[0] ?? "current",
		sources: availabilities.map((availability, index) => ({
			instanceId: `private-instance-${index}`,
			service: index % 2 === 0 ? "jellyfin" : "emby",
			cacheType: "jellyfin",
			status: {
				availability,
				evidence: availability === "current" ? "complete" : "unknown",
				observedAt: "2026-09-03T00:00:00.000Z",
				ageSeconds: 10,
				latestAttempt: "successful",
				reasonCodes: availability === "current" ? [] : ["unknown-failure"],
			},
		})),
	};
}

describe("resolveProviderObservationAvailability", () => {
	it.each([
		["no status", undefined, false, undefined],
		["all current", envelope("current", "current"), false, "current"],
		["all last-known", envelope("last-known", "last-known"), false, "last-known"],
		["all unavailable", envelope("unavailable", "unavailable"), false, "unavailable"],
		["mixed", [envelope("current"), envelope("last-known")] as const, false, "partial"],
		[
			"current plus unavailable",
			[envelope("current"), envelope("unavailable")] as const,
			false,
			"partial",
		],
		["partial", envelope("partial"), false, "partial"],
		["transport error", undefined, true, "unavailable"],
		["current plus transport error", envelope("current"), true, "partial"],
	] as const)("resolves %s", (_name, status, isError, expected) => {
		expect(resolveProviderObservationAvailability(status, isError)).toBe(expected);
	});
});

describe("ProviderObservationNotice", () => {
	it("renders nothing for absent and all-current status", () => {
		const { container, rerender } = render(<ProviderObservationNotice />);
		expect(container).toBeEmptyDOMElement();

		rerender(<ProviderObservationNotice providerStatus={envelope("current", "current")} />);
		expect(container).toBeEmptyDOMElement();
	});

	it.each([
		[
			"last-known",
			envelope("last-known"),
			/Showing last-known media-server data/i,
			/latest observation may be stale/i,
		],
		[
			"partial",
			envelope("partial"),
			/Media-server data is unavailable/i,
			/Results may be missing or stale/i,
		],
		[
			"unavailable",
			envelope("unavailable"),
			/Media-server data is unavailable/i,
			/Results may be missing or stale/i,
		],
	] as const)("renders fixed %s copy", (_name, providerStatus, heading, detail) => {
		render(<ProviderObservationNotice providerStatus={providerStatus} />);

		expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
		expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
		expect(screen.getByText(heading)).toBeInTheDocument();
		expect(screen.getByText(detail)).toBeInTheDocument();
		expect(screen.getByRole("status").querySelector("[aria-hidden='true']")).not.toBeNull();
	});

	it("renders a direct provider status", () => {
		const status: ProviderObservationStatus = {
			availability: "partial",
			evidence: "positive-only",
			observedAt: "2026-09-03T00:00:00.000Z",
			ageSeconds: 10,
			latestAttempt: "successful",
			reasonCodes: ["positive-only"],
		};

		render(<ProviderObservationNotice providerStatus={status} />);

		expect(screen.getByText(/Showing current mapped data/i)).toBeInTheDocument();
	});

	it("renders invalid partial provider evidence as unavailable", () => {
		render(
			<ProviderObservationNotice
				providerStatus={{
					availability: "partial",
					evidence: "partial",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "successful",
					reasonCodes: ["receipt-invalid"],
				}}
			/>,
		);

		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
	});

	it("preserves the last-known warning when its UI condition is unavailable", () => {
		render(<ProviderObservationNotice providerStatus={envelope("last-known")} />);
		expect(screen.getByText(/Showing last-known media-server data/i)).toBeInTheDocument();
		expect(screen.queryByText(/Media-server data is unavailable/i)).not.toBeInTheDocument();
	});

	it("prioritizes an active collection over an unrelated unavailable source", () => {
		const collecting: ProviderObservationStatus = {
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "running",
			reasonCodes: ["no-publication", "refresh-running"],
		};
		render(<ProviderObservationNotice providerStatus={[collecting, envelope("unavailable")]} />);
		expect(screen.getAllByRole("status")).toHaveLength(1);
		expect(screen.getByText(/Media-server data is being collected/i)).toBeInTheDocument();
		expect(screen.queryByText(/data is unavailable/i)).not.toBeInTheDocument();
	});

	it("renders current mapped data as one informational provider-agnostic notice without a retry action", () => {
		const status: ProviderObservationStatus = {
			availability: "partial",
			evidence: "partial",
			observedAt: "2026-09-03T00:00:00.000Z",
			ageSeconds: 10,
			latestAttempt: "successful",
			reasonCodes: ["accepted-skips", "coverage-incomplete"],
			domains: [
				{
					domain: "library-inventory",
					availability: "current",
					evidence: "complete",
					valueSemantics: "exact",
					observedAt: "2026-09-03T00:00:00.000Z",
					reasonCodes: [],
				},
				{
					domain: "mapping",
					availability: "current",
					evidence: "partial",
					valueSemantics: "lower-bound",
					observedAt: "2026-09-03T00:00:00.000Z",
					reasonCodes: ["accepted-skips"],
				},
			],
		};

		render(<ProviderObservationNotice providerStatus={status} label="Media server" />);

		expect(screen.getAllByRole("status")).toHaveLength(1);
		expect(screen.getByText(/Showing current mapped data/i)).toBeInTheDocument();
		expect(
			screen.getByText(/Media server: Some unsupported items were excluded/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/Retry refresh/i)).not.toBeInTheDocument();
		expect(screen.getByRole("status")).not.toHaveStyle({ backgroundColor: "#fef2f2" });
	});

	it("keeps a static label separate from provider status fields", () => {
		const privacyStatus = {
			...envelope("partial"),
			baseUrl: "https://private.invalid/server",
			apiKey: "private-api-key",
			credential: "private-credential",
			token: "private-token",
			title: "Private Title",
			username: "private-user",
		} as unknown as ProviderObservationStatusEnvelope;
		render(<ProviderObservationNotice providerStatus={privacyStatus} label="On Deck" />);

		expect(screen.getByText(/On Deck: Results may be missing or stale/i)).toBeInTheDocument();
		const body = document.body.textContent ?? "";
		for (const privateMarker of [
			"private-instance-0",
			"unknown-failure",
			"2026-09-03T00:00:00.000Z",
			"private.invalid",
			"Private Title",
			"private-user",
			"private-api-key",
			"private-credential",
			"private-token",
		]) {
			expect(body).not.toContain(privateMarker);
		}
	});
});
