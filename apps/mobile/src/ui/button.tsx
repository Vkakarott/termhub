import { ActivityIndicator, Pressable, Text } from 'react-native';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const box: Record<Variant, string> = {
  primary: 'bg-app-accent',
  secondary: 'bg-app-surface2 border border-app-border',
  danger: 'bg-app-danger',
  ghost: '',
};
const text: Record<Variant, string> = {
  primary: 'text-white',
  secondary: 'text-app-text',
  danger: 'text-white',
  ghost: 'text-app-accent',
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  testID,
}: {
  label: string;
  onPress(): void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: loading }}
      disabled={off}
      onPress={onPress}
      testID={testID}
      className={`rounded-xl px-4 py-3.5 items-center justify-center ${box[variant]} ${off ? 'opacity-60' : ''}`}
    >
      {loading ? (
        <ActivityIndicator testID="button-spinner" color="#fff" />
      ) : (
        <Text className={`text-base font-semibold ${text[variant]}`}>{label}</Text>
      )}
    </Pressable>
  );
}
