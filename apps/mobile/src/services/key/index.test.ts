// Which DeviceKey the app builds at boot (design spec §3.1, §10): the diagnostic always runs on
// the hardware key outside Jest — whatever the API mode — on its own tag, so the only mode that
// runs without a server (mock) still exercises the Secure Enclave / Keystore.
function load(env: { NODE_ENV: 'development' | 'production' | 'test'; EXPO_PUBLIC_API_MODE?: string }) {
  const saved = { NODE_ENV: process.env.NODE_ENV, EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE };
  process.env.NODE_ENV = env.NODE_ENV;
  if (env.EXPO_PUBLIC_API_MODE === undefined) delete process.env.EXPO_PUBLIC_API_MODE;
  else process.env.EXPO_PUBLIC_API_MODE = env.EXPO_PUBLIC_API_MODE;
  try {
    let loaded!: { index: typeof import('./index'); hardware: typeof import('./hardware'); software: typeof import('./software') };
    jest.isolateModules(() => {
      loaded = { index: require('./index'), hardware: require('./hardware'), software: require('./software') };
    });
    return loaded;
  } finally {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.EXPO_PUBLIC_API_MODE === undefined) delete process.env.EXPO_PUBLIC_API_MODE;
    else process.env.EXPO_PUBLIC_API_MODE = saved.EXPO_PUBLIC_API_MODE;
  }
}

it('outside Jest, in mock mode, the diagnostic key is the hardware key while the device key stays software', () => {
  const { index, hardware, software } = load({ NODE_ENV: 'development', EXPO_PUBLIC_API_MODE: 'mock' });
  expect(index.diagnosticKey).toBeInstanceOf(hardware.HardwareDeviceKey);
  expect(index.deviceKey).toBeInstanceOf(software.SoftwareDeviceKey);
});

it('outside Jest, in http mode, both are hardware keys', () => {
  const { index, hardware } = load({ NODE_ENV: 'production', EXPO_PUBLIC_API_MODE: 'http' });
  expect(index.diagnosticKey).toBeInstanceOf(hardware.HardwareDeviceKey);
  expect(index.deviceKey).toBeInstanceOf(hardware.HardwareDeviceKey);
});

it('under Jest, both are software keys', () => {
  const { index, software } = load({ NODE_ENV: 'test', EXPO_PUBLIC_API_MODE: 'http' });
  expect(index.diagnosticKey).toBeInstanceOf(software.SoftwareDeviceKey);
  expect(index.deviceKey).toBeInstanceOf(software.SoftwareDeviceKey);
});
