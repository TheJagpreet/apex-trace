#!/usr/bin/env bash
# =============================================================================
# apex-trace Shell Tracing Library
# =============================================================================
# Lightweight distributed tracing for shell scripts in the Apex ecosystem.
# Generates W3C Trace Context compatible trace/span IDs and exports spans
# to an OTLP HTTP endpoint as JSON.
#
# Usage:
#   source /path/to/trace.sh
#   apex_trace_init "apex-neural" "1.0.0"
#   span_id=$(apex_trace_start_span "hook.session_start")
#   # ... do work ...
#   apex_trace_end_span "$span_id"
#   apex_trace_shutdown
# =============================================================================

# Configuration (override via environment variables)
APEX_TRACE_SERVICE_NAME="${APEX_TRACE_SERVICE_NAME:-apex-neural}"
APEX_TRACE_SERVICE_VERSION="${APEX_TRACE_SERVICE_VERSION:-1.0.0}"
APEX_TRACE_ENVIRONMENT="${APEX_TRACE_ENVIRONMENT:-development}"
APEX_TRACE_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"
APEX_TRACE_ENABLED="${APEX_TRACE_ENABLED:-true}"
APEX_TRACE_CONSOLE="${APEX_TRACE_CONSOLE:-false}"

# Internal state
_APEX_TRACE_ID=""
_APEX_TRACE_SPANS=()
_APEX_TRACE_SPAN_DIR=""

# Generate a random hex string of given length (in bytes, output is 2x chars).
_apex_hex() {
  local bytes="${1:-16}"
  if command -v openssl &>/dev/null; then
    openssl rand -hex "$bytes" 2>/dev/null
  elif [ -r /dev/urandom ]; then
    head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
  else
    # Fallback: use $RANDOM
    local result=""
    for ((i = 0; i < bytes; i++)); do
      result+=$(printf '%02x' $((RANDOM % 256)))
    done
    echo "$result"
  fi
}

# Get current timestamp in nanoseconds (or milliseconds fallback).
_apex_timestamp_ns() {
  if date +%s%N | grep -qv 'N$' 2>/dev/null; then
    date +%s%N
  else
    # macOS fallback: seconds with millisecond precision
    local sec
    sec=$(date +%s)
    echo "${sec}000000000"
  fi
}

# Initialize the tracer.
# Usage: apex_trace_init [service_name] [service_version]
apex_trace_init() {
  local service_name="${1:-$APEX_TRACE_SERVICE_NAME}"
  local service_version="${2:-$APEX_TRACE_SERVICE_VERSION}"

  APEX_TRACE_SERVICE_NAME="$service_name"
  APEX_TRACE_SERVICE_VERSION="$service_version"

  # Create temp directory for span data
  _APEX_TRACE_SPAN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/apex-trace.XXXXXX")

  # Generate or inherit trace ID
  if [ -n "$TRACEPARENT" ]; then
    # Parse W3C traceparent: version-traceId-parentSpanId-flags
    IFS='-' read -r _ _APEX_TRACE_ID _APEX_PARENT_SPAN_ID _ <<< "$TRACEPARENT"
  else
    _APEX_TRACE_ID=$(_apex_hex 16)
    _APEX_PARENT_SPAN_ID=""
  fi

  if [ "$APEX_TRACE_CONSOLE" = "true" ]; then
    echo "[apex-trace] Initialized: service=$service_name version=$service_version trace_id=$_APEX_TRACE_ID"
  fi
}

