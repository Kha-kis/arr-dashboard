import { SettingsClient } from "../../src/features/settings/components/settings-client";

const SettingsPage = () => (
  <main className="mx-auto flex max-w-6xl flex-col gap-12 px-6 py-16">
    <header className="space-y-2">
      <p className="text-sm font-medium uppercase text-white/60">Configuration</p>
      <h1 className="text-4xl font-semibold text-white">Settings</h1>
      <p className="max-w-2xl text-sm text-white/70">
        Manage Sonarr, Radarr, and Prowlarr connections, organise instances with tags, and ensure the right defaults
        are applied across the dashboard.
      </p>
    </header>
    <SettingsClient />
  </main>
);

export default SettingsPage;
