// worker.js — Moteur de recherche guidée BIP39/BIP32/BIP44 + simulation + testnet
import * as bip39 from 'https://esm.sh/@scure/bip39@1.5.0';
import { HDKey } from 'https://esm.sh/@scure/bip32@1.6.0';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.7.0/sha256.js';
import { ripemd160 } from 'https://esm.sh/@noble/hashes@1.7.0/ripemd160.js';
import { bech32 } from 'https://esm.sh/@scure/base@1.2.0';

let isRunning = false;
let config = null;
let targets = new Set();
let wordlist = null;
let currentLang = 'en';

const NETWORKS = {
  mainnet: { p2pkh: 0x00, p2sh: 0x05, bech32: 'bc', coinType: 0 },
  testnet: { p2pkh: 0x6f, p2sh: 0xc4, bech32: 'tb', coinType: 1 }
};

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'setTargets') { targets = new Set(msg.targets); return; }
  if (msg.type === 'setWordlist') {
    wordlist = msg.wordlist;
    currentLang = msg.lang;
    self.postMessage({ type: 'wordlistReady', lang: currentLang, size: wordlist.length });
    return;
  }
  if (msg.type === 'start') {
    if (!wordlist) { self.postMessage({ type: 'error', message: 'Wordlist non chargée' }); return; }
    config = msg.config;
    isRunning = true;
    runLoop().catch(err => self.postMessage({ type: 'error', message: 'Erreur worker : ' + err.message }));
  }
  if (msg.type === 'stop') isRunning = false;
  if (msg.type === 'runSimulation') {
    runSimulation(msg.payload).catch(err =>
      self.postMessage({ type: 'error', message: 'Simulation : ' + err.message })
    );
  }
};

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

function hash160(data) { return ripemd160(sha256(data)); }
function checksum(data) { return sha256(sha256(data)).slice(0, 4); }
function hex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''); }

