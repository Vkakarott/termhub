import { Text, TextInput, View, type TextInputProps } from 'react-native';
import { AppText } from './text';

type Props = {
  label: string;
  value: string;
  onChangeText(text: string): void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  autoCapitalize?: TextInputProps['autoCapitalize'];
  secureTextEntry?: boolean;
  error?: string;
  testID?: string;
};

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  secureTextEntry,
  error,
  testID,
}: Props) {
  return (
    <View className="gap-1.5">
      <AppText variant="label">{label}</AppText>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#5B6275"
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
        testID={testID}
        className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text"
      />
      {error ? <Text className="text-sm text-app-danger">{error}</Text> : null}
    </View>
  );
}
