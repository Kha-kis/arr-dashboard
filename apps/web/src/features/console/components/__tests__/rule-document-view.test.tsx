import type { RuleDocument } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RuleDocumentView } from "../rule-document-view";

describe("<RuleDocumentView />", () => {
	it("renders a single predicate root", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { kind: "age", params: { operator: "older_than", days: 30 } },
		};
		render(<RuleDocumentView document={doc} context="library-cleanup" incognito={false} />);
		expect(screen.getByText("Age")).toBeInTheDocument();
		expect(screen.getByText("older than · 30")).toBeInTheDocument();
	});

	it("renders an ALL group with its children", () => {
		const doc: RuleDocument = {
			version: 1,
			root: {
				all: [
					{ kind: "genre", params: { genres: ["Action"] } },
					{ kind: "year_range", params: { from: 2020, to: 2024 } },
				],
			},
		};
		render(<RuleDocumentView document={doc} context="auto-tag" incognito={false} />);
		expect(screen.getByText("All of")).toBeInTheDocument();
		expect(screen.getByText("Genre")).toBeInTheDocument();
		expect(screen.getByText("Year range")).toBeInTheDocument();
	});

	it("renders an ANY group label", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { any: [{ kind: "genre", params: { genres: ["Action"] } }] },
		};
		render(<RuleDocumentView document={doc} context="auto-tag" incognito={false} />);
		expect(screen.getByText("Any of")).toBeInTheDocument();
	});

	it("annotates an empty group as 'matches every event' for notifications", () => {
		const doc: RuleDocument = { version: 1, root: { all: [] } };
		render(<RuleDocumentView document={doc} context="notifications" incognito={false} />);
		expect(screen.getByText(/matches every event/i)).toBeInTheDocument();
	});

	it("annotates an empty group as 'never matches' for cleanup/auto-tag", () => {
		const doc: RuleDocument = { version: 1, root: { all: [] } };
		render(<RuleDocumentView document={doc} context="library-cleanup" incognito={false} />);
		expect(screen.getByText(/never matches/i)).toBeInTheDocument();
	});

	it("badges an unavailable (retired) kind", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { kind: "tautulli_last_watched", params: {}, unavailableKind: true },
		};
		render(<RuleDocumentView document={doc} context="library-cleanup" incognito={false} />);
		expect(screen.getByText("unavailable")).toBeInTheDocument();
	});

	it("masks string param values in incognito but keeps the operator", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { kind: "plex_label", params: { operator: "any_of", labels: ["Favorites"] } },
		};
		render(<RuleDocumentView document={doc} context="library-cleanup" incognito={true} />);
		expect(screen.queryByText(/Favorites/)).not.toBeInTheDocument();
		expect(screen.getByText(/•••/)).toBeInTheDocument();
	});
});
