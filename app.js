// app.js — Orchestrateur Hunter : serveur PWA + crypto + IndexedDB + simulation + testnet
import { getWordlist, preloadWordlists, preloadWordlistsWithRetry, WORDLIST_META } from './bip39-fr.js';
import { LocalServer } from './server.js';
import {
  startSession, updateSession, endSession, getLastSession,
  saveMatch, setConfig, getConfig, saveFormState, loadFormState
} from './storage.js';
import { encryptExport, decryptExport, passwordStrength } from './crypto-export.js';
async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    const already = await navigator.storage.persisted();
    if (already) { console.log('[Storage] Déjà persistant'); return true; }
    const granted = await navigator.storage.persist();
    console.log('[Storage] Persistance accordée :', granted);
    return granted;
  } catch (e) {
    console.warn('[Storage] Échec persistance:', e);
    return false;
  }
}

const state = {
  workers: [],
  targets: new Set(),
  matches: [],
  isRunning: false,
  stats: { candidates: 0, addresses: 0, matches: 0, startTime: 0 },
  currentMode: 'guided',
  reportInterval: null,
  exhaustedCount: 0,
  server: null,
  sessionId: null
};

const $ = id => document.getElementById(id);
const els = {
  modeTabs: document.querySelectorAll('.mode-tab'),
  guidedPanel: $('guidedPanel'),
  randomPanel: $('randomPanel'),
  mnemonicPattern: $('mnemonicPattern'),
  phraseLength: $('phraseLength'),
  wordlistLang: $('wordlistLang'),
  wordlistStatus: $('wordlistStatus'),
  passphraseList: $('passphraseList'),
  pathList: $('pathList'),
  indexRange: $('indexRange'),
  randomLength: $('randomLength'),
  randomLang: $('randomLang'),
  targetsInput: $('targetsInput'),
  loadTargetsBtn: $('loadTargetsBtn'),
  targetsStatus: $('targetsStatus'),
  workerCount: $('workerCount'),
  candidateLimit: $('candidateLimit'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  exportBtn: $('exportBtn'),
  statCandidates: $('statCandidates'),
  statAddresses: $('statAddresses'),
  statMatches: $('statMatches'),
  statRate: $('statRate'),
  progressFill: $('progressFill'),
  statusText: $('statusText'),
  resultsPanel: $('resultsPanel'),
  resultsList: $('resultsList'),
  serverStatus: $('serverStatus'),
  installBtn: $('installBtn'),
  pwaHint: $('pwaHint'),
  simulateBtn: $('simulateBtn'),
  importBtn: $('importBtn'),
  importFile: $('importFile'),
  purgeCacheBtn: $('purgeCacheBtn')
};

function populateLanguageSelects() {
  for (const [code, meta] of Object.entries(WORDLIST_META)) {
    const opt1 = document.createElement('option');
    opt1.value = code;
    opt1.textContent = meta.flag + ' ' + meta.label;
    els.wordlistLang.appendChild(opt1);
    const opt2 = opt1.cloneNode(true);
    els.randomLang.appendChild(opt2);
  }
  els.wordlistLang.value = 'en';
  els.randomLang.value = 'en';
}

async function initWordlists() {
  const langs = Object.keys(WORDLIST_META);
  els.wordlistStatus.textContent = '⏳ Préchargement de ' + langs.length + ' wordlists...';

  try {
    const result = await preloadWordlistsWithRetry(langs, (progress) => {
      if (progress.attempt === 'done') return;
      els.wordlistStatus.textContent =
        '⏳ Tentative ' + progress.attempt + '/3 — ' +
        progress.loaded + '/' + progress.total + ' chargées...';
    });

    const ok = Object.keys(result.loaded).length;
    const missing = result.missing;

    if (missing.length === 0) {
      els.wordlistStatus.textContent =
        '✅ ' + ok + '/' + langs.length + ' wordlists chargées (' + (ok * 2048) + ' mots).';
    } else {
      const missingLabels = missing.map(l => WORDLIST_META[l].label).join(', ');
      els.wordlistStatus.textContent =
        '⚠️ ' + ok + '/' + langs.length + ' wordlists chargées. ' +
        'Manquantes : ' + missingLabels + ' (à la demande).';
      console.warn('[Wordlists] Non chargées après 3 tentatives :', missing);
    }
  } catch (e) {
    els.wordlistStatus.textContent = '⚠️ Erreur : ' + e.message;
  }
}
els.modeTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    els.modeTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.currentMode = tab.dataset.mode;
    els.guidedPanel.style.display = state.currentMode === 'guided' ? 'block' : 'none';
    els.randomPanel.style.display = state.currentMode === 'random' ? 'block' : 'none';
  });
});

