const ITEM_INVENTORY_PATH = /^\/Users\/[^/]+\/Items$/;

export function isItemInventoryRequest(requestUrl) {
	return ITEM_INVENTORY_PATH.test(new URL(requestUrl, "http://jellyfin.invalid").pathname);
}

export function applyRequestPolicy({ mode, url }) {
	if (mode === "unavailable") {
		return {
			body: { error: "fixture_unavailable" },
			shortCircuit: true,
			status: 503,
		};
	}

	const rewritten = new URL(url, "http://jellyfin.invalid");
	if (mode === "paginate" && isItemInventoryRequest(url)) {
		rewritten.searchParams.set("Limit", "1");
	}
	if (mode === "boxset-only" && isItemInventoryRequest(url)) {
		// BoxSets are server-level collection objects rather than children of a
		// movie library. The live matrix first proves a real BoxSet exists, then
		// deliberately broadens every library inventory request to that authentic
		// collection inventory so the application must exercise its skip branch.
		rewritten.searchParams.delete("ParentId");
		rewritten.searchParams.set("IncludeItemTypes", "BoxSet");
	}

	return { url: `${rewritten.pathname}${rewritten.search}` };
}

export function applyResponsePolicy({ body, mode, url }) {
	if (!isItemInventoryRequest(url) || !body || !Array.isArray(body.Items)) {
		return { body };
	}

	if (mode === "unknown-type") {
		return {
			body: {
				...body,
				Items: [
					...body.Items,
					{
						Id: "authority-fixture-unknown",
						Name: "Synthetic Unknown",
						Type: "MusicVideo",
					},
				],
				TotalRecordCount: Number(body.TotalRecordCount ?? body.Items.length) + 1,
			},
		};
	}

	if (mode === "malformed") {
		return {
			body: {
				...body,
				Items: [{ Name: "Synthetic Malformed", Type: "Movie" }],
				TotalRecordCount: 1,
			},
		};
	}

	return { body };
}
