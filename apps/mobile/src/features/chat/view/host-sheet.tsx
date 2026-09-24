import { useEffect } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { AppText, Sheet } from '@/ui';
import { useChatStore } from '../viewmodel/useChatStore';

function Choice({ label, machine, onPress }: { label: string; machine: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} (${machine})`} onPress={onPress} className="rounded-xl bg-app-surface2 px-4 py-3">
      <AppText>{label}</AppText>
    </Pressable>
  );
}

/** The account-wide chat's host picker: each machine, then its Claude accounts and the machine's
 * default login. */
export function HostSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const hostOptions = useChatStore((s) => s.hostOptions);
  const loadHostOptions = useChatStore((s) => s.loadHostOptions);
  const setHost = useChatStore((s) => s.setHost);

  useEffect(() => {
    if (open) void loadHostOptions();
  }, [open, loadHostOptions]);

  const choose = (machineId: string, accountId?: string) => {
    onClose();
    void setHost(machineId, accountId);
  };

  return (
    <Sheet open={open} onClose={onClose} title="Onde o chat roda">
      {hostOptions === null ? (
        <ActivityIndicator />
      ) : (
        <ScrollView className="max-h-96">
          <View className="gap-5">
            {hostOptions.machines.map((machine) => (
              <View key={machine.id} className="gap-2">
                <View className="flex-row items-center gap-2">
                  <AppText className="font-semibold">{machine.name}</AppText>
                  {machine.online ? null : <Text className="text-xs text-app-danger">offline</Text>}
                  {machine.agent_version ? <AppText variant="muted">agente {machine.agent_version}</AppText> : null}
                </View>
                {machine.accounts.map((account) => (
                  <Choice key={account.id} label={account.label} machine={machine.name} onPress={() => choose(machine.id, account.id)} />
                ))}
                <Choice label="conta padrão da máquina" machine={machine.name} onPress={() => choose(machine.id)} />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </Sheet>
  );
}