els.loadTargetsBtn.addEventListener('click', () => {
  const lines = els.targetsInput.value.split('\n');
  const set = new Set();
  for (const line of lines) {
    const a = line.trim();
    if (a && a.length > 20) set.add(a);
  }
  state.targets = set;
  els.targetsStatus.textContent = set.size + ' adresse(s) cible(s) chargée(s).';
  els.startBtn.disabled = set.size === 0;
  for (const w of state.workers) {
    w.postMessage({ type: 'setTargets', targets: [...set] });
  }
});

function createWorkers(count) {
  for (const w of state.workers) w.terminate();
  state.workers = [];
  state.exhaustedCount = 0;
  for (let i = 0; i < count; i++) {
    const worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = (e) => handleWorkerMessage(e.data);
    worker.onerror = (err) => console.error('Worker error:', err);
    state.workers.push(worker);
  }
}

function handleWorkerMessage(msg) {
  if (msg.type === 'progress') {
    state.stats.candidates += msg.candidatesTested;
    state.stats.addresses += msg.addressesDerived;
    updateUI();
  } else if (msg.type === 'match') {
    onMatch(msg.payload);
  } else if (msg.type === 'exhausted') {
    state.exhaustedCount++;
    if (state.exhaustedCount >= state.workers.length) {
      stopAll('✅ Espace de recherche épuisé.');
    }
  } else if (msg.type === 'error') {
    els.statusText.textContent = '⚠️ ' + msg.message;
  } else if (msg.type === 'wordlistReady') {
    els.statusText.textContent = 'Wordlist ' + msg.lang + ' prête (' + msg.size + ' mots).';
  }
}

async function onMatch(match) {
  state.stats.matches++;
  state.matches.push(match);
  addResultToUI(match);
  updateUI();
  els.exportBtn.disabled = false;
  if (state.sessionId) {
    try { await saveMatch(state.sessionId, match); } catch (e) { console.warn(e); }
  }
}

els.startBtn.addEventListener('click', async () => {
  if (state.targets.size === 0) { alert('Chargez des adresses cibles.'); return; }

  const paths = els.pathList.value.split('\n').map(l => l.trim()).filter(l => l.startsWith('m/'));
  const passphrases = els.passphraseList.value.split('\n').map(p => p.trim()).filter(Boolean);
  const candidateLimit = parseInt(els.candidateLimit.value) || 0;
  const indexRange = parseInt(els.indexRange.value) || 10;
  const lang = state.currentMode === 'guided' ? els.wordlistLang.value : els.randomLang.value;

  let config;
  if (state.currentMode === 'guided') {
    const pattern = els.mnemonicPattern.value.trim();
    if (!pattern) { alert('Saisissez un pattern.'); return; }
    config = { mode: 'guided', pattern, phraseLength: parseInt(els.phraseLength.value), lang, passphrases, paths: paths.length > 0 ? paths : ["m/44'/0'/0'/0/0"], indexRange, candidateLimit };
  } else {
    config = { mode: 'random', phraseLength: parseInt(els.randomLength.value), lang, passphrases, paths: paths.length > 0 ? paths : ["m/44'/0'/0'/0/0"], indexRange, candidateLimit };
  }

  let wordlist;
  try { wordlist = await getWordlist(lang); }
  catch (e) { alert('Wordlist ' + lang + ' indisponible : ' + e.message); return; }

  try {
    const session = await startSession(config);
    state.sessionId = session.id;
  } catch (e) { console.warn('IndexedDB indisponible :', e); }

  createWorkers(parseInt(els.workerCount.value));
  state.isRunning = true;
  state.stats = { candidates: 0, addresses: 0, matches: 0, startTime: Date.now() };
  state.matches = [];

  els.resultsList.innerHTML = '';
  els.resultsPanel.style.display = 'none';
  els.exportBtn.disabled = true;
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;
  els.statusText.textContent = 'Démarrage (' + state.workers.length + ' workers, ' + state.currentMode + ', ' + lang + ')...';

  const targetsArray = [...state.targets];
  for (const worker of state.workers) {
    worker.postMessage({ type: 'setWordlist', lang, wordlist });
    worker.postMessage({ type: 'setTargets', targets: targetsArray });
    worker.postMessage({ type: 'start', config });
  }

  state.reportInterval = setInterval(async () => {
    updateUI();
    if (state.sessionId) {
      try { await updateSession(state.sessionId, { stats: state.stats }); } catch (e) {}
    }
  }, 1000);
});

