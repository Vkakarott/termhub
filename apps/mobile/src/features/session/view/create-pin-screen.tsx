import { useState } from 'react';
import { View } from 'react-native';
import { AppText, Banner, PinDots, PinPad, Screen } from '@/ui';
import { useSessionStore } from '../viewmodel/useSessionStore';

const PIN_LENGTH = 6;

/** Criar PIN (P§4.5, design spec §5.3): six digits, typed twice; a mismatch restarts at step 1.
 * The store's own `createPin` re-checks equality (defence in depth) but this screen never lets a
 * mismatched pair reach it. */
export function CreatePinScreen() {
  const createPin = useSessionStore((s) => s.createPin);
  const storeError = useSessionStore((s) => s.error);
  const busy = useSessionStore((s) => s.busy);

  const [step, setStep] = useState<1 | 2>(1);
  const [firstPin, setFirstPin] = useState('');
  const [pin, setPin] = useState('');
  const [mismatch, setMismatch] = useState<string | null>(null);

  const onDigit = (digit: string) => {
    if (pin.length >= PIN_LENGTH) return;
    setMismatch(null);
    const next = pin + digit;
    setPin(next);
    if (next.length < PIN_LENGTH) return;

    if (step === 1) {
      setFirstPin(next);
      setPin('');
      setStep(2);
      return;
    }
    if (next !== firstPin) {
      setMismatch('Os PINs não são iguais');
      setFirstPin('');
      setPin('');
      setStep(1);
      return;
    }
    void createPin(firstPin, next);
  };

  const onBackspace = () => setPin((p) => p.slice(0, -1));

  return (
    <Screen>
      <View className="flex-1 justify-center gap-6">
        <AppText variant="title">Criar PIN</AppText>
        <AppText variant="muted">{step === 1 ? 'Crie um PIN de 6 dígitos' : 'Repita o PIN'}</AppText>
        {mismatch ? <Banner tone="danger" text={mismatch} /> : null}
        {storeError ? <Banner tone="danger" text={storeError} /> : null}
        <PinDots filled={pin.length} />
        <PinPad onDigit={onDigit} onBackspace={onBackspace} disabled={busy} />
      </View>
    </Screen>
  );
}
