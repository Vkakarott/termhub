import { useState } from 'react';
import { View } from 'react-native';
import { AppText, Countdown, PinDots, PinPad, Screen } from '@/ui';
import { useSessionStore } from '../viewmodel/useSessionStore';

const PIN_LENGTH = 6;

function attemptsSuffix(n: number): string {
  return n === 1 ? ' 1 tentativa restante.' : ` ${n} tentativas restantes.`;
}

/** Desbloquear (P§5.3–5.6, design spec §5.4): numeric pad, and the biometric shortcut when
 * enabled. "Sair e remover este aparelho" lives in Ajustes, not here. */
export function UnlockScreen() {
  const unlock = useSessionStore((s) => s.unlock);
  const unlockWithBiometrics = useSessionStore((s) => s.unlockWithBiometrics);
  const error = useSessionStore((s) => s.error);
  const attemptsLeft = useSessionStore((s) => s.attemptsLeft);
  const lockedUntil = useSessionStore((s) => s.lockedUntil);
  const biometricsEnabled = useSessionStore((s) => s.biometricsEnabled);
  const busy = useSessionStore((s) => s.busy);

  const [pin, setPin] = useState('');

  const onDigit = (digit: string) => {
    if (pin.length >= PIN_LENGTH) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === PIN_LENGTH) {
      setPin('');
      void unlock(next);
    }
  };

  const onBackspace = () => setPin((p) => p.slice(0, -1));
  const disabled = Boolean(lockedUntil) || busy;

  return (
    <Screen>
      <View className="flex-1 justify-center gap-6">
        <AppText variant="title">Desbloquear</AppText>
        <AppText variant="muted">Digite seu PIN</AppText>
        {lockedUntil ? (
          <View className="gap-2">
            <AppText className="text-app-danger">Aparelho bloqueado</AppText>
            <Countdown until={lockedUntil} />
          </View>
        ) : error ? (
          <AppText className="text-app-danger">
            {error}
            {attemptsLeft !== null ? attemptsSuffix(attemptsLeft) : ''}
          </AppText>
        ) : null}
        <PinDots filled={pin.length} error={Boolean(error) && !lockedUntil} />
        <PinPad
          onDigit={onDigit}
          onBackspace={onBackspace}
          onBiometrics={biometricsEnabled ? () => void unlockWithBiometrics() : undefined}
          disabled={disabled}
        />
      </View>
    </Screen>
  );
}
