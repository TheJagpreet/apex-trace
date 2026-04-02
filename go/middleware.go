package apextrace

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// responseWriter wraps http.ResponseWriter to capture the status code.
type responseWriter struct {
	http.ResponseWriter
	statusCode int
	written    bool
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
	return &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
}

func (rw *responseWriter) WriteHeader(code int) {
	if !rw.written {
		rw.statusCode = code
		rw.written = true
	}
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	if !rw.written {
		rw.written = true
	}
	return rw.ResponseWriter.Write(b)
}

// HTTPMiddleware returns an HTTP middleware that traces incoming requests.
// It extracts trace context from incoming headers and creates a server span.
func (tp *TracerProvider) HTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		propagator := otel.GetTextMapPropagator()
		ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

		spanName := fmt.Sprintf("%s %s", r.Method, r.URL.Path)
		ctx, span := tp.tracer.Start(ctx, spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				semconv.HTTPRequestMethodKey.String(r.Method),
				semconv.URLPath(r.URL.Path),
				semconv.URLScheme(r.URL.Scheme),
				semconv.ServerAddress(r.Host),
				semconv.UserAgentOriginal(r.UserAgent()),
				attribute.String("apex.service", tp.config.ServiceName),
			),
		)
		defer span.End()

		// Inject trace context into response headers for downstream correlation.
		propagator.Inject(ctx, propagation.HeaderCarrier(w.Header()))

		rw := newResponseWriter(w)
		start := time.Now()

		next.ServeHTTP(rw, r.WithContext(ctx))

		duration := time.Since(start)
		span.SetAttributes(
			semconv.HTTPResponseStatusCode(rw.statusCode),
			attribute.Float64("http.duration_ms", float64(duration.Milliseconds())),
		)

		if rw.statusCode >= 400 {
			span.SetAttributes(attribute.Bool("error", true))
		}
	})
}

// InjectHTTPHeaders injects the current trace context into outgoing HTTP request headers.
// Use this when making HTTP calls to other Apex services to propagate trace context.
func InjectHTTPHeaders(ctx context.Context, req *http.Request) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
}

// ExtractHTTPHeaders extracts trace context from incoming HTTP request headers.
func ExtractHTTPHeaders(ctx context.Context, req *http.Request) context.Context {
	return otel.GetTextMapPropagator().Extract(ctx, propagation.HeaderCarrier(req.Header))
}
