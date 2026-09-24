import { colorScheme, vars } from 'nativewind';
import { useEffect, useMemo, type ReactNode } from 'react';
import { View, useColorScheme } from 'react-native';
import { useThemeStore } from '@/features/theme/viewmodel/useThemeStore';
import { cssVars, type SchemeName } from '@/theme/tokens';

export function useSchemeName(): SchemeName {
  const pref = useThemeStore((s) => s.theme);
  const system = useColorScheme();
  return pref === 'system' ? (system === 'light' ? 'light' : 'dark') : pref;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useSchemeName();
  const style = useMemo(() => vars(cssVars(scheme)), [scheme]);
  useEffect(() => {
    colorScheme.set(scheme);
  }, [scheme]);
  return (
    <View style={style} className="flex-1 bg-app-bg">
      {children}
    </View>
  );
}
