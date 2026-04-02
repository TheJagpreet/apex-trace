#!/usr/bin/env node
// =============================================================================
// apex-trace Node.js Hook Tracer
// =============================================================================
// Tracing integration for apex-neural lifecycle hooks (hooks.json).
// This script can be invoked from hooks to trace agent sessions, tool usage,
// subagent lifecycle, and phase gates.
//
// Usage (in hooks.json):
//   {
//     "hooks": {
//       "SessionStart": [{
//         "command": "node /path/to/trace-hook.js session-start"
//       }]
//     }
//   }
//
// Or import as a module:
//   const { HookTracer } = require('./trace-hook');
// =============================================================================

const http = require('http');
const crypto = require('crypto');

class HookTracer {
  constructor(config = {}) {
    this.serviceName = config.serviceName || process.env.APEX_TRACE_SERVICE_NAME || 'apex-neural';
    this.serviceVersion = config.serviceVersion || process.env.APEX_TRACE_SERVICE_VERSION || '1.0.0';
    this.environment = config.environment || process.env.APEX_TRACE_ENVIRONMENT || 'development';
    this.otlpEndpoint = config.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
    this.enabled = config.enabled !== undefined ? config.enabled : (process.env.APEX_TRACE_ENABLED !== 'false');
    this.consoleLog = config.consoleLog || process.env.APEX_TRACE_CONSOLE === 'true';

    // Parse inherited trace context
    const traceparent = process.env.TRACEPARENT;
    if (traceparent) {
      const parts = traceparent.split('-');
      this.traceId = parts[1];
      this.parentSpanId = parts[2];
    } else {
      this.traceId = crypto.randomBytes(16).toString('hex');
      this.parentSpanId = '';
    }

    this.spans = new Map();
  }

  _generateSpanId() {
    return crypto.randomBytes(8).toString('hex');
  }

  _timestampNs() {
    const hrtime = process.hrtime.bigint();
    return String(hrtime);
  }

  /**
   * Start a new span.
   * @param {string} name - Span name
   * @param {Object} attributes - Span attributes
   * @param {string} parentSpanId - Parent span ID (optional)
   * @returns {string} Span ID
   */
  startSpan(name, attributes = {}, parentSpanId = null) {
    const spanId = this._generateSpanId();
    const startTime = this._timestampNs();

    this.spans.set(spanId, {
      spanId,
      traceId: this.traceId,
      parentSpanId: parentSpanId || this.parentSpanId,
      name,
      startTimeNs: startTime,
      attributes: {
        'apex.component': this.serviceName,
        ...attributes,
      },
      events: [],
      status: 'UNSET',
    });

    // Update traceparent for child processes
    process.env.TRACEPARENT = `00-${this.traceId}-${spanId}-01`;

    if (this.consoleLog) {
      console.log(`[apex-trace] Started span: name=${name} id=${spanId}`);
    }

    return spanId;
  }

  /**
   * Set an attribute on a span.
   */
  setAttribute(spanId, key, value) {
    const span = this.spans.get(spanId);
    if (span) {
      span.attributes[key] = String(value);
    }
  }

  /**
   * Add an event to a span.
   */
  addEvent(spanId, eventName, attributes = {}) {
    const span = this.spans.get(spanId);
    if (span) {
      span.events.push({
        name: eventName,
        timestampNs: this._timestampNs(),
        attributes,
      });
    }
  }

  /**
   * Mark a span as error.
   */
  setError(spanId, errorMessage) {
    const span = this.spans.get(spanId);
    if (span) {
      span.status = 'ERROR';
      span.attributes['error'] = 'true';
      span.attributes['error.message'] = errorMessage;
    }
  }

