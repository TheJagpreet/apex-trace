import { context, trace, propagation, SpanStatusCode, SpanKind, type Span } from '@opentelemetry/api';
import type { ApexTracer } from './tracer';

interface AxiosRequestConfigLike {
  method?: string;
  url?: string;
  baseURL?: string;
  headers: Record<string, string>;
  _apexSpan?: Span;
}

interface AxiosLike {
  interceptors: {
    request: { use: (onFulfilled: (config: AxiosRequestConfigLike) => AxiosRequestConfigLike) => number };
    response: {
      use: (
        onFulfilled: (response: AxiosResponseLike) => AxiosResponseLike,
        onRejected: (error: AxiosErrorLike) => Promise<never>,
      ) => number;
    };
  };
}

interface AxiosResponseLike {
  status: number;
  config: AxiosRequestConfigLike;
}

interface AxiosErrorLike {
  message: string;
  response?: AxiosResponseLike;
  config?: AxiosRequestConfigLike;
}

/**
 * Creates Axios interceptors that automatically trace all HTTP requests.
 * Injects W3C trace context headers for distributed tracing with apex-venv.
 *
 * @example
 * ```ts
 * import axios from 'axios';
 * import { ApexTracer, createAxiosTracingInterceptor } from '@apex-trace/js';
 *
 * const tracer = new ApexTracer({ serviceName: 'apex-dashboard' });
 * const api = axios.create({ baseURL: 'http://localhost:8080' });
 * createAxiosTracingInterceptor(api, tracer);
 * ```
 */
export function createAxiosTracingInterceptor(axios: AxiosLike, apexTracer: ApexTracer): void {
  const otelTracer = apexTracer.getTracer();

  axios.interceptors.request.use((config: AxiosRequestConfigLike) => {
    const method = (config.method ?? 'GET').toUpperCase();
    const url = config.url ?? '';

    const span = otelTracer.startSpan(`HTTP ${method} ${url}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.method': method,
        'http.url': `${config.baseURL ?? ''}${url}`,
        'apex.component': apexTracer.getConfig().serviceName,
      },
    });

    // Inject W3C trace context into request headers
    const spanContext = trace.setSpan(context.active(), span);
    propagation.inject(spanContext, config.headers);

    // Store span for response interceptor
    config._apexSpan = span;

    return config;
  });

  axios.interceptors.response.use(
    (response: AxiosResponseLike) => {
      const span = (response.config as AxiosRequestConfigLike)._apexSpan;
      if (span) {
        span.setAttribute('http.status_code', response.status);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }
      return response;
    },
    (error: AxiosErrorLike) => {
      const span = error.config?._apexSpan;
      if (span) {
        if (error.response) {
          span.setAttribute('http.status_code', error.response.status);
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.end();
      }
      return Promise.reject(error);
    },
  );
}
