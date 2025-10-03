'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';
import { TopBar } from './topbar';

const ROUTES_WITHOUT_LAYOUT = new Set(['/login', '/setup']);

interface LayoutWrapperProps {
  readonly children: React.ReactNode;
}

export const LayoutWrapper = ({ children }: LayoutWrapperProps) => {
  const pathname = usePathname();
  const showLayout = !ROUTES_WITHOUT_LAYOUT.has(pathname);

  if (!showLayout) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar />
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
};
