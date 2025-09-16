import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui';
import { useAppStore } from '@/store';

export const ThemeToggle: React.FC = () => {
  const { theme, setTheme } = useAppStore();

  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
};
