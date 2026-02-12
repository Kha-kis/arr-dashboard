import { QueueCleanerClient } from "@arr/web/features/queue-cleaner/components/queue-cleaner-client";
import { PageLayout } from "@arr/web/components/layout";

const QueueCleanerPage = () => (
	<PageLayout maxWidth="7xl">
		<QueueCleanerClient />
	</PageLayout>
);

export default QueueCleanerPage;
