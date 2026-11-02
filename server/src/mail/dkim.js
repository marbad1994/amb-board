import { generateKeyPairSync } from 'node:crypto';

// One 2048-bit RSA key per domain. The private key goes to OpenDKIM through the sync helper; the public part is the DNS record.
export function generateDkim() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { privatePem: privateKey, publicB64: publicKey.toString('base64') };
}
