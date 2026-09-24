import { Pressable, Text, View } from 'react-native';

type Props = {
  onDigit(digit: string): void;
  onBackspace(): void;
  onBiometrics?(): void;
  disabled?: boolean;
};

const DIGIT_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];

function Key({
  visibleLabel,
  accessibilityLabel,
  onPress,
  disabled,
}: {
  visibleLabel: string;
  accessibilityLabel: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      className={`h-16 w-16 items-center justify-center rounded-full bg-app-surface2 ${disabled ? 'opacity-60' : ''}`}
    >
      <Text className="text-2xl font-semibold text-app-text">{visibleLabel}</Text>
    </Pressable>
  );
}

export function PinPad({ onDigit, onBackspace, onBiometrics, disabled = false }: Props) {
  return (
    <View className="gap-4">
      {DIGIT_ROWS.map((row) => (
        <View key={row.join('')} className="flex-row justify-between">
          {row.map((digit) => (
            <Key key={digit} visibleLabel={digit} accessibilityLabel={digit} onPress={() => onDigit(digit)} disabled={disabled} />
          ))}
        </View>
      ))}
      <View className="flex-row justify-between">
        {onBiometrics ? (
          <Key visibleLabel="Bio" accessibilityLabel="Biometria" onPress={onBiometrics} disabled={disabled} />
        ) : (
          <View className="h-16 w-16" />
        )}
        <Key visibleLabel="0" accessibilityLabel="0" onPress={() => onDigit('0')} disabled={disabled} />
        <Key visibleLabel="⌫" accessibilityLabel="Apagar" onPress={onBackspace} disabled={disabled} />
      </View>
    </View>
  );
}
