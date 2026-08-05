import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuiStatusBadge } from "../qui-status-badge";

describe("QuiStatusBadge", () => {
	it.each([
		["not_in_qui", "qUI cache: no match"],
		["seeding", "qUI cache: active"],
		["paused_or_error", "qUI cache: inactive"],
	] as const)("labels %s as cached informational evidence", (status, label) => {
		render(<QuiStatusBadge status={status} observedAt="2026-07-30T12:00:00.000Z" />);

		const badge = screen.getByText(label);
		expect(badge).toHaveAttribute("title", expect.stringContaining("informational only"));
		expect(badge).toHaveAttribute(
			"title",
			expect.stringContaining("checks every enabled qUI again immediately before deleting files"),
		);
		expect(badge.textContent?.toLowerCase()).not.toContain("safe");
		expect(badge.getAttribute("title")?.toLowerCase()).not.toContain("safe");
	});

	it("renders no qUI claim when the preview has no cached signal", () => {
		const { container } = render(<QuiStatusBadge status="no_signal" />);

		expect(container).toBeEmptyDOMElement();
	});
});
