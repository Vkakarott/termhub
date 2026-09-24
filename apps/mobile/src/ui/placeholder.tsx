import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Screen } from './screen';
import { AppText } from './text';

type Props = { title: string; hint: string; children?: ReactNode };

/**
 * Stand-in for a screen the app plan has not implemented yet: the pt-BR title the final screen will
 * have and a one-line hint of what it will do. Replaced screen by screen.
 */
export function Placeholder({ title, hint, children }: Props) {
  return (
    <Screen>
      <View className="flex-1 justify-center gap-3">
        <AppText variant="title">{title}</AppText>
        <AppText variant="muted">{hint}</AppText>
        {children}
      </View>
    </Screen>
  );
}
