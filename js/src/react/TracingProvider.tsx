import React, { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { Span } from '@opentelemetry/api';
import { ApexTracer, type ApexTracerConfig } from '../tracer';

interface TracingContextValue {
  tracer: ApexTracer;
}

const TracingContext = createContext<TracingContextValue | null>(null);

interface TracingProviderProps {
  config: ApexTracerConfig;
  children: ReactNode;
}

/**
 * TracingProvider wraps your React app with distributed tracing capabilities.
 *
 * @example
 * ```tsx
 * <TracingProvider config={{ serviceName: 'apex-dashboard' }}>
 *   <App />
 * </TracingProvider>
 * ```
 */
export function TracingProvider({ config, children }: TracingProviderProps): React.ReactElement {
  const tracerRef = useRef<ApexTracer | null>(null);

  if (!tracerRef.current) {
    tracerRef.current = new ApexTracer(config);
  }

  useEffect(() => {
    return () => {
      tracerRef.current?.shutdown();
    };
  }, []);

  return React.createElement(
    TracingContext.Provider,
    { value: { tracer: tracerRef.current } },
    children,
  );
}

/**
 * useTracing returns the ApexTracer instance from the nearest TracingProvider.
 *
 * @example
 * ```tsx
 * const { tracer } = useTracing();
 * const span = tracer.traceUserAction('click', 'create-sandbox-btn');
 * // ... do work
 * tracer.endSpan(span);
 * ```
 */
export function useTracing(): TracingContextValue {
  const ctx = useContext(TracingContext);
  if (!ctx) {
    throw new Error('useTracing must be used within a <TracingProvider>');
  }
  return ctx;
}

/**
 * useSpan creates a span tied to a component's lifecycle.
 * The span starts on mount and ends on unmount.
 *
 * @example
 * ```tsx
 * function Dashboard() {
 *   const span = useSpan('page.dashboard', { 'page.url': '/dashboard' });
 *   return <div>Dashboard</div>;
 * }
 * ```
 */
export function useSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>,
): Span | null {
  const ctx = useContext(TracingContext);
  const spanRef = useRef<Span | null>(null);

  useEffect(() => {
    if (ctx) {
      spanRef.current = ctx.tracer.startSpan(name, attributes);
    }
    return () => {
      if (spanRef.current && ctx) {
        ctx.tracer.endSpan(spanRef.current);
      }
    };
    // Only run on mount/unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return spanRef.current;
}
