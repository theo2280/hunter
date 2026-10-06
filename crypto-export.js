// crypto-export.js — Export chiffré Argon2id + AES-256-GCM
import { argon2id } from 'https://esm.sh/@noble/hashes@1.7.0/argon2.js';
import { randomBytes } from 'https://esm.sh/@noble/hashes@1.7.0/utils.js';

const ARGON2_PARAMS = { t: 3, m: 65536, p: 1, dkLen: 32 };
const SALT_LEN = 16;
const IV_LEN = 12;

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  return argon2id(enc.encode(password), salt, ARGON2_PARAMS);
}

export async function encryptExport(data, password) {
  const json = JSON.stringify(data);
  const plaintext = new TextEncoder().encode(json);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const keyBytes = await deriveKey(password, salt);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const envelope = {
    format: 'hunter-encrypted-v1',
    kdf: { algorithm: 'argon2id', t: ARGON2_PARAMS.t, m: ARGON2_PARAMS.m, p: ARGON2_PARAMS.p },
    cipher: 'AES-256-GCM',
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    ciphertext: bufToB64(ciphertext),
    createdAt: new Date().toISOString()
  };
  return new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
}

export async function decryptExport(blobOrText, password) {
  let envelope;
  if (typeof blobOrText === 'string') envelope = JSON.parse(blobOrText);
  else { const text = await blobOrText.text(); envelope = JSON.parse(text); }
  if (envelope.format !== 'hunter-encrypted-v1') throw new Error('Format inconnu');
  const salt = b64ToBuf(envelope.salt);
  const iv = b64ToBuf(envelope.iv);
  const ciphertext = b64ToBuf(envelope.ciphertext);
  const keyBytes = await deriveKey(password, salt);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch { throw new Error('Mot de passe incorrect ou fichier corrompu'); }
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function passwordStrength(pwd) {
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (pwd.length >= 16) score++;
  if (/[a-z]/.test(pwd)) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/\d/.test(pwd)) score++;
  if (/[^a-zA-Z0-9]/.test(pwd)) score++;
  return Math.min(score, 7);
}
