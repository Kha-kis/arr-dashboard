import React, { useCallback, useState, useEffect } from 'react';
import {
  Card,
  CardHeader,
  CardContent,
  Input,
  Button,
  FormField,
} from '@/components/ui';
import { useAppStore } from '@/store';

export const SettingsPage: React.FC = () => {
  const { config, updateConfig } = useAppStore();

  // Local state to prevent re-rendering on every keystroke
  const [localConfig, setLocalConfig] = useState(config);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Update local config when store config changes (from other sources)
  useEffect(() => {
    setLocalConfig(config);
    setHasUnsavedChanges(false);
  }, [config]);

  const handleSave = useCallback(() => {
    updateConfig(localConfig);
    setHasUnsavedChanges(false);
    console.log('Settings saved');
  }, [localConfig, updateConfig]);

  const updateLocalService = useCallback(
    (
      service: 'sonarr' | 'radarr' | 'prowlarr',
      field: string,
      value: string
    ) => {
      setLocalConfig(prev => ({
        ...prev,
        [service]: {
          ...prev[service],
          [field]: value,
        },
      }));
      setHasUnsavedChanges(true);
    },
    []
  );

  // Auto-save after user stops typing (debounced)
  useEffect(() => {
    if (hasUnsavedChanges) {
      const timeout = setTimeout(() => {
        updateConfig(localConfig);
        setHasUnsavedChanges(false);
      }, 1000); // Save after 1 second of inactivity

      return () => clearTimeout(timeout);
    }
  }, [localConfig, hasUnsavedChanges, updateConfig]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-2">
          Configure your *arr services - API requests are automatically handled
          via backend
        </p>
      </div>

      <Card>
        <CardHeader
          title="Service Configuration"
          subtitle="Enter your base URLs and API keys to connect to your services"
          actions={
            <Button
              onClick={handleSave}
              variant={hasUnsavedChanges ? 'default' : 'ghost'}
            >
              {hasUnsavedChanges ? 'Save Changes' : 'Saved'}
            </Button>
          }
        />
        <CardContent className="space-y-6">
          {/* Service Configuration */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Sonarr */}
            <div>
              <h3 className="font-semibold mb-3 text-sonarr">Sonarr</h3>
              <div className="space-y-4">
                <FormField
                  label="Base URL"
                  description="The base URL for your Sonarr instance"
                >
                  <Input
                    placeholder="http://192.168.1.100:8989"
                    value={localConfig.sonarr.baseUrl}
                    onChange={e =>
                      updateLocalService('sonarr', 'baseUrl', e.target.value)
                    }
                  />
                </FormField>
                <FormField
                  label="API Key"
                  description="Your Sonarr API key from Settings > General"
                >
                  <Input
                    placeholder="API Key"
                    type="password"
                    value={localConfig.sonarr.apiKey}
                    onChange={e =>
                      updateLocalService('sonarr', 'apiKey', e.target.value)
                    }
                  />
                </FormField>
              </div>
            </div>

            {/* Radarr */}
            <div>
              <h3 className="font-semibold mb-3 text-radarr">Radarr</h3>
              <div className="space-y-4">
                <FormField
                  label="Base URL"
                  description="The base URL for your Radarr instance"
                >
                  <Input
                    placeholder="http://192.168.1.100:7878"
                    value={localConfig.radarr.baseUrl}
                    onChange={e =>
                      updateLocalService('radarr', 'baseUrl', e.target.value)
                    }
                  />
                </FormField>
                <FormField
                  label="API Key"
                  description="Your Radarr API key from Settings > General"
                >
                  <Input
                    placeholder="API Key"
                    type="password"
                    value={localConfig.radarr.apiKey}
                    onChange={e =>
                      updateLocalService('radarr', 'apiKey', e.target.value)
                    }
                  />
                </FormField>
              </div>
            </div>

            {/* Prowlarr */}
            <div>
              <h3 className="font-semibold mb-3 text-prowlarr">Prowlarr</h3>
              <div className="space-y-4">
                <FormField
                  label="Base URL"
                  description="The base URL for your Prowlarr instance"
                >
                  <Input
                    placeholder="http://192.168.1.100:9696"
                    value={localConfig.prowlarr.baseUrl}
                    onChange={e =>
                      updateLocalService('prowlarr', 'baseUrl', e.target.value)
                    }
                  />
                </FormField>
                <FormField
                  label="API Key"
                  description="Your Prowlarr API key from Settings > General"
                >
                  <Input
                    placeholder="API Key"
                    type="password"
                    value={localConfig.prowlarr.apiKey}
                    onChange={e =>
                      updateLocalService('prowlarr', 'apiKey', e.target.value)
                    }
                  />
                </FormField>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
