package apextrace

import (
	"context"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// MCPToolSpan traces the execution of an MCP tool call.
// Returns a context with the span and a finish function that must be called when the tool completes.
func (tp *TracerProvider) MCPToolSpan(ctx context.Context, toolName string, args map[string]string) (context.Context, func(err error)) {
	attrs := []attribute.KeyValue{
		attribute.String("mcp.tool.name", toolName),
		attribute.String("apex.component", "apex-mcp"),
	}
	for k, v := range args {
		attrs = append(attrs, attribute.String("mcp.tool.arg."+k, v))
	}

	ctx, span := tp.tracer.Start(ctx, "mcp.tool/"+toolName,
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(attrs...),
	)

	start := time.Now()
	return ctx, func(err error) {
		duration := time.Since(start)
		span.SetAttributes(attribute.Float64("mcp.tool.duration_ms", float64(duration.Milliseconds())))
		if err != nil {
			span.RecordError(err)
			span.SetAttributes(
				attribute.Bool("error", true),
				attribute.String("mcp.tool.error", err.Error()),
			)
		} else {
			span.SetAttributes(attribute.Bool("mcp.tool.success", true))
		}
		span.End()
	}
}

// TraceSandboxCreate traces a sandbox creation operation.
func (tp *TracerProvider) TraceSandboxCreate(ctx context.Context, image string, name string) (context.Context, trace.Span) {
	return tp.tracer.Start(ctx, "sandbox.create",
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(
			attribute.String("sandbox.image", image),
			attribute.String("sandbox.name", name),
			attribute.String("apex.component", tp.config.ServiceName),
		),
	)
}

// TraceSandboxExec traces a command execution inside a sandbox.
func (tp *TracerProvider) TraceSandboxExec(ctx context.Context, sandboxID string, command string) (context.Context, trace.Span) {
	return tp.tracer.Start(ctx, "sandbox.exec",
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(
			attribute.String("sandbox.id", sandboxID),
			attribute.String("sandbox.command", command),
			attribute.String("apex.component", tp.config.ServiceName),
		),
	)
}

// TraceSandboxDestroy traces a sandbox destruction.
func (tp *TracerProvider) TraceSandboxDestroy(ctx context.Context, sandboxID string) (context.Context, trace.Span) {
	return tp.tracer.Start(ctx, "sandbox.destroy",
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(
			attribute.String("sandbox.id", sandboxID),
			attribute.String("apex.component", tp.config.ServiceName),
		),
	)
}

// TraceSandboxCopy traces a file copy operation to/from a sandbox.
func (tp *TracerProvider) TraceSandboxCopy(ctx context.Context, sandboxID string, direction string, path string) (context.Context, trace.Span) {
	return tp.tracer.Start(ctx, "sandbox.copy."+direction,
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(
			attribute.String("sandbox.id", sandboxID),
			attribute.String("sandbox.copy.direction", direction),
			attribute.String("sandbox.copy.path", path),
			attribute.String("apex.component", tp.config.ServiceName),
		),
	)
}

// TraceSandboxStatus traces a sandbox status check.
func (tp *TracerProvider) TraceSandboxStatus(ctx context.Context, sandboxID string) (context.Context, trace.Span) {
	return tp.tracer.Start(ctx, "sandbox.status",
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(
			attribute.String("sandbox.id", sandboxID),
			attribute.String("apex.component", tp.config.ServiceName),
		),
	)
}
