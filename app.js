// app.js — Hunter v8 : version simplifiée, non bloquante, robuste
import { getWordlist, WORDLIST_META } from './bip39-fr.js';
import { encryptExport, decryptExport, passwordStrength } from './crypto-export.js';
import { BitMatrix } from './matrix.js';
import { drawQR, QRScanner, decodeQRFromFile, detectQRPayloadType } from './qr.js';
import { fetchBalanceWithFallback, fetchBalancesParallel, formatBTC, balanceState, clearBalanceCache } from './balance.js';
import { deriveAddresses } from './secp-direct.js';

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
      const matrix = $('matrixPanel');

      if (guided) guided.style.display = state.currentMode === 'guided' ? 'block' : 'none';
      if (random) random.style.display = state.currentMode === 'random' ? 'block' : 'none';
      if (matrix) matrix.style.display = state.currentMode === 'matrix' ? 'block' : 'none';

      if (state.currentMode === 'matrix' && !window._matrixInitialized) {
        window._matrixInitialized = true;
        if (typeof initMatrixModule === 'function') {
          initMatrixModule().catch(e => console.warn('[Matrix] init:', e));
        }
      }
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

// ============================================================
//  MODULE MATRICE (initMatrixModule)
// ============================================================
let _bitMatrix = null;
let _qrScanner = null;
let _matrixDeriving = false;

