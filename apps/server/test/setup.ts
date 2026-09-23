import { setPublicIdKey } from '../src/public/public-id.js';

/**
 * In production the key behind `publicId` is loaded from the database before the server listens
 * (`buildApp`). Tests never boot that far, so every test file starts with this fixed one instead.
 */
export const TEST_PUBLIC_ID_KEY = Buffer.alloc(32, 42);
setPublicIdKey(TEST_PUBLIC_ID_KEY);
