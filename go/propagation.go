package apextrace

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

// MapCarrier is a simple map-based carrier for trace context propagation.
// Useful for passing trace context through non-HTTP channels (e.g., MCP messages, CLI args).
type MapCarrier map[string]string

// Get returns the value for a key.
func (c MapCarrier) Get(key string) string {
	return c[key]
}

// Set sets a key-value pair.
func (c MapCarrier) Set(key, value string) {
	c[key] = value
}

// Keys returns all keys.
func (c MapCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}

// InjectToMap injects the current trace context into a map.
// Use this to propagate trace context through non-HTTP channels.
func InjectToMap(ctx context.Context) map[string]string {
	carrier := MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	return carrier
}

// ExtractFromMap extracts trace context from a map into a context.
// Use this to restore trace context from non-HTTP channels.
func ExtractFromMap(ctx context.Context, carrier map[string]string) context.Context {
	return otel.GetTextMapPropagator().Extract(ctx, MapCarrier(carrier))
}

// EnvCarrier reads/writes trace context from environment-style key-value pairs.
// This is useful for propagating context to shell scripts via environment variables.
type EnvCarrier struct {
	values map[string]string
}

// NewEnvCarrier creates a new EnvCarrier.
func NewEnvCarrier() *EnvCarrier {
	return &EnvCarrier{values: make(map[string]string)}
}

// Get returns the value for a key.
func (c *EnvCarrier) Get(key string) string {
	return c.values[key]
}

// Set sets a key-value pair.
func (c *EnvCarrier) Set(key, value string) {
	c.values[key] = value
}

// Keys returns all keys.
func (c *EnvCarrier) Keys() []string {
	keys := make([]string, 0, len(c.values))
	for k := range c.values {
		keys = append(keys, k)
	}
	return keys
}

// ToEnvVars converts the carrier to environment variable format.
// Keys are uppercased and dashes are replaced with underscores.
func (c *EnvCarrier) ToEnvVars() map[string]string {
	return c.values
}

// InjectToEnv injects the current trace context into environment variable format.
// The returned map can be set as environment variables for child processes (e.g., shell scripts).
func InjectToEnv(ctx context.Context) map[string]string {
	carrier := &EnvCarrier{values: make(map[string]string)}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	return carrier.values
}

// ExtractFromEnv extracts trace context from environment variables.
func ExtractFromEnv(ctx context.Context, envVars map[string]string) context.Context {
	carrier := &EnvCarrier{values: envVars}
	return otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier(carrier.values))
}
