// balance.js — Vérification optionnelle du solde Bitcoin
// Offline par défaut. N'envoie QUE des adresses publiques aux APIs.
// Aucune clé privée, aucun mnémonique ne quitte jamais l'appareil.

// ============================================================
//  CONFIGURATION DES APIs
// ============================================================
const APIS = {
  mempool: {
    label: 'mempool.space',
    url: (addr) => `https://mempool.space/api/address/${addr}`,
    parse: (json) => {
      const stats = json.chain_stats || {};
      const mempool = json.mempool_stats || {};
      const funded = (stats.funded_txo_sum || 0) + (mempool.funded_txo_sum || 0);
      const spent = (stats.spent_txo_sum || 0) + (mempool.spent_txo_sum || 0);
      const totalTx = (stats.tx_count || 0) + (mempool.tx_count || 0);
      return {
        balance: (funded - spent) / 1e8,
        received: funded / 1e8,
        sent: spent / 1e8,
        txCount: totalTx
      };
    }
  },
  blockchair: {
    label: 'blockchair.com',
    url: (addr) => `https://api.blockchair.com/bitcoin/dashboards/address/${addr}`,
    parse: (json) => {
      const addrData = json.data && json.data[addr];
      if (!addrData) throw new Error('Adresse non trouvée');
      const info = addrData.address || {};
      return {
        balance: (info.balance || 0) / 1e8,
        received: (info.received || 0) / 1e8,
        sent: ((info.received || 0) - (info.balance || 0)) / 1e8,
        txCount: info.transaction_count || 0
      };
    }
  }
};

// ============================================================
//  CACHE (30 secondes pour éviter le spam)
// ============================================================
const CACHE_TTL_MS = 30_000;
const cache = new Map();

function cacheGet(addr, api) {
  const key = `${api}:${addr}`;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(addr, api, value) {
  cache.set(`${api}:${addr}`, { at: Date.now(), value });
}

export function clearBalanceCache() {
  cache.clear();
}

// ============================================================
//  VALIDATION D'ADRESSE
// ============================================================
function isValidAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  const a = addr.trim();
  // Mainnet : P2PKH (1...), P2SH (3...), Bech32 (bc1...)
  if (/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return true;
  if (/^3[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return true;
  if (/^bc1[a-z0-9]{25,90}$/i.test(a)) return true;
  // Testnet : P2PKH (m/n...), P2SH (2...), Bech32 (tb1...)
  if (/^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return true;
  if (/^2[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return true;
  if (/^tb1[a-z0-9]{25,90}$/i.test(a)) return true;
  return false;
}

// ============================================================
//  FETCH AVEC TIMEOUT
// ============================================================
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ============================================================
//  API PUBLIQUE
// ============================================================
/**
 * Récupère le solde d'une adresse via une API publique.
 * Retourne { balance, received, sent, txCount, api, cached } ou lève une erreur.
 *
 * @param {string} address - Adresse Bitcoin
 * @param {Object} opts - { api: 'mempool'|'blockchair', skipCache: bool }
 */
export async function fetchBalance(address, opts = {}) {
  const { api = 'mempool', skipCache = false } = opts;

  if (!isValidAddress(address)) {
    throw new Error('Adresse Bitcoin invalide');
  }

  if (!skipCache) {
    const cached = cacheGet(address, api);
    if (cached) return { ...cached, cached: true };
  }

  const apiConfig = APIS[api];
  if (!apiConfig) throw new Error('API inconnue : ' + api);

  const res = await fetchWithTimeout(apiConfig.url(address));
  if (!res.ok) {
    throw new Error(`${apiConfig.label} : HTTP ${res.status}`);
  }
  const json = await res.json();
  const parsed = apiConfig.parse(json);

  const result = { ...parsed, api, cached: false };
  cacheSet(address, api, result);
  return result;
}

/**
 * Essaie l'API principale, bascule sur le fallback en cas d'échec.
 * @param {string} address
 * @param {Object} opts - { primary, fallback }
 */
export async function fetchBalanceWithFallback(address, opts = {}) {
  const { primary = 'mempool', fallback = 'blockchair' } = opts;

  try {
    return await fetchBalance(address, { api: primary });
  } catch (e1) {
    console.warn(`[Balance] ${primary} échoué, essai ${fallback} :`, e1.message);
    try {
      return await fetchBalance(address, { api: fallback });
    } catch (e2) {
      throw new Error(`Toutes les APIs ont échoué : ${e1.message} / ${e2.message}`);
    }
  }
}

/**
 * Vérifie plusieurs adresses en parallèle (max 4).
 * @param {string[]} addresses
 * @param {Object} opts
 * @returns {Promise<Array>} - Résultats dans le même ordre, ou null si erreur
 */
export async function fetchBalancesParallel(addresses, opts = {}) {
  const results = await Promise.allSettled(
    addresses.map(a => a ? fetchBalanceWithFallback(a, opts) : Promise.resolve(null))
  );
  return results.map(r => {
    if (r.status === 'fulfilled') return r.value;
    return { error: r.reason?.message || 'Erreur inconnue' };
  });
}

// ============================================================
//  FORMATAGE
// ============================================================
export function formatBTC(amount) {
  if (typeof amount !== 'number' || isNaN(amount)) return '—';
  return amount.toFixed(8) + ' BTC';
}

export function formatSats(amount) {
  if (typeof amount !== 'number' || isNaN(amount)) return '—';
  return Math.round(amount * 1e8).toLocaleString() + ' sats';
}

/**
 * Détermine l'état d'une adresse pour l'affichage UI.
 * @returns {string} 'funded' | 'empty' | 'error'
 */
export function balanceState(result) {
  if (!result) return 'error';
  if (result.error) return 'error';
  if (result.balance > 0) return 'funded';
  return 'empty';
}
