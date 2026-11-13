import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeerrEnrichmentNotice } from "../seerr-enrichment-notice";

describe("SeerrEnrichmentNotice", () => {
	it("surfaces partial issue-count coverage without claiming an empty count", () => {
		render(<SeerrEnrichmentNotice configured isError={false} issueCountsAvailable={false} />);
		expect(screen.getByRole("status")).toHaveTextContent("issue counts unavailable");
	});

	it("surfaces a whole-query failure", () => {
		render(<SeerrEnrichmentNotice configured isError />);
		expect(screen.getByRole("status")).toHaveTextContent("Seerr Library enrichment unavailable");
	});

	it("stays absent for verified complete enrichment", () => {
		render(<SeerrEnrichmentNotice configured isError={false} issueCountsAvailable />);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
