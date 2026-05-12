import { PageLayout } from "../../src/components/layout";
import { QuiActivityClient } from "../../src/features/qui-activity/components/qui-activity-client";

export default function QuiActivityPage() {
	return (
		<PageLayout maxWidth="6xl">
			<QuiActivityClient />
		</PageLayout>
	);
}
