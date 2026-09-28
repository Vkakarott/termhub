import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MAX_READABLE_WIDTH, readableColumn } from './layout';

type Props = { children: ReactNode; scroll?: boolean; padded?: boolean; width?: 'readable' | 'full' };

/** A readable column (spec 2026-09-28 iPad §2.4): on a wide window the content is centred at
 * `MAX_READABLE_WIDTH`; `width="full"` is for screens that lay out their own widths (Chats' split,
 * the conversation). On a phone both are the same. */
const READABLE = readableColumn(MAX_READABLE_WIDTH);

export function Screen({ children, scroll = false, padded = true, width = 'readable' }: Props) {
  const paddingClassName = padded ? 'px-6 py-4' : '';
  // `{}` rather than `undefined`: RN's `StyleSheet.flatten` returns `undefined` unchanged, and a
  // `style` prop of `undefined` reads as "no style" everywhere that inspects it.
  const columnStyle = width === 'readable' ? READABLE : {};
  return (
    <SafeAreaView className="flex-1 bg-app-bg">
      {scroll ? (
        <ScrollView className="flex-1">
          <View testID="screen-column" style={columnStyle} className={paddingClassName}>
            {children}
          </View>
        </ScrollView>
      ) : (
        <View testID="screen-column" style={columnStyle} className={`flex-1 ${paddingClassName}`}>
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}
