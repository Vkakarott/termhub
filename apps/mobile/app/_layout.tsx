import 'react-native-get-random-values';
import '../global.css';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useSchemeName } from '@/ui/theme-provider';

/**
 * Route groups follow the flow of spec §11.2: enrolment (Início → Aguardando aprovação → Criar PIN),
 * Desbloquear, then the tabs. Which group is shown is decided by the session state once the app
 * plan lands; today every route is reachable so each screen can be built and tested alone.
 */
function Navigator() {
  const scheme = useSchemeName();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <Navigator />
    </ThemeProvider>
  );
}
