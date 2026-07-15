import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseAggregationConfigs = vi.fn();
const mockUpdate = { mutate: vi.fn(), isPending: false };

vi.mock("../../../../hooks/api/useNotifications", () => ({
	useAggregationConfigs: () => mockUseAggregationConfigs(),
	useUpdateAggregationConfigs: () => mockUpdate,
}));

vi.mock("@/hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "rgb(1, 2, 3)" },
	}),
}));

import { AggregationConfig } from "../aggregation-config";

describe("AggregationConfig", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders a stable empty configuration while the query has no data", () => {
		mockUseAggregationConfigs.mockReturnValue({ data: undefined, isLoading: false });

		render(<AggregationConfig />);

		expect(screen.getByText("Event Aggregation")).toBeInTheDocument();
	});
});