# Start a new span.
# Usage: span_id=$(apex_trace_start_span "span.name" ["parent_span_id"])
# Returns: span ID
apex_trace_start_span() {
  local span_name="$1"
  local parent_span_id="${2:-$_APEX_PARENT_SPAN_ID}"
  local span_id
  span_id=$(_apex_hex 8)
  local start_time
  start_time=$(_apex_timestamp_ns)

  # Store span data
  cat > "${_APEX_TRACE_SPAN_DIR}/${span_id}.json" <<EOF
{
  "span_id": "${span_id}",
  "trace_id": "${_APEX_TRACE_ID}",
  "parent_span_id": "${parent_span_id}",
  "name": "${span_name}",
  "start_time_ns": "${start_time}",
  "service_name": "${APEX_TRACE_SERVICE_NAME}",
  "service_version": "${APEX_TRACE_SERVICE_VERSION}",
  "environment": "${APEX_TRACE_ENVIRONMENT}",
  "attributes": {},
  "events": [],
  "status": "UNSET"
}
EOF

  # Export traceparent for child processes
  export TRACEPARENT="00-${_APEX_TRACE_ID}-${span_id}-01"

  if [ "$APEX_TRACE_CONSOLE" = "true" ]; then
    echo "[apex-trace] Started span: name=$span_name id=$span_id parent=$parent_span_id"
  fi

  echo "$span_id"
}

# Add an attribute to a span.
# Usage: apex_trace_set_attribute "span_id" "key" "value"
apex_trace_set_attribute() {
  local span_id="$1"
  local key="$2"
  local value="$3"
  local span_file="${_APEX_TRACE_SPAN_DIR}/${span_id}.json"

  if [ -f "$span_file" ]; then
    # Use a temp file for atomic update
    local tmp_file
    tmp_file=$(mktemp)
    if command -v python3 &>/dev/null; then
      python3 -c "
import json, sys
with open('$span_file') as f:
    data = json.load(f)
data['attributes']['$key'] = '$value'
with open('$tmp_file', 'w') as f:
    json.dump(data, f)
" 2>/dev/null && mv "$tmp_file" "$span_file"
    else
      rm -f "$tmp_file"
    fi
  fi
}

