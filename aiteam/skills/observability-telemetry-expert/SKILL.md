---
name: observability-telemetry-expert
description: OpenTelemetry, distributed tracing, structured logging, and metrics.
---

# Skill: Observability & Telemetry Expert

## Principles
1. **Three Pillars:** Ensure full coverage of Metrics, Logs, and Traces (OpenTelemetry preferred).
2. **Structured Logging:** Logs must always be emitted in structured JSON format to allow easy querying in Datadog/ELK. No raw text dumps.
3. **Context Propagation:** Ensure Trace IDs span across microservice boundaries via HTTP headers.
4. **Actionable Alerts:** Alerts should only fire on symptom-based metrics (e.g., High Error Rate, High Latency) rather than cause-based metrics (e.g., CPU Spikes).
