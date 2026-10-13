---
name: security-privacy-child-safety
description: Expert guidance on building apps for children, focusing on COPPA/GDPR-K/LGPD compliance, data minimization, and secure parental controls.
---

# Security & Privacy for Children (The Brain App)

This skill ensures that all development activities prioritize the safety and privacy of minors, adhering to global standards.

## Core Principles
- **Data Minimization**: Never collect more data than strictly necessary for the app to function.
- **COPPA/LGPD-K Compliance**: Ensure no personal information (PII) is collected from children under 13 without verifiable parental consent (VPC).
- **Safe Authentication**: Use "Parental Gates" for outside links, purchases, or account settings.

## Developer Context
When working on code involving data storage or network requests:
1. Identify if the data belongs to a child.
2. Ensure PII (email, full name, precise location) is never stored for child users.
3. Verify that third-party SDKs used are compliant with child-safety regulations (no tracking for ads).

## Parental Gate Pattern (React Native)
Always implement a simple arithmetic or logic challenge before allowing access to adult-oriented features or external links.

```typescript
const isParentValidated = (answer: string) => {
  // Simple check: "What is 12 + 7?"
  return answer === "19";
}
```
