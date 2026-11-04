import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function requireKey(): Buffer {
  if (!env.tokenEncryptionKey) throw new ApiError(500, 'Shopify integration is not configured', 'SHOPIFY_NOT_CONFIGURED');
  const key = Buffer.from(env.tokenEncryptionKey, 'hex');
  if (key.length !== 32) throw new ApiError(500, 'TOKEN_ENCRYPTION_KEY must be a 32-byte hex string', 'SHOPIFY_NOT_CONFIGURED');
  return key;
}

/** Encrypts a Shopify access token for storage. Format: iv:authTag:ciphertext, all hex. */
export function encryptToken(plaintext: string): string {
  const key = requireKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptToken(stored: string): string {
  const key = requireKey();
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) throw new ApiError(500, 'Corrupt stored access token', 'SHOPIFY_TOKEN_CORRUPT');
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}
