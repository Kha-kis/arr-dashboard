import { Suspense } from "react";
import { LoginForm } from "../../src/features/auth/components/login-form";

const LoginPage = () => (
  <main className="mx-auto flex max-w-5xl flex-1 flex-col items-center justify-center px-6 py-16">
    <Suspense fallback={<div className="text-white/60">Loading...</div>}>
      <LoginForm />
    </Suspense>
  </main>
);

export default LoginPage;
