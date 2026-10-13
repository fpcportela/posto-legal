---
name: pedagogy-gamification-kids
description: Guidelines for educational design and child-friendly gamification. Focuses on positive reinforcement, age-appropriate cognitive load, and engaging feedback.
---

# Pedagogy & Gamification for Kids (The Brain App)

This skill provides instructions on how to design features that are educational, engaging, and healthy for children's cognitive development.

## Educational Principles
- **Scaffolding**: Provide hints that gradually increase in detail rather than just giving the answer.
- **Immediate Feedback**: Use visual and auditory cues (gentle sounds, sparkles, animations) specifically for success and "try again" states.
- **Active Exploration**: Favor "drag and drop" or "tap to discover" over passive content consumption.

## Gamification (The Healthy Way)
- **Positive Reinforcement**: Celebrate effort and persistence, not just correctness.
- **Non-Competitive Progress**: Use "badges" or "unlocked items" rather than public leaderboards to maintain a stress-free environment.
- **Streaks & Session Limits**: Encourage daily consistency but implement "cool down" periods to avoid excessive screen time.

## Design Patterns
- **Large Interaction Areas**: Design buttons and touch zones for developing motor skills.
- **Icon-First Navigation**: Children under 6 may not read yet; use clear, intuitive symbols.
- **Narration**: Provide audio support for text instructions to improve accessibility.

```typescript
// Pattern: Progressive Hinting
const getHint = (attemptCount: number, context: string) => {
  if (attemptCount === 1) return "Look at the colors!";
  if (attemptCount === 2) return "The circle is blue, just like the sky.";
  return "Drag the blue object to the center.";
}
```
