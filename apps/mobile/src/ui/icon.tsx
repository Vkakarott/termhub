import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';
import { tokens } from '@/theme/tokens';
import { useSchemeName } from './theme-provider';

type IosSymbol = Extract<SymbolViewProps['name'], string>;
type AndroidSymbol = NonNullable<Exclude<SymbolViewProps['name'], string>['android']>;

/** An SF Symbol for iOS and its Material Symbol for Android, the pair `app/(tabs)/_layout.tsx` uses. */
export type IconName = { ios: IosSymbol; android: AndroidSymbol };

type Props = {
  name: IconName;
  size?: number;
  /** A theme token (`text`, `muted`, `accent`…), read for the current scheme. */
  tone?: string;
  /** A literal colour, for a surface that is not the theme's (the accent bubble, say); wins over `tone`. */
  color?: ColorValue;
};

/**
 * A native symbol tinted with the theme. Decorative: the button or row around it carries the
 * accessibility label, so the symbol itself stays out of the accessibility tree.
 */
export function Icon({ name, size = 20, tone = 'text', color }: Props) {
  const scheme = useSchemeName();
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color ?? tokens[scheme][tone]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
