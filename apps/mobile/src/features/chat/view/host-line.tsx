import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/ui';
import { hostLine, type HostLine as HostLineCopy } from '../model/copy';
import type { ChatHostState } from '../model/types';
import { HostSheet } from './host-sheet';

const TONE: Record<HostLineCopy['tone'], string> = {
  ok: 'text-app-ok',
  warn: 'text-app-danger',
  info: 'text-app-muted',
};

/** Where the conversation runs, or why it cannot; the account-wide chat can change it. */
export function HostLine({ host, canChange }: { host: ChatHostState; canChange: boolean }) {
  const [picking, setPicking] = useState(false);
  const line = hostLine(host);
  return (
    <View className="gap-1 border-b border-app-border px-4 py-2">
      <Text className={`text-sm ${TONE[line.tone]}`}>{line.text}</Text>
      {canChange ? (
        <>
          <Button label="Trocar máquina ou conta" variant="ghost" onPress={() => setPicking(true)} />
          <HostSheet open={picking} onClose={() => setPicking(false)} />
        </>
      ) : null}
    </View>
  );
}