  /**
   * End a span and export it via OTLP.
   */
  async endSpan(spanId) {
    const span = this.spans.get(spanId);
    if (!span) return;

    const endTime = this._timestampNs();
    this.spans.delete(spanId);

    const otlp = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: this.serviceName } },
            { key: 'service.version', value: { stringValue: this.serviceVersion } },
            { key: 'deployment.environment', value: { stringValue: this.environment } },
            { key: 'apex.component', value: { stringValue: this.serviceName } },
          ],
        },
        scopeSpans: [{
          scope: { name: 'apex-trace-hook', version: '1.0.0' },
          spans: [{
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            kind: 1,
            startTimeUnixNano: span.startTimeNs,
            endTimeUnixNano: endTime,
            attributes: Object.entries(span.attributes).map(([key, value]) => ({
              key,
              value: { stringValue: String(value) },
            })),
            events: span.events.map(e => ({
              name: e.name,
              timeUnixNano: e.timestampNs,
              attributes: Object.entries(e.attributes).map(([key, value]) => ({
                key,
                value: { stringValue: String(value) },
              })),
            })),
            status: { code: span.status === 'ERROR' ? 2 : 1 },
          }],
        }],
      }],
    };

    if (this.consoleLog) {
      console.log(`[apex-trace] Ended span: id=${spanId}`);
      console.log(JSON.stringify(otlp, null, 2));
    }

    if (this.enabled) {
      await this._exportOTLP(otlp);
    }
  }

  /**
   * Export OTLP JSON to the collector endpoint.
   */
  _exportOTLP(otlp) {
    return new Promise((resolve) => {
      const url = new URL(`${this.otlpEndpoint}/v1/traces`);
      const data = JSON.stringify(otlp);

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
      };

      const req = http.request(options, (res) => {
        res.resume();
        resolve();
      });

      req.on('error', () => resolve()); // Silently ignore errors
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(data);
      req.end();
    });
  }

  /**
   * Trace a hook execution.
   * @param {string} hookType - Hook type (SessionStart, PreToolUse, etc.)
   * @param {Object} hookData - Hook-specific data
   * @param {Function} fn - Async function to execute within the span
   */
  async traceHook(hookType, hookData = {}, fn = null) {
    const spanId = this.startSpan(`hook.${hookType}`, {
      'hook.type': hookType,
      ...Object.fromEntries(
        Object.entries(hookData).map(([k, v]) => [`hook.${k}`, String(v)])
      ),
    });

    if (fn) {
      try {
        const result = await fn(spanId);
        await this.endSpan(spanId);
        return result;
      } catch (error) {
        this.setError(spanId, error.message || String(error));
        await this.endSpan(spanId);
        throw error;
      }
    }

    return spanId;
  }

  /**
   * Trace a tool usage (PreToolUse / PostToolUse).
   */
  async traceToolUse(phase, toolName, toolInput = {}) {
    return this.traceHook(`${phase}ToolUse`, {
      tool_name: toolName,
      tool_phase: phase,
      ...toolInput,
    });
  }

  /**
   * Trace a subagent lifecycle event.
   */
  async traceSubagent(phase, agentId, agentType = '') {
    return this.traceHook(`Subagent${phase}`, {
      agent_id: agentId,
      agent_type: agentType,
      agent_phase: phase,
    });
  }

  /**
   * Get current traceparent header value.
   */
  getTraceparent() {
    return process.env.TRACEPARENT || '';
  }

  /**
   * Get current trace ID.
   */
  getTraceId() {
    return this.traceId;
  }

  /**
   * Shutdown: end all remaining spans.
   */
  async shutdown() {
    const spanIds = Array.from(this.spans.keys());
    for (const spanId of spanIds) {
      await this.endSpan(spanId);
    }
    if (this.consoleLog) {
      console.log('[apex-trace] Shutdown complete');
    }
  }
}

// =============================================================================
// CLI Mode: Run as a standalone script for hook integration
// =============================================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error('Usage: trace-hook.js <command> [options]');
    console.error('Commands: session-start, session-end, tool-pre, tool-post, subagent-start, subagent-stop, phase-gate');
    process.exit(1);
  }

  const tracer = new HookTracer();

  (async () => {
    switch (command) {
      case 'session-start': {
        const spanId = await tracer.traceHook('SessionStart', {
          session_id: process.env.SESSION_ID || 'unknown',
          workspace: process.env.WORKSPACE || process.cwd(),
        });
        // Output the span ID and traceparent for the session to use
        console.log(JSON.stringify({
          spanId,
          traceId: tracer.getTraceId(),
          traceparent: tracer.getTraceparent(),
        }));
        await tracer.endSpan(spanId);
        break;
      }

      case 'session-end': {
        const spanId = await tracer.traceHook('Stop', {
          session_id: process.env.SESSION_ID || 'unknown',
          reason: args[1] || 'normal',
        });
        await tracer.endSpan(spanId);
        break;
      }

      case 'tool-pre': {
        const toolName = args[1] || 'unknown';
        const spanId = await tracer.traceToolUse('Pre', toolName);
        console.log(JSON.stringify({
          spanId,
          traceparent: tracer.getTraceparent(),
        }));
        await tracer.endSpan(spanId);
        break;
      }

      case 'tool-post': {
        const toolName = args[1] || 'unknown';
        const spanId = await tracer.traceToolUse('Post', toolName);
        await tracer.endSpan(spanId);
        break;
      }

      case 'subagent-start': {
        const agentId = args[1] || 'unknown';
        const agentType = args[2] || '';
        const spanId = await tracer.traceSubagent('Start', agentId, agentType);
        console.log(JSON.stringify({
          spanId,
          traceparent: tracer.getTraceparent(),
        }));
        await tracer.endSpan(spanId);
        break;
      }

      case 'subagent-stop': {
        const agentId = args[1] || 'unknown';
        const spanId = await tracer.traceSubagent('Stop', agentId);
        await tracer.endSpan(spanId);
        break;
      }

      case 'phase-gate': {
        const phase = args[1] || 'unknown';
        const status = args[2] || 'pass';
        const spanId = await tracer.traceHook('PhaseGate', {
          phase,
          gate_status: status,
        });
        await tracer.endSpan(spanId);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }

    await tracer.shutdown();
  })();
}

module.exports = { HookTracer };
