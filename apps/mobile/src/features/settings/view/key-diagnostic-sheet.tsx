import { ScrollView, View } from 'react-native';
import { AppText, Sheet } from '@/ui';
import type { KeyDiagnosticResult } from '../model/key-diagnostic';

/** Shows `runKeyDiagnostic`'s result, step by step (P§11.1's on-device check). `result === null`
 * means it is still running. */
export function KeyDiagnosticSheet({ open, onClose, result }: { open: boolean; onClose(): void; result: KeyDiagnosticResult | null }) {
  return (
    <Sheet open={open} onClose={onClose} title="Diagnóstico da chave">
      {result === null ? (
        <AppText variant="muted">Testando…</AppText>
      ) : (
        <ScrollView className="max-h-96">
          <View className="gap-3">
            <AppText className={result.ok ? 'text-app-ok' : 'text-app-danger'}>{result.ok ? 'A chave do aparelho está funcionando.' : 'Algo falhou no teste da chave.'}</AppText>
            {result.steps.map((step) => (
              <View key={step.name} className="gap-0.5">
                <AppText className={step.ok ? 'text-app-ok' : 'text-app-danger'}>
                  {step.name}: {step.ok ? 'ok' : 'falhou'}
                </AppText>
                {step.detail ? <AppText variant="muted">{step.detail}</AppText> : null}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </Sheet>
  );
}
