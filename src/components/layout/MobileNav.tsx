import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LucideIcon, MoreHorizontal } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/utils';

interface NavigationItem {
  name: string;
  href: string;
  icon: LucideIcon;
  shortcut: string;
}

interface MobileNavProps {
  navigation: NavigationItem[];
}

export const MobileNav: React.FC<MobileNavProps> = ({ navigation }) => {
  const location = useLocation();
  const [showMore, setShowMore] = React.useState(false);

  // Show first 4 items + More button, or all items when expanded
  const primaryNavItems = navigation.slice(0, 4);
  const secondaryNavItems = navigation.slice(4);

  const NavItem = ({
    item,
    isActive,
  }: {
    item: NavigationItem;
    isActive: boolean;
  }) => (
    <Link
      to={item.href}
      onClick={() => setShowMore(false)}
      className={cn(
        'flex flex-col items-center gap-1 px-3 py-3 rounded-lg text-xs font-medium transition-colors min-w-0 min-h-[44px] justify-center',
        isActive
          ? 'text-primary bg-primary/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      )}
    >
      <item.icon className="h-5 w-5 flex-shrink-0" />
      <span className="truncate max-w-12 text-[10px] leading-tight">
        {item.name}
      </span>
    </Link>
  );

  return (
    <>
      {/* Expanded navigation overlay */}
      <AnimatePresence>
        {showMore && secondaryNavItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowMore(false)}
          >
            <motion.div
              initial={{ y: 100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 100, opacity: 0 }}
              className="absolute bottom-20 left-4 right-4 bg-card border border-border rounded-2xl p-4 shadow-xl"
            >
              <div className="grid grid-cols-3 gap-3">
                {secondaryNavItems.map(item => {
                  const isActive = location.pathname === item.href;
                  return (
                    <NavItem key={item.name} item={item} isActive={isActive} />
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-md border-t border-border">
        <div className="flex items-center justify-around px-2 py-2">
          {primaryNavItems.map(item => {
            const isActive = location.pathname === item.href;
            return <NavItem key={item.name} item={item} isActive={isActive} />;
          })}

          {/* More button */}
          {secondaryNavItems.length > 0 && (
            <button
              onClick={() => setShowMore(!showMore)}
              className={cn(
                'flex flex-col items-center gap-1 px-3 py-3 rounded-lg text-xs font-medium transition-colors min-h-[44px] justify-center',
                showMore
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              <MoreHorizontal className="h-5 w-5 flex-shrink-0" />
              <span className="text-[10px] leading-tight">More</span>
            </button>
          )}
        </div>

        {/* Safe area for devices with home indicator */}
        <div className="h-safe-bottom bg-card/95" />
      </nav>
    </>
  );
};
