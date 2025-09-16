import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, RefreshCw, Settings } from 'lucide-react';
import { Button, StatusIndicator, Switch, Select } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useAppStore } from '@/store';
import { useAutoRefresh, useConfigValidation } from '@/hooks';

interface HeaderProps {
  onMenuClick: () => void;
  isMobile: boolean;
}

export const Header: React.FC<HeaderProps> = ({ onMenuClick, isMobile }) => {
  const navigate = useNavigate();
  const {
    autoRefresh,
    setAutoRefresh,
    refreshInterval,
    setRefreshInterval,
    loading,
  } = useAppStore();

  const { refreshAllData } = useAutoRefresh();
  const { getConfigurationStatus } = useConfigValidation();

  const configStatus = getConfigurationStatus();

  const getSystemStatus = () => {
    if (loading) return 'loading';
    if (configStatus.hasAnyService) return 'online';
    return 'offline';
  };

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center justify-between px-4 sm:px-6">
        {/* Left side */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onMenuClick}
            className="shrink-0"
            aria-label="Toggle menu"
          >
            <Menu className="h-5 w-5" />
          </Button>

          {!isMobile && (
            <div className="flex items-center gap-3">
              <StatusIndicator
                status={getSystemStatus()}
                label={
                  configStatus.sonarr &&
                  configStatus.radarr &&
                  configStatus.prowlarr
                    ? 'All services connected'
                    : configStatus.hasAnyService
                      ? 'Partially configured'
                      : 'Not configured'
                }
              />
            </div>
          )}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3">
          {/* Auto-refresh controls */}
          <div className="hidden sm:flex items-center gap-3 text-sm">
            <Switch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              label="Auto refresh"
              className="text-xs"
            />

            <Select
              value={refreshInterval.toString()}
              onChange={e => setRefreshInterval(Number(e.target.value))}
              options={[
                { value: '15', label: '15s' },
                { value: '30', label: '30s' },
                { value: '60', label: '60s' },
                { value: '120', label: '2m' },
              ]}
              className="w-20 text-xs h-8"
            />
          </div>

          {/* Manual refresh */}
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshAllData}
            disabled={loading}
            aria-label="Refresh data"
            title="Refresh all data (Ctrl+R)"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>

          {/* Theme toggle */}
          <ThemeToggle />

          {/* Settings link (mobile) */}
          {isMobile && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/settings')}
              aria-label="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </header>
  );
};
