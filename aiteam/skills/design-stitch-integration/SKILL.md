---
name: design-stitch-integration
description: Guidelines for leveraging Google Stitch design patterns and managing the DESIGN.md foundation for consistent, AI-assisted layouts.
---

# Google Stitch Design Integration (The Brain App)

This skill describes how to maintain the UI/UX consistency of The Brain App using the **Google Stitch** methodology, bridging the gap between design ideation and code.

## Key Concepts
- **DESIGN.md**: The "single source of truth" for design tokens and structural layout rules.
- **AI-Native Layouts**: Use natural language prompts to describe UI changes instead of manually adjusting pixel values when possible.
- **Design Tokens**: Every visual decision (color, spacing, font) must be mapped to a token defined in `DESIGN.md`.

## Maintaining DESIGN.md
When adding a new feature:
1. Check `DESIGN.md` for existing components or tokens.
2. If new tokens are needed, define them in the `SPECIFICATIONS` section of `DESIGN.md`.
3. Use the following format for tokens:
   - `core.colors.primary`: Vibrant blue (#3498db)
   - `font.family.display`: 'Inter-Bold', rounded edges

## Stitch Prompting Pattern
When requested to create a new layout, follow this structure:
1. **Context**: Describe the screen (e.g., "Login screen for parents").
2. **References**: Mention tokens from `DESIGN.md`.
3. **Structure**: Define the hierarchy (Header, Content Area, Action Bar).
4. **Behavior**: (e.g., "Floating button for primary action").

```markdown
// Example DESIGN.md Snippet (Tokens)
## Tokens
- **Background**: Soft Pastel Lavender (#F3E5F5)
- **Primary-Button-Radius**: 24px (Pill shape)
- **Typography-Level-1**: 32pt, Heavy weighting
```
