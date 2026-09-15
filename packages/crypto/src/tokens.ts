import { NotImplementedError } from "./errors.ts";

/** Random bytes encoded as base64url; 32 bytes (43 characters) unless stated. */
export function generateToken(_byteLength?: number): string {
  throw new NotImplementedError("crypto.generateToken");
}

/** An OTP of `length` digits drawn with `crypto.randomInt` (§5.1). */
export function generateOtp(_length: number): string {
  throw new NotImplementedError("crypto.generateOtp");
}
