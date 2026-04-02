# =============================================================================
# apex-trace PowerShell Tracing Library
# =============================================================================
# Distributed tracing for PowerShell scripts in the Apex ecosystem.
# Generates W3C Trace Context compatible trace/span IDs and exports spans
# to an OTLP HTTP endpoint as JSON.
#
# Usage:
#   . /path/to/trace.ps1
#   Initialize-ApexTrace -ServiceName "apex-neural" -ServiceVersion "1.0.0"
#   $spanId = Start-ApexSpan -Name "hook.session_start"
#   # ... do work ...
#   Stop-ApexSpan -SpanId $spanId
#   Stop-ApexTrace
# =============================================================================

# Configuration
$script:ApexTraceConfig = @{
    ServiceName    = if ($env:APEX_TRACE_SERVICE_NAME) { $env:APEX_TRACE_SERVICE_NAME } else { "apex-neural" }
    ServiceVersion = if ($env:APEX_TRACE_SERVICE_VERSION) { $env:APEX_TRACE_SERVICE_VERSION } else { "1.0.0" }
    Environment    = if ($env:APEX_TRACE_ENVIRONMENT) { $env:APEX_TRACE_ENVIRONMENT } else { "development" }
    OTLPEndpoint   = if ($env:OTEL_EXPORTER_OTLP_ENDPOINT) { $env:OTEL_EXPORTER_OTLP_ENDPOINT } else { "http://localhost:4318" }
    Enabled        = if ($env:APEX_TRACE_ENABLED) { $env:APEX_TRACE_ENABLED -eq "true" } else { $true }
    ConsoleLog     = if ($env:APEX_TRACE_CONSOLE) { $env:APEX_TRACE_CONSOLE -eq "true" } else { $false }
}

# Internal state
$script:ApexTraceId = ""
$script:ApexParentSpanId = ""
$script:ApexSpans = @{}

function New-HexString {
    param([int]$Bytes = 16)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buffer = New-Object byte[] $Bytes
    $rng.GetBytes($buffer)
    return ($buffer | ForEach-Object { $_.ToString("x2") }) -join ''
}

function Get-TimestampNs {
    $ticks = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    return [string]($ticks * 1000000)
}

function Initialize-ApexTrace {
    param(
        [string]$ServiceName,
        [string]$ServiceVersion
    )

    if ($ServiceName) { $script:ApexTraceConfig.ServiceName = $ServiceName }
    if ($ServiceVersion) { $script:ApexTraceConfig.ServiceVersion = $ServiceVersion }

    # Inherit or generate trace ID
    if ($env:TRACEPARENT) {
        $parts = $env:TRACEPARENT -split '-'
        $script:ApexTraceId = $parts[1]
        $script:ApexParentSpanId = $parts[2]
    }
    else {
        $script:ApexTraceId = New-HexString -Bytes 16
        $script:ApexParentSpanId = ""
    }

    if ($script:ApexTraceConfig.ConsoleLog) {
        Write-Host "[apex-trace] Initialized: service=$($script:ApexTraceConfig.ServiceName) trace_id=$($script:ApexTraceId)" -ForegroundColor Cyan
    }
}

function Start-ApexSpan {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$ParentSpanId,
        [hashtable]$Attributes = @{}
    )

    $spanId = New-HexString -Bytes 8
    $startTime = Get-TimestampNs

    if (-not $ParentSpanId) { $ParentSpanId = $script:ApexParentSpanId }

    $span = @{
        span_id         = $spanId
        trace_id        = $script:ApexTraceId
        parent_span_id  = $ParentSpanId
        name            = $Name
        start_time_ns   = $startTime
        service_name    = $script:ApexTraceConfig.ServiceName
        service_version = $script:ApexTraceConfig.ServiceVersion
        environment     = $script:ApexTraceConfig.Environment
        attributes      = $Attributes
        events          = @()
        status          = "UNSET"
    }

    $script:ApexSpans[$spanId] = $span

    # Set traceparent for child processes
    $env:TRACEPARENT = "00-$($script:ApexTraceId)-$spanId-01"

    if ($script:ApexTraceConfig.ConsoleLog) {
        Write-Host "[apex-trace] Started span: name=$Name id=$spanId" -ForegroundColor Green
    }

    return $spanId
}

function Set-ApexSpanAttribute {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SpanId,
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    if ($script:ApexSpans.ContainsKey($SpanId)) {
        $script:ApexSpans[$SpanId].attributes[$Key] = $Value
    }
}

function Add-ApexSpanEvent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SpanId,
        [Parameter(Mandatory = $true)]
        [string]$EventName,
        [hashtable]$Attributes = @{}
    )

    if ($script:ApexSpans.ContainsKey($SpanId)) {
        $script:ApexSpans[$SpanId].events += @{
            name         = $EventName
            timestamp_ns = (Get-TimestampNs)
            attributes   = $Attributes
        }
    }
}

