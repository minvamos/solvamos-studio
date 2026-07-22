/**
 * Password hashing (bcrypt) — production-safe defaults.
 */
import bcrypt from 'bcryptjs';

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function assertPasswordPolicy(plain: string): string | null {
  if (typeof plain !== 'string' || plain.length < 8) {
    return '비밀번호는 8자 이상이어야 합니다';
  }
  if (plain.length > 128) return '비밀번호가 너무 깁니다';
  return null;
}

export function normalizeEmail(email: string): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

export function assertEmail(email: string): string | null {
  const e = normalizeEmail(email);
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return '유효한 이메일을 입력하세요';
  if (e.length > 254) return '이메일이 너무 깁니다';
  return null;
}
