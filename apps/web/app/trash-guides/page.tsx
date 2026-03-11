import { PageLayout } from "../../src/components/layout";
import { TrashGuidesClient } from "../../src/features/trash-guides/components/trash-guides-client";

// Force dynamic rendering - this page requires auth and API data
export const dynamic = "force-dynamic";

const TrashGuidesPage = () => (
	<PageLayout>
		<TrashGuidesClient />
	</PageLayout>
);

export default TrashGuidesPage;