function pubkeyToP2PKH(pubkey, net) {
  const h = hash160(pubkey);
  const payload = new Uint8Array(21);
  payload[0] = net.p2pkh;
  payload.set(h, 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(checksum(payload), 21);
  return base58Encode(full);
}

function pubkeyToP2SH(pubkey, net) {
  const h = hash160(pubkey);
  const redeem = new Uint8Array(22);
  redeem[0] = 0x00; redeem[1] = 0x14;
  redeem.set(h, 2);
  const scriptHash = hash160(redeem);
  const payload = new Uint8Array(21);
  payload[0] = net.p2sh;
  payload.set(scriptHash, 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(checksum(payload), 21);
  return base58Encode(full);
}

function pubkeyToP2WPKH(pubkey, net) {
  const h = hash160(pubkey);
  return bech32.encode(net.bech32, [0, ...bech32.toWords(h)]);
}

function pubkeyToAddress(pubkey, type, net) {
  if (type === 'P2PKH') return pubkeyToP2PKH(pubkey, net);
  if (type === 'P2SH') return pubkeyToP2SH(pubkey, net);
  return pubkeyToP2WPKH(pubkey, net);
}

function detectAddressType(addr) {
  if (/^bc1/i.test(addr) || /^tb1/i.test(addr)) return 'P2WPKH';
  if (/^[13mn2]/.test(addr)) {
    if (/^[13]/.test(addr)) return /^1/.test(addr) ? 'P2PKH' : 'P2SH';
    return /^[mn]/.test(addr) ? 'P2PKH' : 'P2SH';
  }
  return null;
}

function parsePattern(pattern, len) {
  const tokens = pattern.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < len; i++) out.push(tokens[i] || '?');
  return out;
}

function findWordCandidates(token, wl) {
  if (token === '?' || token === '') return Array.from({ length: wl.length }, (_, i) => i);
  const lower = token.toLowerCase();
  const exact = wl.indexOf(lower);
  if (exact !== -1) return [exact];
  const idx = [];
  for (let i = 0; i < wl.length; i++) if (wl[i].startsWith(lower)) idx.push(i);
  return idx;
}

function* generateGuidedCandidates(pattern, wl, limit) {
  const opts = pattern.map(t => findWordCandidates(t, wl));
  if (opts.some(o => o.length === 0)) return;
  const pos = new Array(pattern.length).fill(0);
  let count = 0;
  const total = opts.reduce((a, o) => a * o.length, 1);
  const max = limit > 0 ? Math.min(total, limit) : total;
  while (count < max) {
    if (!isRunning) return;
    const phrase = new Array(pattern.length);
    for (let i = 0; i < pattern.length; i++) phrase[i] = wl[opts[i][pos[i]]];
    yield phrase.join(' ');
    count++;
    let carry = true;
    for (let i = pattern.length - 1; i >= 0 && carry; i--) {
      pos[i]++;
      if (pos[i] < opts[i].length) carry = false;
      else pos[i] = 0;
    }
    if (carry) return;
  }
}

function* generateRandomCandidates(len, wl, limit) {
  const map = { 12: 128, 15: 160, 18: 192, 21: 224, 24: 256 };
  const strength = map[len] || 256;
  let count = 0;
  while (isRunning && (limit === 0 || count < limit)) {
    yield bip39.generateMnemonic(wl, strength);
    count++;
  }
}

async function runLoop() {
  const cfg = config;
  let gen;

  if (cfg.mode === 'guided') {
    const pattern = parsePattern(cfg.pattern, cfg.phraseLength);
    for (const t of pattern) {
      if (t === '?') continue;
      if (findWordCandidates(t, wordlist).length === 0) {
        self.postMessage({ type: 'error', message: 'Aucun mot ne correspond à « ' + t + ' »' });
        return;
      }
    }
    gen = generateGuidedCandidates(pattern, wordlist, cfg.candidateLimit);
  } else {
    gen = generateRandomCandidates(cfg.phraseLength, wordlist, cfg.candidateLimit);
  }

  const passphrases = cfg.passphrases.length > 0 ? cfg.passphrases : [''];

  const paths = [];
  for (const raw of cfg.paths) {
    if (raw.includes('i')) {
      for (let i = 0; i < cfg.indexRange; i++) paths.push(raw.replace(/i/g, String(i)));
    } else paths.push(raw);
  }

  const needed = new Map();
  for (const addr of targets) {
    const type = detectAddressType(addr);
    if (!type) continue;
    const net = /^tb1/i.test(addr) || /^[mn2]/.test(addr) ? 'testnet' : 'mainnet';
    needed.set(net + ':' + type, { net, type });
  }
  if (needed.size === 0) needed.set('mainnet:P2PKH', { net: 'mainnet', type: 'P2PKH' });

  const normalizedTargets = new Set();
  for (const a of targets) {
    normalizedTargets.add(/^(bc1|tb1)/i.test(a) ? a.toLowerCase() : a);
  }

  let batchCand = 0, batchAddr = 0, matches = 0, lastReport = Date.now();

  for (const mnemonic of gen) {
    if (!isRunning) break;
    batchCand++;

    let valid = false;
    try { valid = bip39.validateMnemonic(mnemonic, wordlist); } catch (e) {}
    if (!valid) continue;

    for (const passphrase of passphrases) {
      if (!isRunning) break;
      let root;
      try {
        const seed = await bip39.mnemonicToSeed(mnemonic, passphrase);
        root = HDKey.fromMasterSeed(seed);
      } catch (e) { continue; }

      for (const path of paths) {
        if (!isRunning) break;
        let child;
        try { child = root.derive(path); } catch (e) { continue; }
        const pubkey = child.publicKey;
        if (!pubkey) continue;

        for (const { net, type } of needed.values()) {
          let address;
          try { address = pubkeyToAddress(pubkey, type, NETWORKS[net]); } catch (e) { continue; }
          batchAddr++;

          const key = (type === 'P2WPKH') ? address.toLowerCase() : address;
          if (normalizedTargets.has(key)) {
            matches++;
            self.postMessage({
              type: 'match',
              payload: {
                address, addressType: type, network: net,
                mnemonic, passphrase, path, lang: currentLang,
                pubkey: hex(pubkey), privateKey: hex(child.privateKey),
                timestamp: new Date().toISOString()
              }
            });
          }
        }
      }
    }

    const now = Date.now();
    if (now - lastReport > 500) {
      self.postMessage({ type: 'progress', candidatesTested: batchCand, addressesDerived: batchAddr, matches });
      batchCand = 0; batchAddr = 0; lastReport = now;
      await new Promise(r => setTimeout(r, 0));
    } else if (batchCand % 10 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (batchCand || batchAddr) {
    self.postMessage({ type: 'progress', candidatesTested: batchCand, addressesDerived: batchAddr, matches });
  }
  self.postMessage({ type: isRunning ? 'stopped' : 'exhausted' });
}

async function runSimulation(payload) {
  const { mnemonic, passphrase, expected } = payload;
  const results = [];
  const wl = wordlist;
  if (!wl) { self.postMessage({ type: 'error', message: 'Wordlist absente pour la simulation' }); return; }
  const seed = await bip39.mnemonicToSeed(mnemonic, passphrase);
  const root = HDKey.fromMasterSeed(seed);
  for (const [net, paths] of Object.entries(expected)) {
    const netCfg = NETWORKS[net];
    for (const [path, spec] of Object.entries(paths)) {
      let derived, ok = false, error = null;
      try {
        const child = root.derive(path);
        derived = pubkeyToAddress(child.publicKey, spec.type, netCfg);
        ok = derived === spec.address;
        if (!ok) error = 'Attendu ' + spec.address + ', obtenu ' + derived;
      } catch (e) { error = e.message; }
      results.push({ net, path, type: spec.type, expected: spec.address, derived, ok, error });
    }
  }
  self.postMessage({ type: 'simulationResult', results });
}
