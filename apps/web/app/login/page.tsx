import { Suspense } from "react";
import { Skeleton } from "../../src/components/ui";
import { LoginForm } from "../../src/features/auth/components/login-form";

const LoginPage = () => (
	<main className="mx-auto flex max-w-5xl flex-1 flex-col items-center justify-center px-6 py-16">
		<Suspense fallback={<Skeleton className="h-64 w-full max-w-sm" />}>
			<LoginForm />
		</Suspense>
	</main>
);

export default LoginPage;
