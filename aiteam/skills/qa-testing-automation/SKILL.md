---
name: qa-testing-automation
description: Quality assurance and automated testing strategies for cross-platform apps. Focuses on robust interaction testing and performance metrics.
---

# QA & Automated Testing (The Brain App)

This skill outlines the testing methodology to ensure The Brain App is stable and reliable, specifically handling the chaotic interaction patterns of children.

## Testing Layers
- **Unit Testing**: Use `Jest` for business logic, data parsing, and state management.
- **Component Testing**: Use `React Native Testing Library` (RNTL) for screen-level interaction verification.
- **End-to-End (E2E)**: Use `Detox` (or `Maestro`) for real-device/simulator flows.

## Special "Child-Proofing" Tests
- **Rapid-Fire Interactions**: Simulate multiple concurrent taps on buttons to ensure no state race conditions or double-submissions.
- **Navigation Stress**: Test rapid "back-and-forth" navigation between modules.
- **Offline States**: Verify gracefully handled "Network Interrupted" alerts during interactive lessons.

## Sample Test Pattern (Jest + RNTL)
```typescript
import { render, fireEvent } from '@testing-library/react-native';

test('prevents double-tap issues on reward claim', () => {
  const onClaim = jest.fn();
  const { getByTestId } = render(<RewardScreen onClaim={onClaim} />);
  
  const button = getByTestId('claim-button');
  fireEvent.press(button);
  fireEvent.press(button); // Simulate double tap
  
  expect(onClaim).toHaveBeenCalledTimes(1);
});
```
