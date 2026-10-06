// app.js — Hunter v8 : version simplifiée, non bloquante, robuste
import { getWordlist, WORDLIST_META } from './bip39-fr.js';
import { encryptExport, decryptExport, passwordStrength } from './crypto-export.js';

// ============================================================
//  ÉTAT
// ============================================================
const state = {
  workers: [],
  targets: new Set(),
  matches: [],
  isRunning: false,
  stats: { candidates: 0, addresses: 0, matches: 0, startTime: 0 },
  currentMode: 'guided',
  reportInterval: null,
  exhaustedCount: 0,
  sessionId: null
};

// ============================================================
//  DOM HELPERS
// ============================================================
const $ = id => document.getElementById(id);
const setStatus = (txt) => { const el = $('statusText'); if (el) el.textContent = txt; };
const setServerStatus = (txt) => { const el = $('serverStatus'); if (el) el.textContent = txt; };
const setWordlistStatus = (txt) => { const el = $('wordlistStatus'); if (el) el.textContent = txt; };

// ============================================================
//  INITIALISATION UI — SYNCHRONE, IMMÉDIATE
// ============================================================
function initUI() {
  // Peupler les sélecteurs de langue
  const langSelects = [$('wordlistLang'), $('randomLang')];
  for (const sel of langSelects) {
    if (!sel) continue;
    sel.innerHTML = '';
    for (const [code, meta] of Object.entries(WORDLIST_META)) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = (meta.flag || '') + ' ' + meta.label;
      sel.appendChild(opt);
    }
    sel.value = 'en';
  }

  // Statuts initiaux
  setServerStatus('🌐 Prêt (mode local)');
  setWordlistStatus('⏳ Chargement des wordlists...');
  setStatus('Prêt. Chargez des cibles puis démarrez.');

  // Vérifier le SW en arrière-plan (NE BLOQUE PAS)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration('./').then(reg => {
      if (reg && reg.active) {
        setServerStatus('🌐 Serveur local actif');
      } else {
        setServerStatus('🌐 Prêt (mode local)');
      }
    }).catch(() => {
      setServerStatus('🌐 Prêt (mode local)');
    });
  } else {
    setServerStatus('⚠️ SW non supporté');
  }
}

// ============================================================
//  CHARGEMENT WORDLISTS — EN ARRIÈRE-PLAN, NON BLOQUANT
// ============================================================
async function loadWordlists() {
  const langs = Object.keys(WORDLIST_META);
  let loaded = 0;

  // Charger en parallèle, sans bloquer sur échec
  const promises = langs.map(async (lang) => {
    try {
      await getWordlist(lang);
      loaded++;
      setWordlistStatus('⏳ ' + loaded + '/' + langs.length + ' wordlists...');
    } catch (e) {
      // Ignore silencieusement
    }
  });

  await Promise.allSettled(promises);

  if (loaded === langs.length) {
    setWordlistStatus('✅ ' + loaded + '/' + langs.length + ' wordlists chargées');
  } else if (loaded > 0) {
    setWordlistStatus('⚠️ ' + loaded + '/' + langs.length + ' wordlists (fallback possible)');
  } else {
    setWordlistStatus('⚠️ Wordlists indisponibles');
  }
}

// ============================================================
//  WORKERS
// ============================================================
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
    setStatus('⚠️ ' + msg.message);
  }
}

async function onMatch(match) {
  state.stats.matches++;
  state.matches.push(match);
  addResultToUI(match);
  updateUI();
  const exportBtn = $('exportBtn');
  if (exportBtn) exportBtn.disabled = false;
}