async function initMatrixModule() {
  console.log('[Matrix] Initialisation...');

  // ============================================================
  //  1. Instancier la matrice
  // ============================================================
  const container = $('bitMatrix');
  if (!container) { console.warn('[Matrix] #bitMatrix introuvable'); return; }

  _bitMatrix = new BitMatrix('bitMatrix', {
    onChange: (evt) => {
      updateMatrixDisplays(evt.bytes, evt.valid);
    }
  });

  // État initial : clé vide
  updateMatrixDisplays(new Uint8Array(32), false);

  // ============================================================
  //  2. Boutons de contrôle
  // ============================================================
  const safeBind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };

  // Effacer
  safeBind('matrixClr', () => {
    _bitMatrix.clear();
    setStatus('Matrice effacée.');
  });

  // Aléatoire sûr
  safeBind('matrixRand', () => {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    _bitMatrix.fromBytes(buf);
    setStatus('Clé aléatoire cryptographiquement sûre générée.');
  });

  // Pulse
  safeBind('matrixPulse', () => {
    const btn = $('matrixPulse');
    const warn = $('matrixWarning');
    if (_bitMatrix.isPulsing()) {
      _bitMatrix.stopPulse();
      if (btn) btn.textContent = '💓 Pulse';
      if (warn) warn.style.display = 'none';
      setStatus('Pulse arrêté.');
    } else {
      _bitMatrix.startPulse(4);
      if (btn) btn.textContent = '⏸️ Stop Pulse';
      if (warn) warn.style.display = 'block';
      setStatus('Pulse actif (⚠️ non sécurisé pour du vrai usage).');
    }
  });

  // Rotations
  safeBind('matrixLeft', () => _bitMatrix.rotateRowsLeft());
  safeBind('matrixRight', () => _bitMatrix.rotateRowsRight());
  safeBind('matrixUp', () => _bitMatrix.rotateColsUp());
  safeBind('matrixDown', () => _bitMatrix.rotateColsDown());

  // Clavier global (quand on est sur l'onglet matrice)
  document.addEventListener('keydown', (e) => {
    if (state.currentMode !== 'matrix') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const key = e.key.toLowerCase();
    if (key === 'a' || key === 'arrowleft')  { _bitMatrix.rotateRowsLeft();  e.preventDefault(); }
    if (key === 'd' || key === 'arrowright') { _bitMatrix.rotateRowsRight(); e.preventDefault(); }
    if (key === 'w' || key === 'arrowup')    { _bitMatrix.rotateColsUp();    e.preventDefault(); }
    if (key === 's' || key === 'arrowdown')  { _bitMatrix.rotateColsDown();  e.preventDefault(); }
  });

  // WIF masqué
  const wifEl = $('matrixWif');
  if (wifEl) {
    wifEl.addEventListener('click', () => wifEl.classList.toggle('revealed'));
  }
  safeBind('matrixWifToggle', () => {
    const w = $('matrixWif');
    if (w) w.classList.toggle('revealed');
  });

  // ============================================================
  //  3. QR Code
  // ============================================================
  const qrCanvas = $('qrCanvas');
  const qrText = $('qrText');
  const qrResult = $('qrResult');

    safeBind('qrGenBtn', async () => {
    // Priorité : champ qrText > adresse P2PKH > Bech32 > WIF
    let text = (qrText?.value || '').trim();
    if (!text) {
      const p2pkh = $('matrixAddrP2PKHc')?.textContent?.trim();
      const bech32 = $('matrixAddrBech32')?.textContent?.trim();
      const wif = $('matrixWif')?.textContent?.trim();
      text = (p2pkh && p2pkh !== '—') ? p2pkh
           : (bech32 && bech32 !== '—') ? bech32
           : (wif && wif !== '—') ? wif
           : '';
    }
    if (!text) {
      if (qrResult) qrResult.textContent = '❌ Rien à encoder (champ vide + aucune adresse générée)';
      return;
    }
    if (qrResult) qrResult.textContent = 'Génération...';
    try {
      const ok = await drawQR(qrCanvas, text, { size: 256, margin: 2, level: 'M' });
      if (qrResult) qrResult.textContent = ok
        ? '✅ QR généré : ' + text.slice(0, 30) + (text.length > 30 ? '...' : '')
        : '❌ Échec de génération';
    } catch (e) {
      if (qrResult) qrResult.textContent = '❌ Erreur : ' + e.message;
    }
  });

  safeBind('qrScanBtn', async () => {
    if (!QRScanner.isSupported()) {
      if (qrResult) qrResult.textContent = '⚠️ Scan caméra non supporté par ce navigateur.';
      return;
    }
    const video = $('camPreview');
    const stopBtn = $('qrStopBtn');
    const scanBtn = $('qrScanBtn');
    try {
      if (video) video.style.display = 'block';
      if (stopBtn) stopBtn.style.display = 'inline-block';
      if (scanBtn) scanBtn.disabled = true;
      if (qrResult) qrResult.textContent = '📷 Caméra active — visez un QR...';

      _qrScanner = new QRScanner(video, (value) => {
        handleScannedQR(value);
      });
      await _qrScanner.start();
    } catch (e) {
      if (qrResult) qrResult.textContent = '❌ Caméra indisponible : ' + e.message;
    }
  });

  safeBind('qrStopBtn', () => {
    if (_qrScanner) { _qrScanner.stop(); _qrScanner = null; }
    const video = $('camPreview');
    if (video) video.style.display = 'none';
    const stopBtn = $('qrStopBtn');
    if (stopBtn) stopBtn.style.display = 'none';
    const scanBtn = $('qrScanBtn');
    if (scanBtn) scanBtn.disabled = false;
    if (qrResult) qrResult.textContent = 'Caméra arrêtée.';
  });

  safeBind('qrFileBtn', () => { const f = $('qrFile'); if (f) f.click(); });
  const qrFile = $('qrFile');
  if (qrFile) {
    qrFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const value = await decodeQRFromFile(file);
        handleScannedQR(value);
      } catch (err) {
        if (qrResult) qrResult.textContent = '❌ ' + err.message;
      }
    });
  }

  // ============================================================
  //  4. Balance check
  // ============================================================
  safeBind('btnCheckBalances', async () => {
    const offline = $('offlineToggle')?.checked;
    if (offline) { setStatus('🔒 Mode offline actif — désactivez-le pour vérifier les soldes.'); return; }

    const api = $('apiSelect')?.value || 'mempool';
    const addrs = [
      { key: 'P2PKHc', addr: $('matrixAddrP2PKHc')?.textContent },
      { key: 'P2PKHu', addr: $('matrixAddrP2PKHu')?.textContent },
      { key: 'P2SH',   addr: $('matrixAddrP2SH')?.textContent },
      { key: 'Bech32', addr: $('matrixAddrBech32')?.textContent }
    ];

    setStatus('💰 Vérification des soldes...');
    clearBalanceCache();

    const results = await fetchBalancesParallel(addrs.map(a => a.addr), {
      primary: api,
      fallback: api === 'mempool' ? 'blockchair' : 'mempool'
    });

    addrs.forEach((a, i) => {
      const balEl = $('matrixBal' + a.key);
      const rowEl = $('matrixRow' + a.key);
      if (!balEl || !rowEl) return;
      const r = results[i];
      const st = balanceState(r);
      rowEl.classList.remove('funded', 'error');
      if (st === 'error') {
        balEl.textContent = '—';
        rowEl.classList.add('error');
      } else {
        balEl.textContent = formatBTC(r.balance);
        if (st === 'funded') rowEl.classList.add('funded');
      }
    });
    setStatus('✅ Soldes vérifiés.');
  });

  // ============================================================
  //  5. Copie rapide (tap)
  // ============================================================
  ['matrixAddrP2PKHc', 'matrixAddrP2PKHu', 'matrixAddrP2SH', 'matrixAddrBech32', 'matrixWif'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', () => {
      const txt = el.textContent;
      if (!txt || txt === '—') return;
      navigator.clipboard.writeText(txt)
        .then(() => setStatus('✅ Copié : ' + txt.slice(0, 20) + '...'))
        .catch(() => setStatus('❌ Échec copie'));
    });
  });

  console.log('[Matrix] ✅ Initialisation complète');
}

