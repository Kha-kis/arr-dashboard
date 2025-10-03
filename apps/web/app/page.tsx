'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSetupRequired, useCurrentUser } from '../src/hooks/api/useAuth';

const HomePage = () => {
  const router = useRouter();
  const { data: setupRequired, isLoading: setupLoading } = useSetupRequired();
  const { data: user, isLoading: userLoading } = useCurrentUser(setupRequired === false);

  useEffect(() => {
    console.log('HomePage redirect check:', { setupLoading, setupRequired, userLoading, user: !!user });

    if (setupLoading) return;

    // Setup is required, go to setup page
    if (setupRequired === true) {
      console.log('HomePage: Redirecting to /setup');
      window.location.href = '/setup';
      return;
    }

    // Setup is complete, check auth
    if (setupRequired === false) {
      if (userLoading) return;

      // User is logged in, go to dashboard
      if (user) {
        console.log('HomePage: Redirecting to /dashboard');
        router.replace('/dashboard');
        return;
      }

      // Not logged in, go to login
      console.log('HomePage: Redirecting to /login');
      router.replace('/login');
    }
  }, [setupLoading, setupRequired, userLoading, user, router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
    </main>
  );
};

export default HomePage;
