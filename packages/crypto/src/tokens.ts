import { randomInt } from "node:crypto";
import { drawRandom, encodeBase64Url, type RandomOptions } from "./encoding.ts";
import { InvalidCryptoInputError } from "./errors.ts";

/** Default token size: 32 bytes, 43 base64url characters (§5.1, §13.3, §14.5). */
export const TOKEN_BYTES = 32;
/** Smallest token accepted, so no capability is shorter than 128 bits. */
export const MIN_TOKEN_BYTES = 16;
/** Largest token accepted. */
export const MAX_TOKEN_BYTES = 1024;
/** Shortest OTP (§5.1 uses 6 digits). */
export const MIN_OTP_LENGTH = 6;
/** Longest OTP `crypto.randomInt` can draw uniformly in one call (its range is below 2^48). */
export const MAX_OTP_LENGTH = 12;

/** Random bytes encoded as base64url; 32 bytes (43 characters) unless stated. */
export function generateToken(byteLength: number = TOKEN_BYTES, options?: RandomOptions): string {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < MIN_TOKEN_BYTES ||
    byteLength > MAX_TOKEN_BYTES
  ) {
    throw new InvalidCryptoInputError(
      `Tokens must be ${MIN_TOKEN_BYTES} to ${MAX_TOKEN_BYTES} bytes`,
    );
  }
  return encodeBase64Url(drawRandom(options, byteLength));
}

/** An OTP of `length` digits drawn with `crypto.randomInt` (§5.1), uniform over every code. */
export function generateOtp(length: number): string {
  if (!Number.isSafeInteger(length) || length < MIN_OTP_LENGTH || length > MAX_OTP_LENGTH) {
    throw new InvalidCryptoInputError(`OTPs must be ${MIN_OTP_LENGTH} to ${MAX_OTP_LENGTH} digits`);
  }
  return String(randomInt(0, 10 ** length)).padStart(length, "0");
}
