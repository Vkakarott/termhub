import { View } from 'react-native';
import { AppText } from './text';

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-6">
      <AppText variant="title">{title}</AppText>
      <AppText variant="muted">{hint}</AppText>
    </View>
  );
}
