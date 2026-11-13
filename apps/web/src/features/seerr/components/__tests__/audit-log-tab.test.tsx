import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../hooks/api/useSeerr", () => ({
	useSeerrAuditLog: () => ({
		isLoading: false,
		data: [
			{
				id: "synthetic-1",
				action: "approve_request",
				targetType: "request",
				targetId: "1",
				detail: { outcome: "unknown" },
				success: false,
				createdAt: "2026-09-28T00:00:00.000Z",
			},
		],
	}),
}));
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#000", fromLight: "#eee", fromMuted: "#ddd" } }),
}));

import { AuditLogTab } from "../audit-log-tab";

describe("Seerr action audit", () => {
	it("shows an ambiguous action as Unknown rather than Failed", () => {
		render(<AuditLogTab instanceId="synthetic-instance" />);
		expect(screen.getByText("Unknown")).toBeInTheDocument();
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
	});
});
