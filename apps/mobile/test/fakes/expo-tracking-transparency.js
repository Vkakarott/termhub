// Stand-in for `expo-tracking-transparency` under jest: iOS with ATT available and not asked yet.
module.exports = {
  isAvailable: jest.fn(() => true),
  getTrackingPermissionsAsync: jest.fn(async () => ({ status: 'undetermined', granted: false, canAskAgain: true })),
  requestTrackingPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, canAskAgain: false })),
};