els.stopBtn.addEventListener('click', () => stopAll('⏹️ Arrêté.'));

function stopAll(reason) {
  state.isRunning = false;
  for (const w of state.workers) w.postMessage({ type: 'stop' });
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  clearInterval(state.reportInterval);
  if (state.sessionId) endSession(state.sessionId, 'stopped').catch(() => {});
  els.statusText.textContent = reason || 'Arrêté.';
  updateUI();
}

function updateUI() {
  els.statCandidates.textContent = state.stats.candidates.toLocaleString();
  els.statAddresses.textContent = state.stats.addresses.toLocaleString();
  els.statMatches.textContent = state.stats.matches;

  const elapsed = (Date.now() - state.stats.startTime) / 1000;
  const rate = elapsed > 0 ? Math.round(state.stats.addresses / elapsed) : 0;
  els.statRate.textContent = rate.toLocaleString();

  const limit = parseInt(els.candidateLimit.value) || 0;
  if (limit > 0) {
    const pct = Math.min(100, (state.stats.candidates / limit) * 100);
    els.progressFill.style.width = pct + '%';
  } else {
    els.progressFill.style.width = (state.isRunning ? 50 : 0) + '%';
  }

  if (state.isRunning) {
    els.statusText.textContent =
      'En cours · ' + state.stats.candidates.toLocaleString() + ' candidats · ' +
      state.stats.addresses.toLocaleString() + ' adresses · ' +
      state.stats.matches + ' trouvée(s) · ~' + rate + '/s';
  }
}

function addResultToUI(m) {
  els.resultsPanel.style.display = 'block';
  const div = document.createElement('div');
  div.className = 'result-item';
  div.innerHTML =
    '<div class="label">Adresse (' + m.addressType + ' / ' + (m.network || 'mainnet') + ')</div>' +
    '<div class="value">' + m.address + '</div>' +
    '<div class="label">Chemin</div>' +
    '<div class="value">' + m.path + '</div>' +
    '<div class="label">Langue</div>' +
    '<div class="value">' + m.lang + '</div>' +
    '<div class="label">Mnémonique</div>' +
    '<div class="mnemonic">' + m.mnemonic + '</div>' +
    (m.passphrase ? '<div class="label">Passphrase</div><div class="value">' + m.passphrase + '</div>' : '') +
    '<div class="label">Clé privée (hex)</div>' +
    '<div class="value">' + m.privateKey + '</div>' +
    '<div class="label">Pubkey</div>' +
    '<div class="value">' + m.pubkey + '</div>' +
    '<div class="label">Trouvé le</div>' +
    '<div class="value">' + m.timestamp + '</div>';
  els.resultsList.appendChild(div);
}

els.exportBtn.addEventListener('click', async () => {
  if (state.matches.length === 0) return;
  const password = prompt('Mot de passe pour chiffrer l\'export (Argon2id + AES-256-GCM).\nVide = export en clair.');
  const data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    sessionId: state.sessionId,
    mode: state.currentMode,
    stats: state.stats,
    matches: state.matches
  };
  let blob, ext;
  if (password && password.length > 0) {
    if (passwordStrength(password) < 3) {
      if (!confirm('Mot de passe faible. Continuer ?')) return;
    }
    els.statusText.textContent = '🔐 Chiffrement Argon2id en cours (~1-2 sec)...';
    blob = await encryptExport(data, password);
    ext = 'hunter.enc.json';
  } else {
    blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    ext = 'hunter.json';
  }
  downloadBlob(blob, 'hunter-' + Date.now() + '.' + ext);
  els.statusText.textContent = '✅ Export terminé.';
});

els.importBtn.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const pwd = prompt('Mot de passe de déchiffrement :');
  if (!pwd) return;
  try {
    const data = await decryptExport(file, pwd);
    state.matches = data.matches || [];
    els.resultsList.innerHTML = '';
    state.matches.forEach(addResultToUI);
    els.resultsPanel.style.display = 'block';
    els.exportBtn.disabled = state.matches.length === 0;
    els.statusText.textContent = '✅ ' + state.matches.length + ' match(s) importé(s).';
  } catch (e) { alert('Échec : ' + e.message); }
});