# Add an event to a span.
# Usage: apex_trace_add_event "span_id" "event_name" ["key=value" ...]
apex_trace_add_event() {
  local span_id="$1"
  local event_name="$2"
  shift 2
  local span_file="${_APEX_TRACE_SPAN_DIR}/${span_id}.json"
  local timestamp
  timestamp=$(_apex_timestamp_ns)

  if [ -f "$span_file" ] && command -v python3 &>/dev/null; then
    local attrs_json="{}"
    if [ $# -gt 0 ]; then
      attrs_json="{"
      local first=true
      for kv in "$@"; do
        local key="${kv%%=*}"
        local val="${kv#*=}"
        if [ "$first" = true ]; then
          first=false
        else
          attrs_json+=","
        fi
        attrs_json+="\"$key\":\"$val\""
      done
      attrs_json+="}"
    fi

    local tmp_file
    tmp_file=$(mktemp)
    python3 -c "
import json
with open('$span_file') as f:
    data = json.load(f)
data['events'].append({
    'name': '$event_name',
    'timestamp_ns': '$timestamp',
    'attributes': $attrs_json
})
with open('$tmp_file', 'w') as f:
    json.dump(data, f)
" 2>/dev/null && mv "$tmp_file" "$span_file"
  fi
}

# Mark a span as error.
# Usage: apex_trace_set_error "span_id" "error message"
apex_trace_set_error() {
  local span_id="$1"
  local error_msg="$2"
  local span_file="${_APEX_TRACE_SPAN_DIR}/${span_id}.json"

  if [ -f "$span_file" ] && command -v python3 &>/dev/null; then
    local tmp_file
    tmp_file=$(mktemp)
    python3 -c "
import json
with open('$span_file') as f:
    data = json.load(f)
data['status'] = 'ERROR'
data['attributes']['error'] = True
data['attributes']['error.message'] = '$error_msg'
with open('$tmp_file', 'w') as f:
    json.dump(data, f)
" 2>/dev/null && mv "$tmp_file" "$span_file"
  fi
}

# End a span and export it.
# Usage: apex_trace_end_span "span_id"
apex_trace_end_span() {
  local span_id="$1"
  local span_file="${_APEX_TRACE_SPAN_DIR}/${span_id}.json"
  local end_time
  end_time=$(_apex_timestamp_ns)

  if [ ! -f "$span_file" ]; then
    return 1
  fi

  if command -v python3 &>/dev/null; then
    local otlp_json
    otlp_json=$(python3 -c "
import json
with open('$span_file') as f:
    data = json.load(f)
data['end_time_ns'] = '$end_time'

# Convert to OTLP format
otlp = {
    'resourceSpans': [{
        'resource': {
            'attributes': [
                {'key': 'service.name', 'value': {'stringValue': data['service_name']}},
                {'key': 'service.version', 'value': {'stringValue': data['service_version']}},
                {'key': 'deployment.environment', 'value': {'stringValue': data['environment']}},
                {'key': 'apex.component', 'value': {'stringValue': data['service_name']}}
            ]
        },
        'scopeSpans': [{
            'scope': {'name': 'apex-trace-shell', 'version': '1.0.0'},
            'spans': [{
                'traceId': data['trace_id'],
                'spanId': data['span_id'],
                'parentSpanId': data.get('parent_span_id', ''),
                'name': data['name'],
                'kind': 1,
                'startTimeUnixNano': str(data['start_time_ns']),
                'endTimeUnixNano': str(data['end_time_ns']),
                'attributes': [
                    {'key': k, 'value': {'stringValue': str(v)}}
                    for k, v in data.get('attributes', {}).items()
                ],
                'events': [
                    {
                        'name': e['name'],
                        'timeUnixNano': str(e['timestamp_ns']),
                        'attributes': [
                            {'key': k, 'value': {'stringValue': str(v)}}
                            for k, v in e.get('attributes', {}).items()
                        ]
                    }
                    for e in data.get('events', [])
                ],
                'status': {
                    'code': 2 if data.get('status') == 'ERROR' else 1
                }
            }]
        }]
    }]
}
print(json.dumps(otlp))
" 2>/dev/null)

    if [ -n "$otlp_json" ]; then
      if [ "$APEX_TRACE_CONSOLE" = "true" ]; then
        echo "[apex-trace] Ended span: id=$span_id"
        echo "$otlp_json" | python3 -m json.tool 2>/dev/null
      fi

      # Export to OTLP endpoint
      if [ "$APEX_TRACE_ENABLED" = "true" ]; then
        curl -s -X POST \
          "${APEX_TRACE_OTLP_ENDPOINT}/v1/traces" \
          -H "Content-Type: application/json" \
          -d "$otlp_json" \
          --connect-timeout 2 \
          --max-time 5 \
          >/dev/null 2>&1 &
      fi
    fi
  fi

  rm -f "$span_file"
}

# Get the current traceparent header value.
# Usage: traceparent=$(apex_trace_get_traceparent)
apex_trace_get_traceparent() {
  echo "${TRACEPARENT:-}"
}

# Get the current trace ID.
apex_trace_get_trace_id() {
  echo "${_APEX_TRACE_ID:-}"
}

# Convenience: Trace a command execution.
# Usage: apex_trace_exec "span_name" command arg1 arg2 ...
apex_trace_exec() {
  local span_name="$1"
  shift

  local span_id
  span_id=$(apex_trace_start_span "$span_name")
  apex_trace_set_attribute "$span_id" "shell.command" "$*"

  local exit_code=0
  "$@" || exit_code=$?

  if [ "$exit_code" -ne 0 ]; then
    apex_trace_set_error "$span_id" "Command failed with exit code $exit_code"
  fi
  apex_trace_set_attribute "$span_id" "shell.exit_code" "$exit_code"
  apex_trace_end_span "$span_id"

  return "$exit_code"
}

# Shutdown: export any remaining spans and clean up.
apex_trace_shutdown() {
  if [ -d "$_APEX_TRACE_SPAN_DIR" ]; then
    # End any remaining spans
    for span_file in "${_APEX_TRACE_SPAN_DIR}"/*.json; do
      [ -f "$span_file" ] || continue
      local span_id
      span_id=$(basename "$span_file" .json)
      apex_trace_end_span "$span_id"
    done
    rm -rf "$_APEX_TRACE_SPAN_DIR"
  fi

  # Wait for any background curl processes
  wait 2>/dev/null

  if [ "$APEX_TRACE_CONSOLE" = "true" ]; then
    echo "[apex-trace] Shutdown complete"
  fi
}

# Set up trap for cleanup on exit
trap apex_trace_shutdown EXIT
