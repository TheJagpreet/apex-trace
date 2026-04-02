# apex-trace

Distributed tracing libraries for the **Apex ecosystem**. Trace everything from agent orchestration (`apex-neural`) through sandbox management (`apex-venv`) to the dashboard UI (`apex-dashboard`) with full end-to-end visibility.

Built on [OpenTelemetry](https://opentelemetry.io/) — traces export via OTLP to any compatible backend (Jaeger, Grafana Tempo, Zipkin, Datadog, etc.).

```
┌──────────────────────┐       ┌──────────────────────┐       ┌──────────────────────┐
│   apex-neural        │       │   apex-venv           │       │   apex-dashboard     │
│   (Agents/Hooks)     │──────▶│   (Go Services)       │◀──────│   (React UI)         │
│                      │ trace │                       │ trace │                      │
│  shell/trace.sh      │ ctx   │  go/                  │ ctx   │  js/                 │
│  shell/trace.ps1     │──────▶│  (HTTP middleware,    │◀──────│  (Axios interceptor, │
│  shell/trace-hook.js │       │   MCP tracing)        │       │   React hooks)       │
└──────────────────────┘       └───────────────────────┘       └──────────────────────┘
         │                              │                              │
         └──────────────────────────────┼──────────────────────────────┘
                                        ▼
                              ┌─────────────────────┐
                              │   OTLP Collector     │
                              │   (Jaeger / Tempo /  │
                              │    Zipkin / etc.)     │
                              └─────────────────────┘
```

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start — Collector Setup](#quick-start--collector-setup)
- [Library 1: Go — for apex-venv](#library-1-go--for-apex-venv)
- [Library 2: TypeScript/React — for apex-dashboard](#library-2-typescriptreact--for-apex-dashboard)
- [Library 3: Shell — for apex-neural](#library-3-shell--for-apex-neural)
- [End-to-End Trace Flow](#end-to-end-trace-flow)
- [Configuration Reference](#configuration-reference)

---

## Prerequisites

- **Go 1.24+** (for apex-venv integration)
- **Node.js 18+** (for apex-dashboard and apex-neural hook tracer)
- **Bash 4+** or **PowerShell 5+** (for apex-neural shell tracing)
- **Docker / Podman** (to run the OTLP collector)
- **python3** (optional, for shell tracing attribute/event support)

---

## Quick Start — Collector Setup

Before integrating any library, start an OTLP-compatible collector. The easiest option is **Jaeger** (all-in-one):

```bash
# Start Jaeger with OTLP support (receives traces on port 4318)
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# Jaeger UI will be available at http://localhost:16686
```

Or use **Grafana Tempo + Grafana**:

```bash
# docker-compose.yml for Tempo
cat > /tmp/tempo-config.yaml << 'EOF'
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        http:
storage:
  trace:
    backend: local
    local:
      path: /tmp/tempo/blocks
EOF

docker run -d --name tempo \
  -p 3200:3200 \
  -p 4318:4318 \
  -v /tmp/tempo-config.yaml:/etc/tempo.yaml \
  grafana/tempo:latest \
  -config.file=/etc/tempo.yaml
```

All three libraries default to sending traces to `localhost:4318` (OTLP HTTP).

---

## Library 1: Go — for apex-venv

The Go tracing library provides HTTP middleware, MCP tool call tracing, and context propagation for all three apex-venv services (`apex-server`, `apex-mcp`, `apex-venv` CLI).

### Step 1: Add the dependency

```bash
cd /path/to/apex-venv
go get github.com/TheJagpreet/apex-trace/go@latest
```

### Step 2: Integrate with apex-server (HTTP REST API)

Edit `cmd/apex-server/main.go`:

```go
import (
    apextrace "github.com/TheJagpreet/apex-trace/go"
)

func main() {
    // Initialize the tracer
    tp, err := apextrace.Init(apextrace.Config{
        ServiceName:    "apex-server",
        ServiceVersion: "1.0.0",
        Environment:    "development",
        // OTLPEndpoint: "localhost:4318",  // default
        // UseStdout:    true,              // enable for debugging
    })
    if err != nil {
        log.Fatalf("Failed to init tracer: %v", err)
    }
    defer tp.Shutdown(context.Background())

    mux := http.NewServeMux()
    // ... register your routes ...

    // Wrap the entire mux with tracing middleware
    tracedHandler := tp.HTTPMiddleware(mux)

    log.Println("Starting server on :8080")
    http.ListenAndServe(":8080", tracedHandler)
}
```

For tracing specific sandbox operations inside your handlers:

```go
func createSandboxHandler(tp *apextrace.TracerProvider) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // The middleware already created a parent span.
        // Create a child span for the sandbox operation.
        ctx, span := tp.TraceSandboxCreate(r.Context(), image, name)
        defer span.End()

        // ... create sandbox logic ...

        // Add events for important steps
        apextrace.AddEvent(ctx, "sandbox.container_started",
            attribute.String("container.id", containerID),
        )

        // If something goes wrong:
        // apextrace.SetError(ctx, err)
    }
}
```

### Step 3: Integrate with apex-mcp (MCP Server)

Edit `cmd/apex-mcp/main.go`:

```go
import (
    apextrace "github.com/TheJagpreet/apex-trace/go"
)

func main() {
    tp, err := apextrace.Init(apextrace.Config{
        ServiceName:    "apex-mcp",
        ServiceVersion: "1.0.0",
    })
    if err != nil {
        log.Fatalf("Failed to init tracer: %v", err)
    }
    defer tp.Shutdown(context.Background())

    // In your MCP tool handler, trace each tool call:
    // Example for create_sandbox tool
    handleCreateSandbox := func(ctx context.Context, args map[string]string) (interface{}, error) {
        ctx, finish := tp.MCPToolSpan(ctx, "create_sandbox", args)
        defer func() { finish(nil) }()

        // ... tool logic ...

        result, err := provider.CreateSandbox(ctx, args)
        if err != nil {
            finish(err)
            return nil, err
        }
        return result, nil
    }
}
```

### Step 4: Integrate with apex-venv CLI

Edit `cmd/apex-venv/main.go`:

```go
import (
    apextrace "github.com/TheJagpreet/apex-trace/go"
)

func main() {
    tp, err := apextrace.Init(apextrace.Config{
        ServiceName:    "apex-venv-cli",
        ServiceVersion: "1.0.0",
    })
    if err != nil {
        log.Fatalf("Failed to init tracer: %v", err)
    }
    defer tp.Shutdown(context.Background())

    // Trace CLI commands
    ctx, span := tp.StartSpan(context.Background(), "cli.create",
        attribute.String("cli.command", "create"),
    )
    defer span.End()

    // When calling the HTTP server, propagate trace context:
    req, _ := http.NewRequestWithContext(ctx, "POST", serverURL+"/api/sandboxes", body)
    apextrace.InjectHTTPHeaders(ctx, req)
    resp, err := http.DefaultClient.Do(req)
}
```

### Step 5: Propagate context to shell scripts

When apex-venv spawns processes or calls shell scripts:

```go
// Get trace context as environment variables
envVars := apextrace.InjectToEnv(ctx)
// envVars contains: {"traceparent": "00-<traceId>-<spanId>-01", ...}

cmd := exec.CommandContext(ctx, "bash", "-c", script)
for k, v := range envVars {
    cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
}
cmd.Run()
```

---

## Library 2: TypeScript/React — for apex-dashboard

The TypeScript library provides a React context provider, component lifecycle tracing, Axios interceptor for automatic HTTP tracing, and user interaction tracking.

### Step 1: Install the package

```bash
cd /path/to/apex-dashboard

# Option A: Install from GitHub directly
npm install github:TheJagpreet/apex-trace#main --save

# Option B: Copy the library locally and link
git clone https://github.com/TheJagpreet/apex-trace.git ../apex-trace
cd ../apex-trace/js
npm install
npm run build
npm link
cd /path/to/apex-dashboard
npm link @apex-trace/js

# Option C: Copy the js/src/ directory into your project
cp -r ../apex-trace/js/src/ src/tracing/
```

### Step 2: Wrap your app with TracingProvider

Edit `src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { TracingProvider } from '@apex-trace/js';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TracingProvider
      config={{
        serviceName: 'apex-dashboard',
        serviceVersion: '1.0.0',
        environment: 'development',
        otlpEndpoint: 'http://localhost:4318/v1/traces',
        // enableConsoleLog: true,  // for debugging
      }}
    >
      <App />
    </TracingProvider>
  </React.StrictMode>,
);
```

### Step 3: Add Axios interceptor for automatic HTTP tracing

Edit `src/api/index.ts` (or wherever your Axios instance is configured):

```typescript
import axios from 'axios';
import { ApexTracer, createAxiosTracingInterceptor } from '@apex-trace/js';

const api = axios.create({
  baseURL: 'http://localhost:8080',
});

// This will be set up after the tracer is initialized.
// If you're using TracingProvider, do this in a useEffect:
const tracer = new ApexTracer({
  serviceName: 'apex-dashboard',
  serviceVersion: '1.0.0',
});

// All HTTP requests will now automatically:
// 1. Create a client span
// 2. Inject W3C traceparent headers
// 3. Record response status and errors
createAxiosTracingInterceptor(api, tracer);

export default api;
```

### Step 4: Trace page views with the useSpan hook

Edit your page components (e.g., `src/pages/Dashboard.tsx`):

```tsx
import { useSpan, useTracing } from '@apex-trace/js';

export default function Dashboard() {
  // Automatically creates a span when the component mounts
  // and ends it when the component unmounts
  useSpan('page.dashboard', { 'page.url': '/dashboard' });

  return <div>Dashboard content</div>;
}
```

### Step 5: Trace user interactions

```tsx
import { useTracing } from '@apex-trace/js';

export default function CreateSandbox() {
  const { tracer } = useTracing();

  const handleCreate = async () => {
    // Trace the entire create flow
    await tracer.traceAsync('sandbox.create.submit', async (span) => {
      span.setAttribute('sandbox.image', selectedImage);

      const response = await api.post('/api/sandboxes', { image: selectedImage });
      span.setAttribute('sandbox.id', response.data.id);

      return response;
    });
  };

  const handleButtonClick = () => {
    const span = tracer.traceUserAction('click', 'create-sandbox-btn');
    handleCreate()
      .then(() => tracer.endSpan(span))
      .catch((err) => tracer.endSpan(span, err));
  };

  return <button onClick={handleButtonClick}>Create Sandbox</button>;
}
```

### Step 6: Trace sandbox operations

```tsx
import { useTracing } from '@apex-trace/js';

export default function SandboxDetail({ sandboxId }: { sandboxId: string }) {
  const { tracer } = useTracing();

  const handleExec = async (command: string) => {
    const span = tracer.traceSandboxOperation('exec', sandboxId);
    span.setAttribute('sandbox.command', command);

    try {
      const result = await api.post(`/api/sandboxes/${sandboxId}/exec`, { command });
      span.setAttribute('sandbox.exec.exit_code', result.data.exitCode);
      tracer.endSpan(span);
    } catch (err) {
      tracer.endSpan(span, err instanceof Error ? err : new Error(String(err)));
    }
  };

  // ...
}
```

---

## Library 3: Shell — for apex-neural

The shell tracing library provides tracing for Bash scripts, PowerShell scripts, and a Node.js hook tracer for apex-neural's lifecycle hooks system.

### Step 1: Copy the library into apex-neural

```bash
cd /path/to/apex-neural

# Create a tracing directory
mkdir -p .tracing

# Copy the shell tracing files
cp /path/to/apex-trace/shell/trace.sh      .tracing/trace.sh
cp /path/to/apex-trace/shell/trace.ps1     .tracing/trace.ps1
cp /path/to/apex-trace/shell/trace-hook.js .tracing/trace-hook.js

# Make trace.sh executable
chmod +x .tracing/trace.sh
```

### Step 2: Integrate with Bash scripts

Edit your setup scripts (e.g., `scripts/setup.sh`):

```bash
#!/usr/bin/env bash

# Source the tracing library
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/.tracing/trace.sh"

# Initialize the tracer
apex_trace_init "apex-neural" "1.0.0"

# Trace the entire setup process
root_span=$(apex_trace_start_span "setup.bash")
apex_trace_set_attribute "$root_span" "setup.os" "$(uname -s)"
apex_trace_set_attribute "$root_span" "setup.arch" "$(uname -m)"

# Trace individual steps using the convenience function
apex_trace_exec "setup.check_dependencies" command -v node
apex_trace_exec "setup.check_dependencies" command -v npm

# Or trace manually with events
install_span=$(apex_trace_start_span "setup.install" "$root_span")
apex_trace_add_event "$install_span" "install.started" "package=apex-neural"

npm install 2>&1
exit_code=$?

if [ $exit_code -ne 0 ]; then
  apex_trace_set_error "$install_span" "npm install failed with exit code $exit_code"
fi
apex_trace_end_span "$install_span"

# End the root span
apex_trace_end_span "$root_span"
# apex_trace_shutdown is called automatically on exit via trap
```

### Step 3: Integrate with PowerShell scripts

Edit your setup scripts (e.g., `scripts/setup.ps1`):

```powershell
# Import the tracing module
$ScriptRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. "$ScriptRoot/.tracing/trace.ps1"

# Initialize the tracer
Initialize-ApexTrace -ServiceName "apex-neural" -ServiceVersion "1.0.0"

# Trace the setup process
$rootSpan = Start-ApexSpan -Name "setup.powershell"
Set-ApexSpanAttribute -SpanId $rootSpan -Key "setup.os" -Value "Windows"

# Use the convenience function for simple operations
Invoke-ApexTraced -Name "setup.check_node" -ScriptBlock {
    node --version
}

Invoke-ApexTraced -Name "setup.npm_install" -ScriptBlock {
    npm install
} -Attributes @{ "package" = "apex-neural" }

# End the root span
Stop-ApexSpan -SpanId $rootSpan
Stop-ApexTrace
```

### Step 4: Integrate with lifecycle hooks (hooks.json)

This is where the real power comes in — tracing every agent action through apex-neural's hook system.

Edit `hooks.json` to add tracing hooks:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "node .tracing/trace-hook.js session-start",
        "timeout": 5000,
        "description": "Initialize trace for agent session"
      }
    ],
    "PreToolUse": [
      {
        "type": "command",
        "command": "node .tracing/trace-hook.js tool-pre ${TOOL_NAME}",
        "timeout": 5000,
        "description": "Trace tool invocation start"
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "node .tracing/trace-hook.js tool-post ${TOOL_NAME}",
        "timeout": 5000,
        "description": "Trace tool invocation end"
      }
    ],
    "SubagentStart": [
      {
        "type": "command",
        "command": "node .tracing/trace-hook.js subagent-start ${AGENT_ID} ${AGENT_TYPE}",
        "timeout": 5000,
        "description": "Trace subagent spawn"
      }
    ],
    "SubagentStop": [
      {
        "type": "command",
        "command": "node .tracing/trace-hook.js subagent-stop ${AGENT_ID}",
        "timeout": 5000,
        "description": "Trace subagent completion"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "node .tracing/trace-hook.js session-end normal",
        "timeout": 5000,
        "description": "Trace session end"
      }
    ]
  }
}
```

### Step 5: Use the Node.js hook tracer programmatically

For more advanced hook scripts:

```javascript
const { HookTracer } = require('./.tracing/trace-hook');

const tracer = new HookTracer({
  serviceName: 'apex-neural',
  serviceVersion: '1.0.0',
  consoleLog: true,  // set to false in production
});

// Trace a complete hook execution
async function onSessionStart() {
  await tracer.traceHook('SessionStart', {
    session_id: process.env.SESSION_ID,
    workspace: process.cwd(),
    agent_count: '4',  // Planning, Architecture, Implementation, Testing
  }, async (spanId) => {
    // Your hook logic here
    tracer.addEvent(spanId, 'session.agents_loaded', {
      'agents': 'planner,architect,implementer,tester'
    });
  });

  await tracer.shutdown();
}

onSessionStart();
```

### Step 6: Pass trace context between hooks

The trace context (`TRACEPARENT` env var) is automatically propagated. When a hook runs:

1. The tracer checks for `TRACEPARENT` in the environment
2. If found, new spans become children of the existing trace
3. If not found, a new trace is started
4. The `TRACEPARENT` is updated for subsequent processes

This means if apex-neural calls apex-venv (which has the Go tracing), the trace flows seamlessly:

```
apex-neural (SessionStart)
  └── apex-neural (PreToolUse: create_sandbox)
        └── apex-venv (HTTP POST /api/sandboxes)  ← trace context propagated via headers
              └── apex-venv (sandbox.create)
                    └── apex-venv (container.start)
```

---

## End-to-End Trace Flow

Here's how a complete trace flows through the system:

```
1. Agent Session Starts (apex-neural)
   ├── trace-hook.js session-start → creates root span
   │   TRACEPARENT=00-<traceId>-<spanId>-01
   │
2. Agent Uses Tool (apex-neural)
   ├── trace-hook.js tool-pre create_sandbox
   │
3. MCP Tool Call (apex-neural → apex-venv)
   │   TRACEPARENT passed via MCP message / HTTP header
   ├── apex-mcp: mcp.tool/create_sandbox span (Go)
   │   └── sandbox.create span
   │       └── container started event
   │
4. Dashboard Fetches Status (apex-dashboard → apex-venv)
   │   traceparent header injected by Axios interceptor
   ├── apex-dashboard: HTTP GET /api/sandboxes span (JS)
   ├── apex-server: GET /api/sandboxes span (Go middleware)
   │
5. User Interacts with Dashboard (apex-dashboard)
   ├── page.sandboxes span (React useSpan)
   ├── user.click span (traceUserAction)
   │   └── HTTP POST /api/sandboxes/:id/exec span (Axios)
   │       └── apex-server: POST /api/sandboxes/:id/exec span (Go)
   │           └── sandbox.exec span
   │
6. Agent Session Ends (apex-neural)
   └── trace-hook.js session-end
```

All of these spans share the same `traceId`, allowing you to see the complete flow in Jaeger/Tempo.

---

## Configuration Reference

All libraries share a common configuration pattern:

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint | `http://localhost:4318` |
| `APEX_TRACE_SERVICE_NAME` | Service name | Library-specific |
| `APEX_TRACE_SERVICE_VERSION` | Service version | `1.0.0` |
| `APEX_TRACE_ENVIRONMENT` | Deployment environment | `development` |
| `APEX_TRACE_ENABLED` | Enable/disable tracing | `true` |
| `APEX_TRACE_CONSOLE` | Log spans to console | `false` |
| `TRACEPARENT` | W3C Trace Context (auto-propagated) | — |

### Go Library Config

```go
apextrace.Config{
    ServiceName:    "apex-server",     // required
    ServiceVersion: "1.0.0",           // optional
    Environment:    "development",     // optional, default: "development"
    OTLPEndpoint:   "localhost:4318",  // optional, default from env or "localhost:4318"
    UseStdout:      false,             // optional, enable pretty-print to stdout
    SampleRate:     1.0,               // optional, 0.0-1.0, default: 1.0
}
```

### TypeScript Library Config

```typescript
{
  serviceName: 'apex-dashboard',                         // required
  serviceVersion: '1.0.0',                               // optional
  environment: 'development',                            // optional
  otlpEndpoint: 'http://localhost:4318/v1/traces',       // optional
  enableConsoleLog: false,                                // optional
  sampleRate: 1.0,                                       // optional
}
```

### Shell Library Config

Set via environment variables before sourcing `trace.sh` / `trace.ps1`:

```bash
export APEX_TRACE_SERVICE_NAME="apex-neural"
export APEX_TRACE_SERVICE_VERSION="1.0.0"
export APEX_TRACE_ENVIRONMENT="development"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export APEX_TRACE_ENABLED="true"
export APEX_TRACE_CONSOLE="false"

source .tracing/trace.sh
```

---

## License

MIT