// ============================================================
//  DÉMARRAGE
// ============================================================
async function startHunt() {
  if (state.targets.size === 0) {
    alert('Chargez d\'abord des adresses cibles.');
    return;
  }

  const paths = ($('pathList')?.value || '').split('\n').map(l => l.trim()).filter(l => l.startsWith('m/'));
  const passphrases = ($('passphraseList')?.value || '').split('\n').map(p => p.trim()).filter(Boolean);
  const candidateLimit = parseInt($('candidateLimit')?.value) || 0;
  const indexRange = parseInt($('indexRange')?.value) || 10;
  const lang = state.currentMode === 'guided'
    ? ($('wordlistLang')?.value || 'en')
    : ($('randomLang')?.value || 'en');

  let config;
  if (state.currentMode === 'guided') {
    const pattern = ($('mnemonicPattern')?.value || '').trim();
    if (!pattern) { alert('Saisissez un pattern.'); return; }
    config = {
      mode: 'guided', pattern,
      phraseLength: parseInt($('phraseLength')?.value) || 24,
      lang, passphrases,
      paths: paths.length > 0 ? paths : ["m/44'/0'/0'/0/0"],
      indexRange, candidateLimit
    };
  } else {
    config = {
      mode: 'random',
      phraseLength: parseInt($('randomLength')?.value) || 24,
      lang, passphrases,
      paths: paths.length > 0 ? paths : ["m/44'/0'/0'/0/0"],
      indexRange, candidateLimit
    };
  }

  let wordlist;
  try {
    wordlist = await getWordlist(lang);
  } catch (e) {
    alert('Wordlist ' + lang + ' indisponible : ' + e.message);
    return;
  }

  const workerCount = parseInt($('workerCount')?.value) || 2;
  createWorkers(workerCount);
  state.isRunning = true;
  state.stats = { candidates: 0, addresses: 0, matches: 0, startTime: Date.now() };
  state.matches = [];

  if ($('resultsList')) $('resultsList').innerHTML = '';
  if ($('resultsPanel')) $('resultsPanel').style.display = 'none';
  if ($('exportBtn')) $('exportBtn').disabled = true;
  if ($('startBtn')) $('startBtn').disabled = true;
  if ($('stopBtn')) $('stopBtn').disabled = false;
  setStatus('Démarrage (' + workerCount + ' workers, ' + state.currentMode + ', ' + lang + ')...');

  const targetsArray = [...state.targets];
  for (const worker of state.workers) {
    worker.postMessage({ type: 'setWordlist', lang, wordlist });
    worker.postMessage({ type: 'setTargets', targets: targetsArray });
    worker.postMessage({ type: 'start', config });
  }

  if (state.reportInterval) clearInterval(state.reportInterval);
  state.reportInterval = setInterval(updateUI, 1000);
}

function stopAll(reason) {
  state.isRunning = false;
  for (const w of state.workers) w.postMessage({ type: 'stop' });
  if ($('startBtn')) $('startBtn').disabled = false;
  if ($('stopBtn')) $('stopBtn').disabled = true;
  if (state.reportInterval) clearInterval(state.reportInterval);
  setStatus(reason || 'Arrêté.');
  updateUI();
}

function updateUI() {
  const c = $('statCandidates'); if (c) c.textContent = state.stats.candidates.toLocaleString();
  const a = $('statAddresses'); if (a) a.textContent = state.stats.addresses.toLocaleString();
  const m = $('statMatches'); if (m) m.textContent = state.stats.matches;

  const elapsed = (Date.now() - state.stats.startTime) / 1000;
  const rate = elapsed > 0 ? Math.round(state.stats.addresses / elapsed) : 0;
  const r = $('statRate'); if (r) r.textContent = rate.toLocaleString();

  const limit = parseInt($('candidateLimit')?.value) || 0;
  const fill = $('progressFill');
  if (fill) {
    if (limit > 0) {
      fill.style.width = Math.min(100, (state.stats.candidates / limit) * 100) + '%';
    } else {
      fill.style.width = (state.isRunning ? 50 : 0) + '%';
    }
  }

  if (state.isRunning) {
    setStatus('En cours · ' + state.stats.candidates.toLocaleString() + ' candidats · ' +
      state.stats.addresses.toLocaleString() + ' adresses · ' +
      state.stats.matches + ' trouvée(s) · ~' + rate + '/s');
  }
}

function addResultToUI(m) {
  const panel = $('resultsPanel');
  const list = $('resultsList');
  if (!panel || !list) return;
  panel.style.display = 'block';
  const div = document.createElement('div');
  div.className = 'result-item';
  div.innerHTML =
    '<div class="label">Adresse (' + m.addressType + ' / ' + (m.network || 'mainnet') + ')</div>' +
    '<div class="value">' + m.address + '</div>' +
    '<div class="label">Chemin</div>' +
    '<div class="value">' + m.path + '</div>' +
    '<div class="label">Mnémonique</div>' +
    '<div class="mnemonic">' + m.mnemonic + '</div>' +
    (m.passphrase ? '<div class="label">Passphrase</div><div class="value">' + m.passphrase + '</div>' : '') +
    '<div class="label">Clé privée</div>' +
    '<div class="value">' + m.privateKey + '</div>';
  list.appendChild(div);
}