function Set-ApexSpanError {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SpanId,
        [Parameter(Mandatory = $true)]
        [string]$ErrorMessage
    )

    if ($script:ApexSpans.ContainsKey($SpanId)) {
        $script:ApexSpans[$SpanId].status = "ERROR"
        $script:ApexSpans[$SpanId].attributes["error"] = "true"
        $script:ApexSpans[$SpanId].attributes["error.message"] = $ErrorMessage
    }
}

function Stop-ApexSpan {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SpanId
    )

    if (-not $script:ApexSpans.ContainsKey($SpanId)) {
        Write-Warning "[apex-trace] Span not found: $SpanId"
        return
    }

    $span = $script:ApexSpans[$SpanId]
    $endTime = Get-TimestampNs

    # Build OTLP JSON
    $otlpAttributes = @()
    foreach ($key in $span.attributes.Keys) {
        $otlpAttributes += @{
            key   = $key
            value = @{ stringValue = [string]$span.attributes[$key] }
        }
    }

    $otlpEvents = @()
    foreach ($event in $span.events) {
        $eventAttrs = @()
        foreach ($key in $event.attributes.Keys) {
            $eventAttrs += @{
                key   = $key
                value = @{ stringValue = [string]$event.attributes[$key] }
            }
        }
        $otlpEvents += @{
            name             = $event.name
            timeUnixNano     = $event.timestamp_ns
            attributes       = $eventAttrs
        }
    }

    $statusCode = if ($span.status -eq "ERROR") { 2 } else { 1 }

    $otlp = @{
        resourceSpans = @(
            @{
                resource   = @{
                    attributes = @(
                        @{ key = "service.name"; value = @{ stringValue = $span.service_name } }
                        @{ key = "service.version"; value = @{ stringValue = $span.service_version } }
                        @{ key = "deployment.environment"; value = @{ stringValue = $span.environment } }
                        @{ key = "apex.component"; value = @{ stringValue = $span.service_name } }
                    )
                }
                scopeSpans = @(
                    @{
                        scope = @{ name = "apex-trace-powershell"; version = "1.0.0" }
                        spans = @(
                            @{
                                traceId            = $span.trace_id
                                spanId             = $span.span_id
                                parentSpanId       = $span.parent_span_id
                                name               = $span.name
                                kind               = 1
                                startTimeUnixNano  = $span.start_time_ns
                                endTimeUnixNano    = $endTime
                                attributes         = $otlpAttributes
                                events             = $otlpEvents
                                status             = @{ code = $statusCode }
                            }
                        )
                    }
                )
            }
        )
    }

    $json = $otlp | ConvertTo-Json -Depth 10 -Compress

    if ($script:ApexTraceConfig.ConsoleLog) {
        Write-Host "[apex-trace] Ended span: id=$SpanId" -ForegroundColor Yellow
        $otlp | ConvertTo-Json -Depth 10 | Write-Host -ForegroundColor DarkGray
    }

    # Export to OTLP endpoint
    if ($script:ApexTraceConfig.Enabled) {
        try {
            $null = Invoke-RestMethod `
                -Uri "$($script:ApexTraceConfig.OTLPEndpoint)/v1/traces" `
                -Method Post `
                -ContentType "application/json" `
                -Body $json `
                -TimeoutSec 5 `
                -ErrorAction SilentlyContinue
        }
        catch {
            # Silently ignore export failures
        }
    }

    $script:ApexSpans.Remove($SpanId)
}

function Get-ApexTraceparent {
    return $env:TRACEPARENT
}

function Get-ApexTraceId {
    return $script:ApexTraceId
}

# Convenience: Trace a script block execution.
function Invoke-ApexTraced {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [scriptblock]$ScriptBlock,
        [hashtable]$Attributes = @{}
    )

    $spanId = Start-ApexSpan -Name $Name -Attributes $Attributes
    try {
        $result = & $ScriptBlock
        Stop-ApexSpan -SpanId $spanId
        return $result
    }
    catch {
        Set-ApexSpanError -SpanId $spanId -ErrorMessage $_.Exception.Message
        Stop-ApexSpan -SpanId $spanId
        throw
    }
}

function Stop-ApexTrace {
    # End any remaining spans
    $remainingSpans = @($script:ApexSpans.Keys)
    foreach ($spanId in $remainingSpans) {
        Stop-ApexSpan -SpanId $spanId
    }

    if ($script:ApexTraceConfig.ConsoleLog) {
        Write-Host "[apex-trace] Shutdown complete" -ForegroundColor Cyan
    }
}

# Export functions
Export-ModuleMember -Function @(
    'Initialize-ApexTrace',
    'Start-ApexSpan',
    'Set-ApexSpanAttribute',
    'Add-ApexSpanEvent',
    'Set-ApexSpanError',
    'Stop-ApexSpan',
    'Get-ApexTraceparent',
    'Get-ApexTraceId',
    'Invoke-ApexTraced',
    'Stop-ApexTrace'
) -ErrorAction SilentlyContinue
