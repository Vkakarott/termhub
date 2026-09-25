// Stand-in for `expo-local-authentication` under jest: hardware present, enrolled, and the OS
// prompt always succeeds, so tests exercise the app's logic rather than a native prompt.
module.exports = {
  hasHardwareAsync: async () => true,
  isEnrolledAsync: async () => true,
  authenticateAsync: async () => ({ success: true }),
};
