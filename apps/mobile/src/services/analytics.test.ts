import * as Analytics from '@react-native-firebase/analytics';
import { setAdConsent } from './analytics';

const analytics = Analytics as unknown as Record<string, jest.Mock>;
beforeEach(() => jest.clearAllMocks());

it('grants or denies the three ad signals together, and keeps analytics storage on', async () => {
  await setAdConsent(true);
  expect(analytics.setConsent).toHaveBeenLastCalledWith({}, { ad_storage: true, ad_user_data: true, ad_personalization: true, analytics_storage: true });
  await setAdConsent(false);
  expect(analytics.setConsent).toHaveBeenLastCalledWith({}, { ad_storage: false, ad_user_data: false, ad_personalization: false, analytics_storage: true });
});

it('never throws when the native module is missing', async () => {
  analytics.getAnalytics!.mockImplementationOnce(() => {
    throw new Error('native module missing');
  });
  await expect(setAdConsent(true)).resolves.toBeUndefined();
  analytics.setConsent!.mockRejectedValueOnce(new Error('boom'));
  await expect(setAdConsent(true)).resolves.toBeUndefined();
});
