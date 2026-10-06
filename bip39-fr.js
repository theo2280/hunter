// bip39-fr.js — Chargeur unifié de 9 wordlists BIP39 (hors Japanese)
const BASE_URL = 'https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039';

export const WORDLIST_FILES = {
  en: 'english.txt',
  fr: 'french.txt',
  es: 'spanish.txt',
  ru: 'russian.txt',
  zh: 'chinese_simplified.txt',
  de: 'german.txt',
  it: 'italian.txt',
  hi: 'hindi.txt',
  pt: 'portuguese.txt'
};

export const WORDLIST_META = {
  en: { label: 'English',  flag: '🇬🇧' },
  fr: { label: 'Français', flag: '🇫🇷' },
  es: { label: 'Español',  flag: '🇪🇸' },
  ru: { label: 'Русский',  flag: '🇷🇺' },
  zh: { label: '中文 (简体)', flag: '🇨🇳' },
  de: { label: 'Deutsch',  flag: '🇩🇪' },
  it: { label: 'Italiano', flag: '🇮🇹' },
  hi: { label: 'हिन्दी',   flag: '🇮🇳' },
  pt: { label: 'Português', flag: '🇵🇹' }
};

const cache = new Map();

export async function getWordlist(lang) {
  if (cache.has(lang)) return cache.get(lang);
  const file = WORDLIST_FILES[lang];
  if (!file) throw new Error('Wordlist inconnue : ' + lang);
  const res = await fetch(BASE_URL + '/' + file, { cache: 'force-cache' });
  if (!res.ok) throw new Error('Échec ' + lang + ' (' + res.status + ')');
  const text = await res.text();
  const words = text.split('\n').map(w => w.trim()).filter(Boolean);
  if (words.length !== 2048) throw new Error('Wordlist ' + lang + ' invalide (' + words.length + ')');
  cache.set(lang, words);
  return words;
}

export async function preloadWordlists(langs) {
  const results = await Promise.allSettled(langs.map(l => getWordlist(l)));
  const loaded = {};
  results.forEach((r, i) => { if (r.status === 'fulfilled') loaded[langs[i]] = r.value; });
  return loaded;
}

export function cachedLanguages() { return [...cache.keys()]; }
/**
 * Préchargement avec retry automatique : 3 tentatives avec backoff.
 * Retourne un objet { loaded, missing } indiquant ce qui a réussi.
 */
export async function preloadWordlistsWithRetry(langs, onProgress) {
  const loaded = {};
  const stillMissing = [...langs];

  for (let attempt = 1; attempt <= 3 && stillMissing.length > 0; attempt++) {
    if (onProgress) onProgress({ attempt, loaded: Object.keys(loaded).length, total: langs.length, missing: [...stillMissing] });

    // Lancer tous les manquants en parallèle
    const results = await Promise.allSettled(
      stillMissing.map(l => getWordlist(l))
    );

    // Récupérer ceux qui ont réussi
    const newMissing = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        loaded[stillMissing[i]] = r.value;
      } else {
        newMissing.push(stillMissing[i]);
      }
    });

    stillMissing.length = 0;
    stillMissing.push(...newMissing);

    // Attendre un peu avant de retenter (sauf si tout est OK)
    if (stillMissing.length > 0 && attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }

  if (onProgress) onProgress({ attempt: 'done', loaded: Object.keys(loaded).length, total: langs.length, missing: [...stillMissing] });

  return { loaded, missing: stillMissing };
}
