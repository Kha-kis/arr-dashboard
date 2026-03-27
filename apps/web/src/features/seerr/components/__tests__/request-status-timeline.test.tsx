import type { SeerrRequest } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RequestStatusTimeline } from "../request-status-timeline";

// ============================================================================
// Test data factory
// ============================================================================

function makeRequest(overrides: Partial<SeerrRequest> = {}): SeerrRequest {
	return {
		id: 1,
		status: 1,
		type: "movie",
		is4k: false,
		createdAt: "2024-06-01T12:00:00Z",
		updatedAt: "2024-06-01T12:00:00Z",
		requestedBy: {
			id: 1,
			displayName: "Alice",
			createdAt: "2024-01-01",
			updatedAt: "2024-01-01",
			permissions: 0,
			requestCount: 5,
			userType: 1,
		},
		media: {
			id: 1,
			tmdbId: 123,
			status: 1,
			createdAt: "2024-06-01",
			updatedAt: "2024-06-01",
		},
		...overrides,
	};
}

// Helper to get all visible stage labels
function getStageLabels(container: HTMLElement): string[] {
	// In compact mode, labels are inside spans; in expanded mode, they're in text nodes
	// Both variants render labels inside elements with the stage label as text content
	const labels: string[] = [];

	// For compact: check title attributes
	container.querySelectorAll("[title]").forEach((el) => {
		const title = el.getAttribute("title");
		if (title) {
			const label = title.split(" by ")[0]!;
			if (!labels.includes(label)) labels.push(label);
		}
	});

	// If no titles found (expanded mode), look for text content in stage labels
	if (labels.length === 0) {
		container.querySelectorAll("span").forEach((el) => {
			const text = el.textContent?.trim();
			if (
				text &&
				[
					"Requested",
					"Pending",
					"Approved",
					"Processing",
					"Available",
					"Partial",
					"Declined",
					"Failed",
					"Blocklisted",
					"Deleted",
				].includes(text)
			) {
				labels.push(text);
			}
		});
	}

	return labels;
}

// ============================================================================
// Compact variant tests
// ============================================================================

