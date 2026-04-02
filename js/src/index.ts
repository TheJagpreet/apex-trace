/**
 * @apex-trace/js - Distributed tracing for the Apex ecosystem
 *
 * Provides OpenTelemetry-based tracing for React/TypeScript applications
 * in the apex-dashboard project.
 */

export { ApexTracer, type ApexTracerConfig } from './tracer';
export { TracingProvider, useTracing, useSpan } from './react/TracingProvider';
export { createAxiosTracingInterceptor } from './axios';
export {
  injectTraceContext,
  extractTraceContext,
  getTraceHeaders,
} from './propagation';
