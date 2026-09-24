import { Placeholder } from '@/ui/placeholder';

/** Aguardando aprovação (spec §4.5): the verification code, large, until the web approves. */
export default function WaitingScreen() {
  return (
    <Placeholder
      title="Aguardando aprovação"
      hint="Abra o termhub na web para aprovar este aparelho. O código de verificação aparece aqui e na tela de aprovação."
    />
  );
}
