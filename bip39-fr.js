// bip39-fr.js — Chargeur wordlists BIP39 avec double source + timeout
const SOURCES = [
  'https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039',
  'https://cdn.jsdelivr.net/gh/bitcoin/bips@master/bip-0039'
];

export const WORDLIST_FILES = {
  en: 'english.txt', fr: 'french.txt', es: 'spanish.txt', ru: 'russian.txt',
  zh: 'chinese_simplified.txt', de: 'german.txt', it: 'italian.txt',
  hi: 'hindi.txt', pt: 'portuguese.txt'
};

export const WORDLIST_META = {
  en: { label: 'English', flag: '🇬🇧' },
  fr: { label: 'Français', flag: '🇫🇷' },
  es: { label: 'Español', flag: '🇪🇸' },
  ru: { label: 'Русский', flag: '🇷🇺' },
  zh: { label: '中文 (简体)', flag: '🇨🇳' },
  de: { label: 'Deutsch', flag: '🇩🇪' },
  it: { label: 'Italiano', flag: '🇮🇹' },
  hi: { label: 'हिन्दी', flag: '🇮🇳' },
  pt: { label: 'Português', flag: '🇵🇹' }
};

const cache = new Map();
const FETCH_TIMEOUT = 8000;

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

export async function getWordlist(lang) {
  if (cache.has(lang)) return cache.get(lang);
  const file = WORDLIST_FILES[lang];
  if (!file) throw new Error('Wordlist inconnue: ' + lang);

  let lastError = null;
  for (const base of SOURCES) {
    try {
      const res = await fetchWithTimeout(base + '/' + file, FETCH_TIMEOUT);
      if (!res.ok) { lastError = 'HTTP ' + res.status; continue; }
      const text = await res.text();
      const words = text.split('\n').map(w => w.trim()).filter(Boolean);
      if (words.length !== 2048) { lastError = 'Invalid length: ' + words.length; continue; }
      cache.set(lang, words);
      return words;
    } catch (e) {
      lastError = e.message;
      continue;
    }
  }
  throw new Error('Échec ' + lang + ': ' + lastError);
}

export async function preloadWordlists(langs) {
  const results = await Promise.allSettled(langs.map(l => getWordlist(l)));
  const loaded = {};
  results.forEach((r, i) => { if (r.status === 'fulfilled') loaded[langs[i]] = r.value; });
  return loaded;
}

export function cachedLanguages() { return [...cache.keys()]; }
