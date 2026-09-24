import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Props = { title: string; hint: string; children?: React.ReactNode };

/**
 * Stand-in for a screen the app plan has not implemented yet: the pt-BR title the final screen will
 * have and a one-line hint of what it will do. Replaced screen by screen.
 */
export function Placeholder({ title, hint, children }: Props) {
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.hint}>{hint}</Text>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B0F19' },
  body: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { color: '#F3F4F6', fontSize: 24, fontWeight: '600' },
  hint: { color: '#9CA3AF', fontSize: 15, lineHeight: 22 },
});
