import { PageLayout } from "../../src/components/layout";
import { DiscoverClient } from "../../src/features/discover/components/discover-client";

const DiscoverPage = () => (
	<PageLayout className="overflow-x-hidden">
		<DiscoverClient />
	</PageLayout>
);

export default DiscoverPage;
