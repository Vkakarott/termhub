import { Placeholder } from '@/ui/placeholder';

/** Criar PIN (spec §4.5): six digits, typed twice, before the device is activated. */
export default function CreatePinScreen() {
  return <Placeholder title="Criar PIN" hint="Escolha um PIN de 6 dígitos. Ele desbloqueia o app e autoriza as ações do chat." />;
}
