// Package apextrace provides distributed tracing for the Apex ecosystem.
//
// It wraps OpenTelemetry to provide a simple, consistent tracing API
// for Go services in the apex-venv project (MCP server, HTTP server, CLI).
package apextrace

import (
	"context"
	"fmt"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// Config holds configuration for the tracer.
type Config struct {
	// ServiceName identifies the service (e.g., "apex-mcp", "apex-server", "apex-venv-cli").
	ServiceName string

	// ServiceVersion is the version of the service.
	ServiceVersion string

	// Environment is the deployment environment (e.g., "development", "production").
	Environment string

	// OTLPEndpoint is the OTLP HTTP endpoint for exporting traces.
	// If empty, defaults to OTEL_EXPORTER_OTLP_ENDPOINT env var, then "localhost:4318".
	OTLPEndpoint string

	// UseStdout enables stdout exporter for development/debugging.
	UseStdout bool

	// SampleRate controls the sampling rate (0.0 to 1.0). Default is 1.0 (sample all).
	SampleRate float64
}

// TracerProvider wraps the OpenTelemetry TracerProvider with Apex-specific helpers.
type TracerProvider struct {
	provider *sdktrace.TracerProvider
	tracer   trace.Tracer
	config   Config
}

// Init initializes the tracing system and returns a TracerProvider.
// Call Shutdown() when the application exits.
func Init(cfg Config) (*TracerProvider, error) {
	if cfg.ServiceName == "" {
		return nil, fmt.Errorf("apextrace: ServiceName is required")
	}

	if cfg.Environment == "" {
		cfg.Environment = "development"
	}

	if cfg.SampleRate == 0 {
		cfg.SampleRate = 1.0
	}

	ctx := context.Background()

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceNameKey.String(cfg.ServiceName),
			semconv.ServiceVersionKey.String(cfg.ServiceVersion),
			attribute.String("deployment.environment", cfg.Environment),
			attribute.String("apex.component", cfg.ServiceName),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("apextrace: failed to create resource: %w", err)
	}

	var exporters []sdktrace.SpanExporter

	if cfg.UseStdout {
		stdoutExp, err := stdouttrace.New(stdouttrace.WithPrettyPrint())
		if err != nil {
			return nil, fmt.Errorf("apextrace: failed to create stdout exporter: %w", err)
		}
		exporters = append(exporters, stdoutExp)
	}

	endpoint := cfg.OTLPEndpoint
	if endpoint == "" {
		endpoint = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	}
	if endpoint == "" {
		endpoint = "localhost:4318"
	}

	otlpExp, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpoint(endpoint),
		otlptracehttp.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("apextrace: failed to create OTLP exporter: %w", err)
	}
	exporters = append(exporters, otlpExp)

	opts := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.TraceIDRatioBased(cfg.SampleRate)),
	}
	for _, exp := range exporters {
		opts = append(opts, sdktrace.WithBatcher(exp))
	}

	tp := sdktrace.NewTracerProvider(opts...)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	tracer := tp.Tracer(
		"github.com/TheJagpreet/apex-trace/go",
		trace.WithInstrumentationVersion("1.0.0"),
	)

	return &TracerProvider{
		provider: tp,
		tracer:   tracer,
		config:   cfg,
	}, nil
}

// Shutdown gracefully shuts down the tracer, flushing any remaining spans.
func (tp *TracerProvider) Shutdown(ctx context.Context) error {
	shutdownCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return tp.provider.Shutdown(shutdownCtx)
}

// Tracer returns the underlying OpenTelemetry Tracer.
func (tp *TracerProvider) Tracer() trace.Tracer {
	return tp.tracer
}

// StartSpan starts a new span with the given name and optional attributes.
func (tp *TracerProvider) StartSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	ctx, span := tp.tracer.Start(ctx, name,
		trace.WithAttributes(attrs...),
		trace.WithSpanKind(trace.SpanKindInternal),
	)
	return ctx, span
}

// StartServerSpan starts a new server span (for incoming requests).
func (tp *TracerProvider) StartServerSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	ctx, span := tp.tracer.Start(ctx, name,
		trace.WithAttributes(attrs...),
		trace.WithSpanKind(trace.SpanKindServer),
	)
	return ctx, span
}

// StartClientSpan starts a new client span (for outgoing requests).
func (tp *TracerProvider) StartClientSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	ctx, span := tp.tracer.Start(ctx, name,
		trace.WithAttributes(attrs...),
		trace.WithSpanKind(trace.SpanKindClient),
	)
	return ctx, span
}

// SpanFromContext returns the current span from the context.
func SpanFromContext(ctx context.Context) trace.Span {
	return trace.SpanFromContext(ctx)
}

// AddEvent adds an event to the current span.
func AddEvent(ctx context.Context, name string, attrs ...attribute.KeyValue) {
	span := trace.SpanFromContext(ctx)
	span.AddEvent(name, trace.WithAttributes(attrs...))
}

// SetError marks the current span as errored.
func SetError(ctx context.Context, err error) {
	span := trace.SpanFromContext(ctx)
	span.RecordError(err)
	span.SetAttributes(attribute.Bool("error", true))
}
