import { View } from 'react-native';
import { AppText, Button } from '@/ui';
import { PERMISSIONS_MSG as MSG } from '../model/messages';
import { showAdCard } from '../viewmodel/createPermissionsStore';
import { usePermissionsStore } from '../viewmodel/usePermissionsStore';

/** The ad measurement consent (permission prompts spec §3.4), on Home until decided: "Permitir"
 * opens ATT on iOS; on Android it is our own yes. */
export function AdConsentCard() {
  const visible = usePermissionsStore(showAdCard);
  const acceptAds = usePermissionsStore((s) => s.acceptAds);
  const declineAds = usePermissionsStore((s) => s.declineAds);
  if (!visible) return null;
  return (
    <View className="gap-3 rounded-2xl border border-app-border bg-app-surface p-4">
      <AppText className="font-semibold">{MSG.adTitle}</AppText>
      <AppText variant="muted">{MSG.adBody}</AppText>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button label={MSG.later} variant="secondary" onPress={() => void declineAds()} />
        </View>
        <View className="flex-1">
          <Button label={MSG.adAccept} onPress={() => void acceptAds()} />
        </View>
      </View>
    </View>
  );
}
