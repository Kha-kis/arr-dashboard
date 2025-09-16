import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { LucideIcon, X } from 'lucide-react';
import { cn } from '@/utils';

interface NavigationItem {
  name: string;
  href: string;
  icon: LucideIcon;
  shortcut: string;
}

interface SidebarProps {
  navigation: NavigationItem[];
  isOpen: boolean;
  isMobile: boolean;
  onClose: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  navigation,
  isOpen,
  isMobile,
  onClose,
}) => {
  const location = useLocation();

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div
          className={cn('font-bold text-lg', !isOpen && !isMobile && 'sr-only')}
        >
          *arr Dashboard
        </div>
        {isMobile && (
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-accent"
            aria-label="Close sidebar"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4">
        <ul className="space-y-2">
          {navigation.map(item => {
            const isActive = location.pathname === item.href;
            return (
              <li key={item.name}>
                <Link
                  to={item.href}
                  onClick={isMobile ? onClose : undefined}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-accent hover:text-accent-foreground',
                    !isOpen && !isMobile && 'justify-center'
                  )}
                >
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                  <span
                    className={cn(
                      'truncate',
                      !isOpen && !isMobile && 'sr-only'
                    )}
                  >
                    {item.name}
                  </span>
                  {isOpen && (
                    <kbd className="ml-auto text-xs bg-muted px-1 py-0.5 rounded">
                      {item.shortcut}
                    </kbd>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-border">
        <div
          className={cn(
            'text-xs text-muted-foreground',
            !isOpen && !isMobile && 'sr-only'
          )}
        >
          v2.0.0
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: -320 }}
            animate={{ x: 0 }}
            exit={{ x: -320 }}
            transition={{ type: 'tween', duration: 0.3 }}
            className="fixed inset-y-0 left-0 z-50 w-80 bg-card border-r border-border shadow-lg"
          >
            {sidebarContent}
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <motion.div
      animate={{ width: isOpen ? 256 : 64 }}
      transition={{ type: 'tween', duration: 0.3 }}
      className="fixed inset-y-0 left-0 z-40 bg-card border-r border-border"
    >
      {sidebarContent}
    </motion.div>
  );
};
