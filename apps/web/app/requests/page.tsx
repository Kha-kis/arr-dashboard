import { Suspense } from "react";
import { PageLayout } from "@arr/web/components/layout";
import { PremiumPageLoading } from "@arr/web/components/layout/premium-components";
import { RequestsClient } from "@arr/web/features/seerr/components/requests-client";

const RequestsPage = () => (
	<PageLayout maxWidth="7xl">
		<Suspense fallback={<PremiumPageLoading />}>
			<RequestsClient />
		</Suspense>
	</PageLayout>
);

export default RequestsPage;
