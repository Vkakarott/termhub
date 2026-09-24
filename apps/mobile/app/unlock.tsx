import { Placeholder } from '@/ui/placeholder';

/** Desbloquear (spec §5.6): numeric pad and the biometric shortcut, on cold start and after 5 min. */
export default function UnlockScreen() {
  return <Placeholder title="Desbloquear" hint="Digite seu PIN ou use a biometria para abrir o chat." />;
}
