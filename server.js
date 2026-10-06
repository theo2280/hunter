// server.js — Client du Service Worker : état du serveur local + install PWA
export class LocalServer {
  constructor() {
    this.registration = null;
    this.ready = false;
    this.online = navigator.onLine;
    this.installPrompt = null;
    this._listeners = new Set();

    window.addEventListener('online', () => this._setOnline(true));
    window.addEventListener('offline', () => this._setOnline(false));

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e;
      this._emit({ type: 'install-available' });
    });

    window.addEventListener('appinstalled', () => {
      this.installPrompt = null;
      this._emit({ type: 'installed' });
    });
  }

  _setOnline(v) { this.online = v; this._emit({ type: 'network', online: v }); }
  _emit(evt) { for (const fn of this._listeners) fn(evt); }
  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  async start() {
    if (!('serviceWorker' in navigator)) {
      this._emit({ type: 'server-error', error: 'Service Worker non supporté' });
      return false;
    }
    try {
      this.registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      navigator.serviceWorker.addEventListener('message', (e) => {
        this._emit({ type: 'sw-message', data: e.data });
      });
      await this._waitForActivation();
      this.ready = true;
      this._emit({ type: 'server-ready', scope: this.registration.scope });
      return true;
    } catch (err) {
      this._emit({ type: 'server-error', error: err.message });
      return false;
    }
  }

  async _waitForActivation() {
    if (this.registration.active) return;
    const sw = this.registration.installing || this.registration.waiting;
    if (!sw) return;
    return new Promise((resolve) => {
      sw.addEventListener('statechange', () => {
        if (sw.state === 'activated') resolve();
      });
    });
  }

  async promptInstall() {
    if (!this.installPrompt) return false;
    this.installPrompt.prompt();
    const { outcome } = await this.installPrompt.userChoice;
    this.installPrompt = null;
    return outcome === 'accepted';
  }

  async status() {
    if (!navigator.serviceWorker.controller) return { ready: false };
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data);
      navigator.serviceWorker.controller.postMessage({ type: 'CACHE_STATUS' }, [ch.port2]);
      setTimeout(() => resolve({ ready: false, timeout: true }), 3000);
    });
  }

  async precacheWordlists() {
    if (!navigator.serviceWorker.controller) return;
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data);
      navigator.serviceWorker.controller.postMessage({ type: 'PRECACHE_WORDLISTS' }, [ch.port2]);
    });
  }

  async purge() {
    if (!navigator.serviceWorker.controller) return { purged: 0 };
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data);
      navigator.serviceWorker.controller.postMessage({ type: 'PURGE_CACHE' }, [ch.port2]);
    });
  }
}
