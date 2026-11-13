import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../src/contexts/IncognitoContext";

vi.mock("../../src/features/qui-home/components/qui-home-client", () => ({
	QuiHomeClient: () => <h1>qUI home</h1>,
}));

import QuiHomePage from "./page";

describe("qUI home page", () => {
	it("places the rendered home surface inside the main landmark", () => {
		render(
			<IncognitoProvider>
				<QuiHomePage />
			</IncognitoProvider>,
		);

		expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
	});
});
