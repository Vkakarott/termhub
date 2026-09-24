/** A P-256 public key in JWK form (design spec §2 "Device key"). */
export type P256Jwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

/**
 * The device key port: one asymmetric key pair per device, used only to sign DPoP proofs
 * (P§5.2). `SoftwareDeviceKey` backs the mock and Jest; `HardwareDeviceKey` backs the real app.
 */
export interface DeviceKey {
  create(): Promise<P256Jwk>;
  exists(): Promise<boolean>;
  publicJwk(): Promise<P256Jwk>;
  /** Raw ECDSA signature, `r‖s`, 64 bytes — never DER. */
  sign(message: Uint8Array): Promise<Uint8Array>;
  destroy(): Promise<void>;
}
