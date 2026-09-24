// Barrel for the mock transport (design spec §4.2). `services/api/index.ts` (the app-wide
// singleton) is the only consumer outside this module's own tests.
export { createMockTransport, type CreateMockTransportOptions } from './transport';
export type { MockControls } from './controls';
export { WireError } from './state';
