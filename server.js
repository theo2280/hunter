// server.js — Client du Service Worker : NON BLOQUANT
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
      this._emit({ type: 'server-error', error: 'SW non supporté' });
      return false;
    }
    try {
      this.registration = await Promise.race([
        navigator.serviceWorker.register('./sw.js', { scope: './' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('register timeout')), 5000))
      ]);
      navigator.serviceWorker.addEventListener('message', (e) => {
        this._emit({ type: 'sw-message', data: e.data });
      });

      // Attendre l'activation — 3s max
      await Promise.race([
        this._waitForActivation(),
        new Promise(r => setTimeout(r, 3000))
      ]);

      this.ready = true;
      this._emit({ type: 'server-ready', scope: this.registration.scope });
      return true;
    } catch (err) {
      console.warn('[Server] SW échec:', err.message);
      this.ready = true;
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

  async purge() {
    if (!navigator.serviceWorker.controller) return { purged: 0 };
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data);
      navigator.serviceWorker.controller.postMessage({ type: 'PURGE_CACHE' }, [ch.port2]);
      setTimeout(() => resolve({ purged: 0 }), 2000);
    });
  }
}
