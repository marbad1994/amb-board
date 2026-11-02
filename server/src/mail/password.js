import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';

export const MIN_PASSWORD = 12;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const generatePassword = (n = 18) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

// SHA512-CRYPT ($6$...), the format Dovecot reads as {SHA512-CRYPT}. openssl does the hashing and gets the password on its standard
// input, so it never appears in a process list. Only the hash is stored.
export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const p = execFile('openssl', ['passwd', '-6', '-stdin'], { timeout: 10_000 }, (err, out) => {
      const h = String(out || '').trim();
      if (err || !/^\$6\$[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$/.test(h)) return reject(new Error('could not hash the password (is openssl installed?)'));
      resolve(h);
    });
    p.stdin.end(`${password}\n`);
  });
}

export function checkPassword(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD) return `the password needs at least ${MIN_PASSWORD} characters`;
  if (p.length > 200 || /[\r\n\0]/.test(p)) return 'that password cannot be used';
  return null;
}
