import { AuthGate } from "@arr/web/components/auth/auth-gate";
import { QueueCleanerClient } from "@arr/web/features/queue-cleaner/components/queue-cleaner-client";
import { PageLayout } from "@arr/web/components/layout";

const QueueCleanerPage = () => (
	<AuthGate>
		<PageLayout maxWidth="7xl">
			<QueueCleanerClient />
		</PageLayout>
	</AuthGate>
);

export default QueueCleanerPage;
