// secp-direct.js — Dérivation directe des adresses (sans worker)
// Utilise @noble/secp256k1 chargé via CDN.

let secpPromise = null;

async function loadSecp() {
  if (secpPromise) return secpPromise;
  secpPromise = (async () => {
    try {
      const mod = await import('https://esm.sh/@noble/secp256k1@2.2.3');
      return mod.secp256k1 || mod.default || mod;
    } catch (e) {
      console.error('[secp] échec import :', e);
      throw e;
    }
  })();
  return secpPromise;
}

// ---- Sha256/Ripemd160 via WebCrypto ----
async function sha256(data) {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(buf);
}

function ripemd160(data) {
  // Implémentation compacte — identique à celle du worker
  function rot(x,n){return (x<<n)|(x>>> (32-n));}
  function f(j,x,y,z){if(j<16) return x^y^z; if(j<32) return (x&y)|(~x&z); if(j<48) return (x|~y)^z; if(j<64) return (x&z)|(y&~z); return x^(y|~z);}
  function K(j){if(j<16) return 0x00000000; if(j<32) return 0x5a827999; if(j<48) return 0x6ed9eba1; if(j<64) return 0x8f1bbcdc; return 0xa953fd4e;}
  function KK(j){if(j<16) return 0x50a28be6; if(j<32) return 0x5c4dd124; if(j<48) return 0x6d703ef3; if(j<64) return 0x7a6d76e9; return 0x00000000;}
  const r=[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
  const rr=[5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14];
  const s=[11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,15,13,11,11,10,9,8,7,14,12,5,6,8,13,6,5,15,13,11,11,14,7,6,8,13,6,5,15,13];
  const ss=[8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,5];
  const ml=data.length;
  const with1=new Uint8Array(((ml+8+64)>>6)<<6);
  with1.set(data);
  with1[ml]=0x80;
  const bitLen=ml*8;
  with1[with1.length-8]=bitLen&255;
  with1[with1.length-7]=(bitLen>>>8)&255;
  with1[with1.length-6]=(bitLen>>>16)&255;
  with1[with1.length-5]=(bitLen>>>24)&255;
  let h0=0x67452301,h1=0xefcdab89,h2=0x98badcfe,h3=0x10325476,h4=0xc3d2e1f0;
  for(let i=0;i<with1.length;i+=64){
    const X=new Array(16);
    for(let j=0;j<16;j++) X[j]=with1[i+4*j]|(with1[i+4*j+1]<<8)|(with1[i+4*j+2]<<16)|(with1[i+4*j+3]<<24);
    let A=h0,B=h1,C=h2,D=h3,E=h4;
    let AA=h0,BB=h1,CC=h2,DD=h3,EE=h4;
    for(let j=0;j<80;j++){
      const T=((rot(A+f(j,B,C,D)+X[r[j]]+K(j)|0,s[j]))+E)|0;
      A=E;E=D;D=rot(C,10);C=B;B=T;
      const TT=((rot(AA+f(79-j,BB,CC,DD)+X[rr[j]]+KK(j)|0,ss[j]))+EE)|0;
      AA=EE;EE=DD;DD=rot(CC,10);CC=BB;BB=TT;
    }
    const t=(h1+C+DD)|0;
    h1=(h2+D+EE)|0;h2=(h3+E+AA)|0;h3=(h4+A+BB)|0;h4=(h0+B+CC)|0;h0=t;
  }
  const out=new Uint8Array(20);
  const hs=[h0,h1,h2,h3,h4];
  for(let i=0;i<5;i++){
    out[i*4]=hs[i]&255;
    out[i*4+1]=(hs[i]>>>8)&255;
    out[i*4+2]=(hs[i]>>>16)&255;
    out[i*4+3]=(hs[i]>>>24)&255;
  }
  return out;
}

async function hash160(data) {
  return ripemd160(await sha256(data));
}

// ---- Base58 ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function base58Check(payload) {
  const c = (await sha256(await sha256(payload))).slice(0, 4);
  return base58Encode(concatBytes(payload, c));
}

// ---- Bech32 ----
const BECH32_CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function bech32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function bech32CreateChecksum(hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> 5 * (5 - i)) & 31);
  return out;
}
function bech32Encode(hrp, data) {
  const combined = [...data, ...bech32CreateChecksum(hrp, data)];
  let s = hrp + '1';
  for (const b of combined) s += BECH32_CHARS[b];
  return s;
}
function bech32ToWords(bytes) {
  const out = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

// ---- Adresses ----
async function pubkeyToP2PKH(pubkey) {
  const h = await hash160(pubkey);
  const payload = new Uint8Array(21);
  payload[0] = 0x00;
  payload.set(h, 1);
  return base58Check(payload);
}

async function pubkeyToP2SH_P2WPKH(pubkey) {
  const h = await hash160(pubkey);
  const redeem = new Uint8Array(22);
  redeem[0] = 0x00; redeem[1] = 0x14;
  redeem.set(h, 2);
  const scriptHash = await hash160(redeem);
  const payload = new Uint8Array(21);
  payload[0] = 0x05;
  payload.set(scriptHash, 1);
  return base58Check(payload);
}

async function pubkeyToP2WPKH(pubkey) {
  const h = await hash160(pubkey);
  return bech32Encode('bc', [0, ...bech32ToWords(h)]);
}

async function computeWIF(privBytes, compressed = true) {
  const payload = new Uint8Array(1 + 32 + (compressed ? 1 : 0));
  payload[0] = 0x80;
  payload.set(privBytes, 1);
  if (compressed) payload[33] = 0x01;
  return base58Check(payload);
}

// ---- Point d'entrée ----
export async function deriveAddresses(privKeyBytes) {
  const secp = await loadSecp();

  // Validation
  const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  const hex = Array.from(privKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const d = BigInt('0x' + hex);
  if (d === 0n || d >= N) throw new Error('Clé privée invalide');

  const pubC = secp.getPublicKey(privKeyBytes, true);
  const pubU = secp.getPublicKey(privKeyBytes, false);

  const [wif, p2pkhC, p2pkhU, p2sh, bech32] = await Promise.all([
    computeWIF(privKeyBytes, true),
    pubkeyToP2PKH(pubC),
    pubkeyToP2PKH(pubU),
    pubkeyToP2SH_P2WPKH(pubC),
    pubkeyToP2WPKH(pubC)
  ]);

  return { wif, p2pkhC, p2pkhU, p2sh, bech32 };
}
