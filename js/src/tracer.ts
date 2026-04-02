import { trace, context, SpanKind, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ZoneContextManager } from '@opentelemetry/context-zone';

export interface ApexTracerConfig {
  /** Service name (e.g., "apex-dashboard") */
  serviceName: string;
  /** Service version */
  serviceVersion?: string;
  /** Deployment environment (e.g., "development", "production") */
  environment?: string;
  /** OTLP HTTP endpoint for exporting traces. Defaults to "http://localhost:4318/v1/traces" */
  otlpEndpoint?: string;
  /** Enable console logging of spans for debugging */
  enableConsoleLog?: boolean;
  /** Sampling rate (0.0 to 1.0). Default: 1.0 */
  sampleRate?: number;
}

export class ApexTracer {
  private provider: WebTracerProvider;
  private tracer: Tracer;
  private config: ApexTracerConfig;

  constructor(config: ApexTracerConfig) {
    this.config = {
      environment: 'development',
      serviceVersion: '0.0.0',
      otlpEndpoint: 'http://localhost:4318/v1/traces',
      sampleRate: 1.0,
      ...config,
    };

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: this.config.serviceName,
      [ATTR_SERVICE_VERSION]: this.config.serviceVersion,
      'deployment.environment': this.config.environment,
      'apex.component': this.config.serviceName,
    });

    this.provider = new WebTracerProvider({ resource });

    const exporter = new OTLPTraceExporter({
      url: this.config.otlpEndpoint,
    });
    this.provider.addSpanProcessor(new BatchSpanProcessor(exporter));

    if (this.config.enableConsoleLog) {
      const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');
      this.provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    }

    this.provider.register({
      contextManager: new ZoneContextManager(),
    });

    this.tracer = trace.getTracer(
      '@apex-trace/js',
      '1.0.0',
    );
  }

  /** Get the underlying OpenTelemetry Tracer */
  getTracer(): Tracer {
    return this.tracer;
  }

  /** Get the tracer config */
  getConfig(): ApexTracerConfig {
    return this.config;
  }

  /** Start a generic span */
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span {
    return this.tracer.startSpan(name, {
      kind: SpanKind.INTERNAL,
      attributes: {
        ...attributes,
        'apex.component': this.config.serviceName,
      },
    });
  }

  /** Trace a page navigation */
  tracePageView(pageName: string, url: string): Span {
    return this.tracer.startSpan('page.view', {
      kind: SpanKind.INTERNAL,
      attributes: {
        'page.name': pageName,
        'page.url': url,
        'apex.component': this.config.serviceName,
      },
    });
  }

  /** Trace a user interaction (click, form submit, etc.) */
  traceUserAction(action: string, target: string, details?: Record<string, string>): Span {
    return this.tracer.startSpan(`user.${action}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'user.action': action,
        'user.target': target,
        ...details,
        'apex.component': this.config.serviceName,
      },
    });
  }

  /** Trace an API call to apex-venv */
  traceAPICall(method: string, url: string): Span {
    return this.tracer.startSpan(`http.${method}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.method': method,
        'http.url': url,
        'apex.component': this.config.serviceName,
      },
    });
  }

  /** Trace a sandbox operation */
  traceSandboxOperation(operation: string, sandboxId?: string): Span {
    return this.tracer.startSpan(`sandbox.${operation}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'sandbox.operation': operation,
        ...(sandboxId && { 'sandbox.id': sandboxId }),
        'apex.component': this.config.serviceName,
      },
    });
  }

  /** End a span with optional error */
  endSpan(span: Span, error?: Error): void {
    if (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  }

  /** Wrap an async function with tracing */
  async traceAsync<T>(name: string, fn: (span: Span) => Promise<T>, attributes?: Record<string, string | number | boolean>): Promise<T> {
    const span = this.startSpan(name, attributes);
    try {
      const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
      this.endSpan(span);
      return result;
    } catch (error) {
      this.endSpan(span, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /** Shutdown the tracer, flushing pending spans */
  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}
