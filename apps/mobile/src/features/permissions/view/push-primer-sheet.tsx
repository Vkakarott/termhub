import { View } from 'react-native';
import { AppText, Button, Sheet } from '@/ui';
import { PERMISSIONS_MSG as MSG } from '../model/messages';
import { usePermissionsStore } from '../viewmodel/usePermissionsStore';

/** The notification primer (permission prompts spec §3.4): says what the termhub notifies before
 * the one-time OS prompt. Mounted once, globally, by `app/_layout.tsx`; `pushPrimerOpen` opens it. */
export function PushPrimerSheet() {
  const open = usePermissionsStore((s) => s.pushPrimerOpen);
  const acceptPush = usePermissionsStore((s) => s.acceptPush);
  const dismissPush = usePermissionsStore((s) => s.dismissPush);
  return (
    <Sheet open={open} onClose={dismissPush} title={MSG.pushTitle}>
      <View className="gap-4">
        <AppText>{MSG.pushBody}</AppText>
        <Button label={MSG.pushAccept} onPress={() => void acceptPush()} />
        <Button label={MSG.later} variant="ghost" onPress={dismissPush} />
      </View>
    </Sheet>
  );
}