// ============================================================
//  CHARGEUR DE CIBLES
// ============================================================
function loadTargets() {
  const input = $('targetsInput');
  if (!input) return;
  const lines = input.value.split('\n');
  const set = new Set();
  for (const line of lines) {
    const a = line.trim();
    if (a && a.length > 20) set.add(a);
  }
  state.targets = set;
  const status = $('targetsStatus');
  if (status) status.textContent = set.size + ' adresse(s) chargée(s).';
  const startBtn = $('startBtn');
  if (startBtn) startBtn.disabled = set.size === 0;
  for (const w of state.workers) {
    w.postMessage({ type: 'setTargets', targets: [...set] });
  }
}

// ============================================================
//  EXPORT CHIFFRÉ
// ============================================================
async function exportData() {
  if (state.matches.length === 0) return;
  const password = prompt('Mot de passe pour chiffrer (vide = clair) :');
  const data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    stats: state.stats,
    matches: state.matches
  };
  let blob, ext;
  if (password && password.length > 0) {
    if (passwordStrength(password) < 3) {
      if (!confirm('Mot de passe faible. Continuer ?')) return;
    }
    setStatus('🔐 Chiffrement en cours...');
    blob = await encryptExport(data, password);
    ext = 'hunter.enc.json';
  } else {
    blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    ext = 'hunter.json';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'hunter-' + Date.now() + '.' + ext;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('✅ Export terminé.');
}

// ============================================================
//  SIMULATION
// ============================================================
async function runSimulation() {
  setStatus('🧪 Simulation en cours...');
  try {
    const wl = await getWordlist('en');
    const worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'simulationResult') {
        const results = e.data.results;
        const ok = results.filter(r => r.ok).length;
        console.table(results);
        setStatus('🧪 Simulation : ' + ok + '/' + results.length + ' OK');
        worker.terminate();
      }
    };
    worker.postMessage({ type: 'setWordlist', lang: 'en', wordlist: wl });
    const mod = await import('./simulation.js');
    worker.postMessage({ type: 'runSimulation', payload: mod.TEST_VECTORS });
  } catch (e) {
    setStatus('⚠️ Simulation échouée : ' + e.message);
  }
}

// ============================================================
//  MODE TABS
// ============================================================
function initModeTabs() {
  const tabs = document.querySelectorAll('.mode-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.currentMode = tab.dataset.mode || 'guided';
      const guided = $('guidedPanel');
      const random = $('randomPanel');
      if (guided) guided.style.display = state.currentMode === 'guided' ? 'block' : 'none';
      if (random) random.style.display = state.currentMode === 'random' ? 'block' : 'none';
    });
  });
}

// ============================================================
//  BINDING DES BOUTONS
// ============================================================
function bindEvents() {
  const safeBind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  safeBind('loadTargetsBtn', loadTargets);
  safeBind('startBtn', startHunt);
  safeBind('stopBtn', () => stopAll('⏹️ Arrêté.'));
  safeBind('exportBtn', exportData);
  safeBind('simulateBtn', runSimulation);
  safeBind('purgeCacheBtn', async () => {
    if (!confirm('Purger tous les caches ?')) return;
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'PURGE_CACHE' });
    }
    setStatus('🗑️ Purge demandée.');
  });
  safeBind('importBtn', () => { const f = $('importFile'); if (f) f.click(); });

  const importFile = $('importFile');
  if (importFile) {
    importFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const pwd = prompt('Mot de passe :');
      if (!pwd) return;
      try {
        const data = await decryptExport(file, pwd);
        state.matches = data.matches || [];
        const list = $('resultsList');
        const panel = $('resultsPanel');
        if (list) list.innerHTML = '';
        state.matches.forEach(addResultToUI);
        if (panel) panel.style.display = 'block';
        setStatus('✅ ' + state.matches.length + ' match(s) importé(s).');
      } catch (e) {
        alert('Erreur : ' + e.message);
      }
    });
  }
}

// ============================================================
//  BOOT
// ============================================================
(function boot() {
  console.log('[Hunter] Boot');

  // 1. UI immédiat (synchrone)
  initUI();
  initModeTabs();
  bindEvents();

  // 2. Wordlists en arrière-plan (asynchrone, non bloquant)
  loadWordlists().catch(e => console.warn('[Hunter] wordlists:', e));

  console.log('[Hunter] Boot terminé — UI prête');
})();
