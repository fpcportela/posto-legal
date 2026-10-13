---
name: incident-response-playbooks
description: Blameless post-mortems, incident mitigation, and on-call runbooks.
---

# Skill: Incident Response Playbooks

## Principles
1. **Mitigation First:** In an active incident, the goal is to restore service (e.g., rollback, feature flag toggle) before finding the root cause.
2. **Blameless Culture:** Post-mortems must focus on system failures, lack of guardrails, or process gaps, never on human error.
3. **Runbooks:** Every critical alert must link to an actionable runbook detailing exactly what commands to run to assess the state.
