import * as ATT from 'expo-tracking-transparency';
import { requestTracking, trackingStatus } from './tracking';

const att = ATT as unknown as Record<string, jest.Mock>;
beforeEach(() => jest.clearAllMocks());

it('maps the OS answer: granted is authorized', async () => {
  att.getTrackingPermissionsAsync!.mockResolvedValueOnce({ status: 'denied' });
  expect(await trackingStatus()).toBe('denied');
  expect(await requestTracking()).toBe('authorized');
  att.getTrackingPermissionsAsync!.mockResolvedValueOnce({ status: 'undetermined' });
  expect(await trackingStatus()).toBe('undetermined');
});

it('is unavailable where ATT does not exist (Android), and never prompts there', async () => {
  att.isAvailable!.mockReturnValue(false);
  expect(await trackingStatus()).toBe('unavailable');
  expect(await requestTracking()).toBe('unavailable');
  expect(att.requestTrackingPermissionsAsync).not.toHaveBeenCalled();
  att.isAvailable!.mockReturnValue(true);
});