describe("RequestStatusTimeline — compact", () => {
	it("shows pending flow: Requested → Pending → Processing → Available", () => {
		const request = makeRequest({ status: 1 });
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Pending", "Processing", "Available"]);
	});

	it("shows approved + media unknown: Requested → Approved → Processing → Available", () => {
		const request = makeRequest({
			status: 2,
			updatedAt: "2024-06-02T12:00:00Z",
			modifiedBy: {
				id: 2,
				displayName: "Admin",
				createdAt: "2024-01-01",
				updatedAt: "2024-01-01",
				permissions: 0,
				requestCount: 0,
				userType: 1,
			},
			media: { id: 1, tmdbId: 123, status: 1, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" modifierName="Admin" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Approved", "Processing", "Available"]);
	});

	it("shows approved + processing: Processing stage is active", () => {
		const request = makeRequest({
			status: 2,
			media: { id: 1, tmdbId: 123, status: 3, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Approved", "Processing", "Available"]);
	});

	it("shows approved + available: all stages completed", () => {
		const request = makeRequest({
			status: 2,
			media: { id: 1, tmdbId: 123, status: 5, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Approved", "Processing", "Available"]);
	});

	it("shows partially available as 'Partial'", () => {
		const request = makeRequest({
			status: 2,
			media: { id: 1, tmdbId: 123, status: 4, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Approved", "Processing", "Partial"]);
	});

	it("shows declined: Requested → Declined", () => {
		const request = makeRequest({
			status: 3,
			updatedAt: "2024-06-02T12:00:00Z",
			modifiedBy: {
				id: 2,
				displayName: "Admin",
				createdAt: "2024-01-01",
				updatedAt: "2024-01-01",
				permissions: 0,
				requestCount: 0,
				userType: 1,
			},
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" modifierName="Admin" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Declined"]);
	});

	it("shows failed: Requested → Failed", () => {
		const request = makeRequest({ status: 4 });
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Failed"]);
	});

	it("shows blocklisted media: Requested → Approved → Processing → Blocklisted", () => {
		const request = makeRequest({
			status: 2,
			media: { id: 1, tmdbId: 123, status: 6, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Approved", "Processing", "Blocklisted"]);
	});

	it("shows deleted media: Requested → Approved → Processing → Deleted", () => {
		const request = makeRequest({
			status: 2,
			media: { id: 1, tmdbId: 123, status: 7, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Approved", "Processing", "Deleted"]);
	});

	it("shows completed stages for COMPLETED request with UNKNOWN media", () => {
		const request = makeRequest({
			status: 5,
			media: { id: 1, tmdbId: 123, status: 1, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Approved", "Processing", "Available"]);
	});

	it("shows Processing as active when media is PENDING (queued)", () => {
		const request = makeRequest({
			status: 2,
			media: { id: 1, tmdbId: 123, status: 2, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labels = getStageLabels(container);
		expect(labels).toEqual(["Requested", "Approved", "Processing", "Available"]);
	});

	it("has aria-label on compact stage wrappers for screen readers", () => {
		const request = makeRequest({ status: 1 });
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" />,
		);
		const labeledElements = container.querySelectorAll("[aria-label]");
		expect(labeledElements.length).toBeGreaterThanOrEqual(4);
		expect(labeledElements[0]?.getAttribute("aria-label")).toBe("Requested");
	});

	it("includes actor attribution in title for declined stage", () => {
		const request = makeRequest({
			status: 3,
			updatedAt: "2024-06-02T12:00:00Z",
			modifiedBy: {
				id: 2,
				displayName: "Admin",
				createdAt: "2024-01-01",
				updatedAt: "2024-01-01",
				permissions: 0,
				requestCount: 0,
				userType: 1,
			},
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="compact" modifierName="Admin" />,
		);
		const declinedEl = container.querySelector('[title="Declined by Admin"]');
		expect(declinedEl).toBeTruthy();
	});
});

// ============================================================================
// Expanded variant tests
// ============================================================================

describe("RequestStatusTimeline — expanded", () => {
	it("renders stage labels as visible text", () => {
		const request = makeRequest({ status: 1 });
		render(<RequestStatusTimeline request={request} variant="expanded" />);

		expect(screen.getByText("Requested")).toBeTruthy();
		expect(screen.getByText("Pending")).toBeTruthy();
		expect(screen.getByText("Processing")).toBeTruthy();
		expect(screen.getByText("Available")).toBeTruthy();
	});

	it("shows actor attribution with 'by' prefix for approved request", () => {
		const request = makeRequest({
			status: 2,
			modifiedBy: {
				id: 2,
				displayName: "Admin",
				createdAt: "2024-01-01",
				updatedAt: "2024-01-01",
				permissions: 0,
				requestCount: 0,
				userType: 1,
			},
			media: { id: 1, tmdbId: 123, status: 1, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		render(
			<RequestStatusTimeline request={request} variant="expanded" modifierName="Admin" />,
		);
		expect(screen.getByText("by Admin")).toBeTruthy();
	});

	it("does not show updatedAt timestamp on approval when media has progressed to processing", () => {
		const request = makeRequest({
			status: 2,
			updatedAt: "2024-06-05T12:00:00Z",
			media: { id: 1, tmdbId: 123, status: 3, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="expanded" />,
		);
		// The expanded timeline renders timestamps with Clock icon + formatRelativeTime
		// There should only be 1 timestamp (for "Requested"), not 2
		const clockIcons = container.querySelectorAll(".h-2\\.5.w-2\\.5");
		expect(clockIcons.length).toBe(1);
	});

	it("shows updatedAt timestamp on approval when media is still unknown", () => {
		const request = makeRequest({
			status: 2,
			updatedAt: "2024-06-05T12:00:00Z",
			media: { id: 1, tmdbId: 123, status: 1, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		const { container } = render(
			<RequestStatusTimeline request={request} variant="expanded" />,
		);
		// Should have 2 timestamps (Requested + Approved)
		const clockIcons = container.querySelectorAll(".h-2\\.5.w-2\\.5");
		expect(clockIcons.length).toBe(2);
	});

	it("shows declined flow with Failed stage label", () => {
		const request = makeRequest({ status: 3 });
		render(<RequestStatusTimeline request={request} variant="expanded" />);
		expect(screen.getByText("Requested")).toBeTruthy();
		expect(screen.getByText("Declined")).toBeTruthy();
	});

	it("shows completed request (status 5) with available media as fully complete", () => {
		const request = makeRequest({
			status: 5,
			media: { id: 1, tmdbId: 123, status: 5, createdAt: "2024-06-01", updatedAt: "2024-06-01" },
		});
		render(<RequestStatusTimeline request={request} variant="expanded" />);
		expect(screen.getByText("Requested")).toBeTruthy();
		expect(screen.getByText("Approved")).toBeTruthy();
		expect(screen.getByText("Processing")).toBeTruthy();
		expect(screen.getByText("Available")).toBeTruthy();
	});
});
