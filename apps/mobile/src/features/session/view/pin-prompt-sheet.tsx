import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { AppText, Button, PinDots, PinPad, Sheet } from '@/ui';
import { useSessionStore } from '../viewmodel/useSessionStore';

const PIN_LENGTH = 6;

/** Approving a pending action always asks for the PIN, even while unlocked (P§5.6, design spec
 * §5.5). Mounted once, globally, by `app/_layout.tsx`; `pinPrompt` opens it, `resolvePinPrompt`
 * and `cancelPinPrompt` close it. */
export function PinPromptSheet() {
  const pinPrompt = useSessionStore((s) => s.pinPrompt);
  const error = useSessionStore((s) => s.error);
  const biometricsEnabled = useSessionStore((s) => s.biometricsEnabled);
  const resolvePinPrompt = useSessionStore((s) => s.resolvePinPrompt);
  const cancelPinPrompt = useSessionStore((s) => s.cancelPinPrompt);

  const [pin, setPin] = useState('');

  // A fresh prompt (new action id, or none at all) starts from an empty pad.
  useEffect(() => {
    setPin('');
  }, [pinPrompt?.actionId]);

  const onDigit = (digit: string) => {
    if (pin.length >= PIN_LENGTH) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === PIN_LENGTH) void resolvePinPrompt(next);
  };

  const onBackspace = () => setPin((p) => p.slice(0, -1));

  return (
    <Sheet open={pinPrompt !== null} onClose={cancelPinPrompt} title="Autorizar esta ação">
      <View className="gap-6">
        <PinDots filled={pin.length} error={Boolean(error)} />
        {error ? <AppText className="text-app-danger">{error}</AppText> : null}
        <PinPad
          onDigit={onDigit}
          onBackspace={onBackspace}
          onBiometrics={biometricsEnabled ? () => void resolvePinPrompt('biometrics') : undefined}
        />
        <Button label="Cancelar" variant="ghost" onPress={cancelPinPrompt} />
      </View>
    </Sheet>
  );
}
