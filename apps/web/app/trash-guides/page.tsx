import { TrashGuidesClient } from "../../src/features/trash-guides/components/trash-guides-client";

// Force dynamic rendering - this page requires auth and API data
export const dynamic = "force-dynamic";

const TrashGuidesPage = () => (
	<main className="mx-auto flex max-w-6xl flex-col gap-12 px-6 py-16">
		<TrashGuidesClient />
	</main>
);

export default TrashGuidesPage;
