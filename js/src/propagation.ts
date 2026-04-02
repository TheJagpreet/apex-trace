import { context, propagation, trace } from '@opentelemetry/api';

/**
 * Injects the current trace context into a headers object.
 * Use this for manual HTTP requests or custom transport mechanisms.
 */
export function injectTraceContext(headers: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}

/**
 * Extracts trace context from headers into the current context.
 * Use this to continue a trace from an incoming request.
 */
export function extractTraceContext(headers: Record<string, string>): void {
  const extractedContext = propagation.extract(context.active(), headers);
  context.with(extractedContext, () => {});
}

/**
 * Gets the current trace context as W3C Trace Context headers.
 * Returns an object with `traceparent` and optionally `tracestate` headers.
 */
export function getTraceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return headers;
}

/**
 * Gets the current trace ID from the active context.
 * Returns undefined if no active trace exists.
 */
export function getCurrentTraceId(): string | undefined {
  const span = trace.getSpan(context.active());
  if (span) {
    const spanContext = span.spanContext();
    return spanContext.traceId;
  }
  return undefined;
}

/**
 * Gets the current span ID from the active context.
 * Returns undefined if no active span exists.
 */
export function getCurrentSpanId(): string | undefined {
  const span = trace.getSpan(context.active());
  if (span) {
    const spanContext = span.spanContext();
    return spanContext.spanId;
  }
  return undefined;
}
