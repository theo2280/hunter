// storage.js — Persistance IndexedDB
const DB_NAME = 'hunter-db';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
const STORE_MATCHES = 'matches';
const STORE_CONFIG = 'config';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const s = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
      }
      if (!db.objectStoreNames.contains(STORE_MATCHES)) {
        const m = db.createObjectStore(STORE_MATCHES, { keyPath: 'id', autoIncrement: true });
        m.createIndex('sessionId', 'sessionId');
        m.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

export async function startSession(config) {
  const session = {
    id: 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    config,
    stats: { candidates: 0, addresses: 0, matches: 0 }
  };
  await tx(STORE_SESSIONS, 'readwrite', (s) => s.put(session));
  await setConfig('lastSessionId', session.id);
  return session;
}

export async function updateSession(sessionId, patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SESSIONS, 'readwrite');
    const store = t.objectStore(STORE_SESSIONS);
    const req = store.get(sessionId);
    req.onsuccess = () => {
      const existing = req.result;
      if (!existing) { resolve(null); return; }
      Object.assign(existing, patch, { updatedAt: Date.now() });
      store.put(existing);
    };
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

export async function endSession(sessionId, status = 'stopped') {
  return updateSession(sessionId, { status, endedAt: Date.now() });
}

export async function getLastSession() {
  const id = await getConfig('lastSessionId');
  if (!id) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SESSIONS, 'readonly');
    const req = t.objectStore(STORE_SESSIONS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listSessions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SESSIONS, 'readonly');
    const req = t.objectStore(STORE_SESSIONS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMatch(sessionId, match) {
  const record = Object.assign({}, match, { sessionId, savedAt: Date.now() });
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_MATCHES, 'readwrite');
    const req = t.objectStore(STORE_MATCHES).add(record);
    req.onsuccess = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

export async function getMatches(sessionId = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_MATCHES, 'readonly');
    const store = t.objectStore(STORE_MATCHES);
    const req = sessionId ? store.index('sessionId').getAll(sessionId) : store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function clearMatches(sessionId = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_MATCHES, 'readwrite');
    const store = t.objectStore(STORE_MATCHES);
    if (sessionId) {
      const idx = store.index('sessionId');
      const req = idx.openCursor(sessionId);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    } else {
      store.clear();
    }
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

export async function setConfig(key, value) {
  return tx(STORE_CONFIG, 'readwrite', (s) => s.put({ key, value }));
}

export async function getConfig(key, fallback = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_CONFIG, 'readonly');
    const req = t.objectStore(STORE_CONFIG).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
    req.onerror = () => reject(req.error);
  });
}

export async function saveFormState(formState) { return setConfig('formState', formState); }
export async function loadFormState() { return getConfig('formState', null); }
