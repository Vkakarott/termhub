import { Text, type TextProps } from 'react-native';

const variants = {
  title: 'text-2xl font-semibold text-app-text',
  body: 'text-base text-app-text',
  muted: 'text-sm text-app-muted',
  code: 'text-4xl font-semibold tracking-widest text-app-text',
  label: 'text-xs uppercase tracking-wide text-app-muted',
} as const;

export function AppText({
  variant = 'body',
  className = '',
  ...rest
}: TextProps & { variant?: keyof typeof variants; className?: string }) {
  return <Text className={`${variants[variant]} ${className}`} {...rest} />;
}
