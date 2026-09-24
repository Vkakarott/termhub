import { View } from 'react-native';
import { AppText } from './text';

type Tone = 'info' | 'danger';

const toneClassName: Record<Tone, { box: string; text: string }> = {
  info: { box: 'border border-app-accent bg-app-accent-soft', text: 'text-app-text' },
  danger: { box: 'border border-app-danger bg-app-surface2', text: 'text-app-danger' },
};

export function Banner({ tone, text }: { tone: Tone; text: string }) {
  const cls = toneClassName[tone];
  return (
    <View className={`rounded-xl px-4 py-3 ${cls.box}`}>
      <AppText className={cls.text}>{text}</AppText>
    </View>
  );
}
