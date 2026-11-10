/**
 * Utilidades criptográficas del servidor.
 * - Hashes de tokens/códigos: HMAC-SHA256 con TOKEN_PEPPER.
 * - Contraseñas de staff: Argon2id (hash-wasm).
 * - Códigos de activación legibles y códigos aleatorios base62 para QR.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

function getPepper(): string {
  const pepper = process.env.TOKEN_PEPPER;
  if (!pepper || pepper.length < 16) {
    throw new Error('TOKEN_PEPPER debe estar definido y tener al menos 16 caracteres');
  }
  return pepper;
}

/** Normaliza un código de activación humano: mayúsculas, sin espacios ni guiones. */
export function normalizeActivationCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

/** HMAC-SHA256 en hex (64 caracteres) separado por propósito (domain separation). */
export function hashSecret(purpose: 'session' | 'activation' | 'client', value: string): string {
  const normalized = purpose === 'activation' ? normalizeActivationCode(value) : value;
  return createHmac('sha256', getPepper()).update(`${purpose}:${normalized}`).digest('hex');
}

/** Token de sesión de 256 bits en base64url. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Código de activación fácil de dictar/escribir (sin 0/O/1/I/L): XXXX-XXXX-XXXX (~60 bits).
 */
const HUMAN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function generateActivationCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += HUMAN_ALPHABET[bytes[i]! % HUMAN_ALPHABET.length];
    if (i === 3 || i === 7) out += '-';
  }
  return out;
}

/** Identificador aleatorio para URL de QR (base62, 28 caracteres ≈ 166 bits). */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function generateQrCode(length = 28): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i]! % BASE62.length];
  }
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 19456, // 19 MiB (recomendación OWASP)
    hashLength: 32,
    outputType: 'encoded',
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    return false;
  }
}
