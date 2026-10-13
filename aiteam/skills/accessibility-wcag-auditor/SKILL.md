---
name: accessibility-wcag-auditor
description: Screen readers (ARIA), color contrast, keyboard navigation (WCAG).
---

# Skill: Accessibility (a11y) & WCAG Auditor

## Principles
1. **Semantic HTML:** Always prefer native semantic elements (`<button>`, `<nav>`, `<main>`) over `div` with click handlers.
2. **Keyboard Navigation:** Every interactive element must be reachable and operable via the `Tab` and `Enter`/`Space` keys. Ensure focus rings are clearly visible.
3. **Contrast:** Text must have a contrast ratio of at least 4.5:1 against its background (WCAG AA).
4. **ARIA:** Use ARIA attributes only when native semantics fall short. Ensure dynamic content changes are announced via `aria-live`.
