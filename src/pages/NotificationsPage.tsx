import React from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui';

export const NotificationsPage: React.FC = () => {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Notifications</h1>
        <p className="text-muted-foreground mt-2">
          Custom notification rules and alerts
        </p>
      </div>

      <Card>
        <CardHeader
          title="Notification System"
          subtitle="Webhooks, email alerts, and custom rules"
        />
        <CardContent>
          <p className="text-muted-foreground">
            Coming soon: Custom notification rules for download events, webhook
            integration, email alerts, and real-time notifications.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};