// ============================================================
//  HANDLERS INTERNES DU MODULE MATRIX
// ============================================================
async function updateMatrixDisplays(privKeyBytes, valid) {
  // 1. Indicateur de validité
  const validIcon = $('matrixValidIcon');
  if (validIcon) {
    validIcon.textContent = valid ? '✅ Valide' : '❌ Invalide (0 ou ≥ ordre N)';
    validIcon.style.color = valid ? 'var(--success)' : 'var(--danger)';
  }

  // 2. HEX
  const hex = Array.from(privKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const hexEl = $('matrixHex');
  if (hexEl) hexEl.textContent = hex || '—';

  // 3. WIF + adresses : nécessite un worker
  if (!valid) {
    ['matrixWif', 'matrixAddrP2PKHc', 'matrixAddrP2PKHu', 'matrixAddrP2SH', 'matrixAddrBech32'].forEach(id => {
      const el = $(id);
      if (el) el.textContent = '—';
    });
    return;
  }

  // Éviter les dérivations concurrentes
  if (_matrixDeriving) return;
  _matrixDeriving = true;

  try {
    const result = await deriveAllAddressesFromMatrix(privKeyBytes);
    const wifEl = $('matrixWif');
    if (wifEl) wifEl.textContent = result.wif;

    const setAddr = (id, addr) => { const el = $(id); if (el) el.textContent = addr; };
    setAddr('matrixAddrP2PKHc', result.p2pkhC);
    setAddr('matrixAddrP2PKHu', result.p2pkhU);
    setAddr('matrixAddrP2SH', result.p2sh);
    setAddr('matrixAddrBech32', result.bech32);
  } catch (e) {
    console.warn('[Matrix] derive error:', e);
    setStatus('❌ Dérivation échouée : ' + e.message);
  } finally {
    _matrixDeriving = false;
  }
}

async function deriveAllAddressesFromMatrix(privKeyBytes) {
  // Dérivation directe dans le main thread — pas de worker
  const hex = Array.from(privKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  console.log('[Matrix] Derivation directe pour hex:', hex);

  try {
    const result = await deriveAddresses(privKeyBytes);
    console.log('[Matrix] Dérivation réussie');
    return result;
  } catch (e) {
    console.error('[Matrix] Erreur dérivation:', e);
    throw new Error('Dérivation échouée : ' + (e.message || 'inconnue'));
  }
}

function handleScannedQR(value) {
  const qrResult = $('qrResult');
  const type = detectQRPayloadType(value);
  if (qrResult) {
    qrResult.textContent = `✅ QR détecté (${type}) : ${value.slice(0, 60)}${value.length > 60 ? '...' : ''}`;
  }
  // Auto-remplir le champ QR
  const qrText = $('qrText');
  if (qrText) qrText.value = value;

  // Si c'est une adresse, la proposer comme cible
  if (type === 'address-mainnet' || type === 'address-bech32') {
    const targetsInput = $('targetsInput');
    if (targetsInput && !targetsInput.value.includes(value)) {
      targetsInput.value = (targetsInput.value + '\n' + value).trim();
      setStatus('📍 Adresse ajoutée aux cibles.');
    }
  }
}


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
