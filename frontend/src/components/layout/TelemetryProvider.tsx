'use client';

import { useEffect } from 'react';
import { initClientDiagnostics, initWebVitals } from '@/lib/telemetry';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { NetworkHealthWidget } from '@/components/layout/NetworkHealthWidget';

interface TelemetryProviderProps {
  children: React.ReactNode;
}

export function TelemetryProvider({ children }: TelemetryProviderProps) {
  useEffect(() => {
    initWebVitals();
    return initClientDiagnostics();
  }, []);

  return (
    <ErrorBoundary name="ApplicationShell">
      {children}
      <NetworkHealthWidget />
    </ErrorBoundary>
  );
}