els.simulateBtn.addEventListener('click', async () => {
  els.statusText.textContent = '🧪 Simulation en cours...';
  const wl = await getWordlist('en');
  const worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    if (e.data.type === 'simulationResult') {
      const results = e.data.results;
      const ok = results.filter(r => r.ok).length;
      const ko = results.length - ok;
      console.table(results);
      els.statusText.textContent = '🧪 Simulation : ' + ok + '/' + results.length + ' OK' + (ko ? ' — ' + ko + ' échec(s)' : '');
      worker.terminate();
    }
  };
  worker.postMessage({ type: 'setWordlist', lang: 'en', wordlist: wl });
  const mod = await import('./simulation.js');
  worker.postMessage({ type: 'runSimulation', payload: mod.TEST_VECTORS });
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

let saveTimer = null;
function scheduleFormSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await saveFormState(collectForm()); } catch (e) {}
  }, 500);
}

function collectForm() {
  return {
    mode: state.currentMode,
    pattern: els.mnemonicPattern.value,
    phraseLength: els.phraseLength.value,
    lang: els.wordlistLang.value,
    passphrases: els.passphraseList.value,
    paths: els.pathList.value,
    targets: els.targetsInput.value
  };
}

['mnemonicPattern','phraseLength','wordlistLang','passphraseList','pathList','targetsInput']
  .forEach(id => { const el = $(id); if (el) el.addEventListener('input', scheduleFormSave); });

async function bootServer() {
  state.server = new LocalServer();
  state.server.on((evt) => {
    if (evt.type === 'server-ready') els.serverStatus.textContent = '🌐 Serveur local actif';
    else if (evt.type === 'server-error') els.serverStatus.textContent = '⚠️ ' + evt.error;
    else if (evt.type === 'network') els.serverStatus.textContent = evt.online ? '🌐 En ligne' : '📴 Hors ligne';
    else if (evt.type === 'install-available') {
      els.installBtn.hidden = false;
      els.pwaHint.textContent = '✅ Installation disponible — cliquez sur « Installer ».';
    } else if (evt.type === 'installed') {
      els.installBtn.hidden = true;
      els.pwaHint.textContent = '✅ Application installée.';
    }
  });
  await state.server.start();
}

els.installBtn.addEventListener('click', async () => {
  if (state.server) await state.server.promptInstall();
});

els.purgeCacheBtn.addEventListener('click', async () => {
  if (!confirm('Purger le cache ? Les wordlists seront re-téléchargées.')) return;
  if (!state.server) return;
  const r = await state.server.purge();
  els.serverStatus.textContent = '🗑️ Cache purgé (' + (r && r.purged ? r.purged : 0) + ' entrées).';
});

async function tryResumeSession() {
  try {
    // 1. Restaurer le formulaire TOUJOURS
    const form = await loadFormState();
    if (form) {
      if (form.mode) {
        state.currentMode = form.mode;
        els.modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === form.mode));
        els.guidedPanel.style.display = form.mode === 'guided' ? 'block' : 'none';
        els.randomPanel.style.display = form.mode === 'random' ? 'block' : 'none';
      }
      if (form.pattern) els.mnemonicPattern.value = form.pattern;
      if (form.phraseLength) els.phraseLength.value = form.phraseLength;
      if (form.passphrases) els.passphraseList.value = form.passphrases;
      if (form.paths) els.pathList.value = form.paths;
      if (form.targets) els.targetsInput.value = form.targets;
    }

    // 2. Reprendre une session interrompue si elle existe
    const last = await getLastSession();
    if (last && last.status === 'running') {
      state.sessionId = last.id;
      state.stats = Object.assign({}, last.stats, { startTime: Date.now() });
      els.statusText.textContent = '⏪ Session restaurée (' +
        last.stats.candidates.toLocaleString() + ' candidats).';
    } else if (form) {
      els.statusText.textContent = '✅ Formulaire restauré. Prêt à démarrer.';
    }
  } catch (e) {
    console.warn('[Resume] Erreur:', e);
  }
}
  populateLanguageSelects();
  await bootServer();
  await initWordlists();
  await tryResumeSession();
  scheduleFormSave();
})();(async function boot() {
  populateLanguageSelects();
  await requestPersistentStorage();
  await bootServer();
  await initWordlists();
  await tryResumeSession();
  scheduleFormSave();
})();
