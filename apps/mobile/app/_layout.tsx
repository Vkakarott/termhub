import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

/**
 * Route groups follow the flow of spec §11.2: enrolment (Início → Aguardando aprovação → Criar PIN),
 * Desbloquear, then the tabs. Which group is shown is decided by the session state once the app
 * plan lands; today every route is reachable so each screen can be built and tested alone.
 */
export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0B0F19' } }} />
    </>
  );
}
