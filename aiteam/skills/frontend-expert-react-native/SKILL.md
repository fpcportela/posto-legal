---
name: frontend-expert-react-native
description: Advanced React Native and Expo patterns for building cross-platform apps. Focuses on performance, layout consistency, and interactive animations.
---

# React Native & Expo Architecture (The Brain App)

This skill provides the technical standards for developing the mobile frontend of The Brain App using React Native and Expo.

## Technical Stack
- **Framework**: Expo (SDK 50+ recommended).
- **Language**: TypeScript (Strict mode).
- **Styling**: `StyleSheet` (Standard) or `Tamagui/Unistyles` for design system integration.
- **Animations**: `moti` or `react-native-reanimated` for fluid transitions.

## Key Performance Standards
- **Component Memoization**: Use `React.memo`, `useMemo`, and `useCallback` to prevent unnecessary re-renders in complex game screens.
- **Image Optimization**: Use `expo-image` for efficient caching and placeholder support.
- **Navigation**: Use `expo-router` for file-based routing and deep linking support.

## Cross-Platform Considerations
- **SafeAreaView**: Always wrap root screens to handle notches on iOS and status bars on Android.
- **Platform Select**: Use `Platform.OS` or `.android.tsx/.ios.tsx` extensions for platform-specific UI logic.

## Recommended Pattern: Responsive Components
```typescript
import { Dimensions } from 'react-native';

const { width } = Dimensions.get('window');
const isTablet = width > 768;

export const AppButton = ({ label }) => (
  <TouchableOpacity style={{
    padding: isTablet ? 24 : 16,
    borderRadius: 12,
  }}>
    <Text>{label}</Text>
  </TouchableOpacity>
);
```
