import type { DashboardStatisticsEnvelope } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IncognitoProvider } from "../../../contexts/IncognitoContext";
import * as notice from "../dashboard-statistics-notice";

const DATA = {
	sonarr: { instances: [] },
	radarr: { instances: [] },
	prowlarr: { instances: [] },
	lidarr: { instances: [] },
	readarr: { instances: [] },
};
const OBSERVED = "2026-09-29T11:44:00.000Z";

function mount(state: DashboardStatisticsEnvelope) {
	const Notice = Reflect.get(notice, "DashboardStatisticsNotice") as
		| React.ComponentType<{ state: DashboardStatisticsEnvelope }>
		| undefined;
	return render(<IncognitoProvider>{Notice ? <Notice state={state} /> : null}</IncognitoProvider>);
}

describe("Dashboard statistics availability notice", () => {
	it("names collecting and unavailable states without zero totals", () => {
		mount({ availability: "collecting", observedAt: null, data: null });
		expect(screen.getByText(/collecting statistics/i)).toBeVisible();
		expect(screen.queryByText(/\b0\b/)).not.toBeInTheDocument();
	});

	it("labels partial observations with their UTC time", () => {
		mount({ availability: "partial", observedAt: OBSERVED, data: DATA });
		expect(screen.getByText(/partial/i)).toHaveTextContent(/11:44 UTC/);
	});

	it("labels last-known observations with their UTC time", () => {
		mount({ availability: "last-known", observedAt: OBSERVED, data: DATA });
		expect(screen.getByText(/last-known/i)).toHaveTextContent(/11:44 UTC/);
	});

	it("does not add a warning to a current snapshot", () => {
		mount({ availability: "current", observedAt: OBSERVED, data: DATA });
		expect(screen.queryByText(/statistics/i)).not.toBeInTheDocument();
	});
});
