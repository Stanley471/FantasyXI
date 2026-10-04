'use client';

import { useEffect } from 'react';
import { initWebVitals } from '@/lib/telemetry';
import { ErrorBoundary } from '@/components/ErrorBoundary';

interface TelemetryProviderProps {
  children: React.ReactNode;
}

export function TelemetryProvider({ children }: TelemetryProviderProps) {
  useEffect(() => {
    initWebVitals();
  }, []);

  return <ErrorBoundary>{children}</ErrorBoundary>;
}
