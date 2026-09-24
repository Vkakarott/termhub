import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Placeholder } from '@/ui/placeholder';

/** Início (spec §11.2): "Continuar com e-mail" starts the enrolment of this device. */
export default function StartScreen() {
  return (
    <Placeholder title="termhub" hint="O chat do termhub no seu celular. Entre com o e-mail da sua conta para pedir acesso a este aparelho.">
      <Link href="/enrol/waiting" asChild>
        <Pressable style={styles.button}>
          <Text style={styles.buttonText}>Continuar com e-mail</Text>
        </Pressable>
      </Link>
    </Placeholder>
  );
}

const styles = StyleSheet.create({
  button: { marginTop: 12, backgroundColor: '#5B63D3', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
