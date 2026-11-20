import { render, screen } from "@testing-library/react";
import { Tv } from "lucide-react";
import { describe, expect, it } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { SERVICE_GRADIENTS } from "../../../../lib/theme-gradients";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ArrServiceTab } from "../arr-service-tab";
import { ProwlarrTab } from "../prowlarr-tab";

describe("Statistics service-tab availability", () => {
	it("does not call a configured Sonarr instance unconfigured when its statistics fail", () => {
		render(
			<ColorThemeProvider>
				<IncognitoProvider>
					<ArrServiceTab
						serviceType="sonarr"
						icon={Tv}
						gradient={SERVICE_GRADIENTS.sonarr}
						totals={{} as never}
						rows={[]}
						availabilityIncomplete
					/>
				</IncognitoProvider>
			</ColorThemeProvider>,
		);
		expect(screen.getByText(/Statistics unavailable for configured instances/i)).toBeVisible();
		expect(screen.queryByText(/No Sonarr instances configured/i)).not.toBeInTheDocument();
	});

	it("does not call a configured Prowlarr instance unconfigured when its statistics fail", () => {
		render(
			<ColorThemeProvider>
				<IncognitoProvider>
					<ProwlarrTab prowlarrTotals={{} as never} prowlarrRows={[]} availabilityIncomplete />
				</IncognitoProvider>
			</ColorThemeProvider>,
		);
		expect(screen.getByText(/Statistics unavailable for configured instances/i)).toBeVisible();
		expect(screen.queryByText(/No Prowlarr instances configured/i)).not.toBeInTheDocument();
	});
});
