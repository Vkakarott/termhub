// Barrel for the whole mobile-api contract: the seven schemas copied from `packages/mobile-api`
// plus the app's own `local.ts`. Not itself copied — `packages/mobile-api/src/index.ts` has no
// `local` module to re-export.
export * from './version';
export * from './enrolment';
export * from './session';
export * from './chat';
export * from './events';
export * from './notifications';
export * from './proofs';
export * from './local';
