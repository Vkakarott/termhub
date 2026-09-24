import { View } from 'react-native';

type Props = { length?: number; filled: number; error?: boolean };

export function PinDots({ length = 6, filled, error = false }: Props) {
  return (
    <View className="flex-row justify-center gap-3">
      {Array.from({ length }).map((_, index) => (
        <View
          key={index}
          className={`h-3.5 w-3.5 rounded-full ${error ? 'bg-app-danger' : index < filled ? 'bg-app-accent' : 'bg-app-border'}`}
        />
      ))}
    </View>
  );
}
