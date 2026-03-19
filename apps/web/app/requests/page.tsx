import { PageLayout } from "@arr/web/components/layout";
import { RequestsClient } from "@arr/web/features/seerr/components/requests-client";

const RequestsPage = () => (
	<PageLayout maxWidth="7xl">
		<RequestsClient />
	</PageLayout>
);

export default RequestsPage;
