// Keypair identities for direct messages (D30).
//
// Every local profile owns two key pairs, generated on this device and kept
// out of the profile object so they are never sent to a server:
//   sign (Ed25519)  proves who you are: it signs your card and mailbox logins
//   dh   (X25519)   agrees on a shared key with one friend
//
// A card is what you hand out: { id, s, d, sig }, where `s` and `d` are the
// public keys and `sig` binds the profile id and `d` to `s`. Your address is
// the hash of `s`; servers file your mailbox under it.
//
// Two people derive the same AES-GCM key from their dh keys, so anything
// sealed with it can only have come from one of them. The direction is in the
// additional data, so a message can't be reflected back at its sender.
import { identities } from './store.js';

const te = new TextEncoder();
const td = new TextDecoder();
const CARD = 'friendspeak-card-v1|';
const AUTH = 'friendspeak-dm-auth-v1|';
const B64 = /^[A-Za-z0-9_-]+$/;

export const b64 = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const isKey = (v, len) => typeof v === 'string' && v.length === len && B64.test(v);

async function generate() {
  const out = {};
  for (const [name, alg, uses] of [
    ['sign', 'Ed25519', ['sign', 'verify']],
    ['dh', 'X25519', ['deriveBits']],
  ]) {
    const pair = await crypto.subtle.generateKey({ name: alg }, true, uses);
    out[name] = { pub: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), priv: b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)) };
  }
  return out;
}

export const addressOf = async (s) => b64(await crypto.subtle.digest('SHA-256', unb64(s)));

const loaded = new Map(); // profileId -> { pub, promise }

// The identity of a local profile; its keys are created the first time
export function identityFor(profile) {
  const stored = identities.get(profile.id);
  const hit = loaded.get(profile.id);
  // Importing a profile file can swap the keys under us: load those instead
  if (hit && (!stored || hit.pub === null || hit.pub === stored.sign.pub)) return hit.promise;
  const entry = { pub: stored?.sign.pub ?? null };
  entry.promise = (async () => {
    let keys = stored;
    if (!keys) identities.set(profile.id, (keys = await generate()));
    entry.pub = keys.sign.pub;
    const signKey = await crypto.subtle.importKey('pkcs8', unb64(keys.sign.priv), { name: 'Ed25519' }, false, ['sign']);
    const dhKey = await crypto.subtle.importKey('pkcs8', unb64(keys.dh.priv), { name: 'X25519' }, false, ['deriveBits']);
    const sign = async (text) => b64(await crypto.subtle.sign({ name: 'Ed25519' }, signKey, te.encode(text)));
    const card = { id: profile.id, s: keys.sign.pub, d: keys.dh.pub, sig: await sign(CARD + profile.id + '|' + keys.dh.pub) };
    return { id: profile.id, card, address: await addressOf(keys.sign.pub), dhKey, login: (nonce) => sign(AUTH + nonce) };
  })();
  entry.promise.catch(() => loaded.get(profile.id) === entry && loaded.delete(profile.id));
  loaded.set(profile.id, entry);
  return entry.promise;
}

// A card someone else gave us: null unless it's well-formed and signed by its own key
export async function verifyCard(card) {
  if (!card || typeof card !== 'object') return null;
  const { id, s, d, sig } = card;
  if (typeof id !== 'string' || !id || id.length > 64 || !isKey(s, 43) || !isKey(d, 43) || !isKey(sig, 86)) return null;
  try {
    const key = await crypto.subtle.importKey('raw', unb64(s), { name: 'Ed25519' }, false, ['verify']);
    if (!(await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64(sig), te.encode(CARD + id + '|' + d)))) return null;
    return { id, s, d, sig };
  } catch {
    return null;
  }
}

// The key two people share (the same on both sides)
export async function pairKey(identity, card) {
  const theirs = await crypto.subtle.importKey('raw', unb64(card.d), { name: 'X25519' }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, identity.dhKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('friendspeak-dm-v1'), info: new Uint8Array() }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// iv (12 bytes) + ciphertext. `aad` names the kind of data and its direction.
export async function seal(key, aad, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

// Throws unless it was sealed with this key for this `aad`
export async function unseal(key, aad, bytes) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: te.encode(aad) }, key, bytes.subarray(12)));
}

export const sealJson = async (key, aad, obj) => b64(await seal(key, aad, te.encode(JSON.stringify(obj))));
export const unsealJson = async (key, aad, text) => JSON.parse(td.decode(await unseal(key, aad, unb64(text))));

// ---------- friend codes ----------
// "fs1." + base64url(JSON { card, name, relays }): everything needed to write
// to someone you share no server with.

export const cleanRelays = (list) =>
  [...new Set((Array.isArray(list) ? list : []).filter((r) => typeof r === 'string' && r.length <= 200 && /^https?:\/\/[^\s/"'<>]+$/.test(r)))].slice(0, 6);

export const friendCode = (identity, profile, relays) => 'fs1.' + b64(te.encode(JSON.stringify({ card: identity.card, name: profile.name, relays: cleanRelays(relays) })));

export async function parseFriendCode(text) {
  const m = /fs1\.([A-Za-z0-9_-]+)/.exec(String(text || ''));
  if (!m) return null;
  try {
    const data = JSON.parse(td.decode(unb64(m[1])));
    const card = await verifyCard(data.card);
    return card && { card, name: typeof data.name === 'string' ? data.name.slice(0, 32).trim() : '', relays: cleanRelays(data.relays) };
  } catch {
    return null;
  }
}
