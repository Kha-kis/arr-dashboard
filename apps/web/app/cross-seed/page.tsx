import { PageLayout } from "../../src/components/layout";
import { CrossSeedClient } from "../../src/features/cross-seed/components/cross-seed-client";

export default function CrossSeedPage() {
	return (
		<PageLayout maxWidth="7xl">
			<CrossSeedClient />
		</PageLayout>
	);
}
