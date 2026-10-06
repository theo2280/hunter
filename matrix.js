// matrix.js — Matrice 16×16 interactive de visualisation des 256 bits
// Innovation originale : matrice cliquable + rotations + pulse randomizer

export class BitMatrix {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    if (!this.container) throw new Error('Container introuvable : ' + containerId);
    this.size = 16;          // 16×16 = 256 bits
    this.total = 256;
    this.bits = new Uint8Array(this.total);
    this.onChange = options.onChange || (() => {});
    this.pulseInterval = null;
    this.pulseSpeed = 250;   // ms entre chaque mutation
    this._initGrid();
  }

  // ============================================================
  //  GRILLE
  // ============================================================
  _initGrid() {
    this.container.innerHTML = '';
    const fragment = document.createDocumentFragment();
    this.cells = [];

    for (let i = 0; i < this.total; i++) {
      const cell = document.createElement('div');
      cell.className = 'bit';
      cell.dataset.index = i;
      cell.setAttribute('role', 'button');
      cell.setAttribute('tabindex', '0');
      cell.addEventListener('click', () => this.toggle(i));
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.toggle(i);
        }
      });
      fragment.appendChild(cell);
      this.cells.push(cell);
    }

    this.container.appendChild(fragment);
  }

  _refreshCell(i) {
    const cell = this.cells[i];
    if (!cell) return;
    cell.classList.toggle('on', this.bits[i] === 1);
  }

  _refreshAll() {
    for (let i = 0; i < this.total; i++) this._refreshCell(i);
  }

  // ============================================================
  //  MANIPULATION DES BITS
  // ============================================================
  toggle(index) {
    this.bits[index] ^= 1;
    this._refreshCell(index);
    this._notify();
  }

  setBits(bitsArray) {
    if (bitsArray.length !== this.total) {
      throw new Error('Taille invalide : ' + bitsArray.length + ' (attendu 256)');
    }
    this.bits = Uint8Array.from(bitsArray);
    this._refreshAll();
    this._notify();
  }

  clear() {
    this.bits.fill(0);
    this._refreshAll();
    this._notify();
  }

  // ============================================================
  //  ROTATIONS (W/A/S/D)
  // ============================================================
  rotateRowsLeft() {
    const s = this.size;
    for (let r = 0; r < s; r++) {
      const first = this.bits[r * s];
      for (let c = 0; c < s - 1; c++) {
        this.bits[r * s + c] = this.bits[r * s + c + 1];
      }
      this.bits[r * s + s - 1] = first;
    }
    this._refreshAll();
    this._notify();
  }

  rotateRowsRight() {
    const s = this.size;
    for (let r = 0; r < s; r++) {
      const last = this.bits[r * s + s - 1];
      for (let c = s - 1; c > 0; c--) {
        this.bits[r * s + c] = this.bits[r * s + c - 1];
      }
      this.bits[r * s] = last;
    }
    this._refreshAll();
    this._notify();
  }

  rotateColsUp() {
    const s = this.size;
    for (let c = 0; c < s; c++) {
      const first = this.bits[c];
      for (let r = 0; r < s - 1; r++) {
        this.bits[r * s + c] = this.bits[(r + 1) * s + c];
      }
      this.bits[(s - 1) * s + c] = first;
    }
    this._refreshAll();
    this._notify();
  }

  rotateColsDown() {
    const s = this.size;
    for (let c = 0; c < s; c++) {
      const last = this.bits[(s - 1) * s + c];
      for (let r = s - 1; r > 0; r--) {
        this.bits[r * s + c] = this.bits[(r - 1) * s + c];
      }
      this.bits[c] = last;
    }
    this._refreshAll();
    this._notify();
  }

  // ============================================================
  //  PULSE RANDOMIZER (avec crypto.getRandomValues sécurisé)
  // ============================================================
  startPulse(bitCount = 4) {
    if (this.pulseInterval) return;
    this._pulseBitCount = bitCount;
    this.pulseInterval = setInterval(() => {
      const randomIndices = this._randomIndices(this._pulseBitCount);
      for (const idx of randomIndices) {
        this.bits[idx] ^= 1;
      }
      this._refreshAll();
      this._notify();
    }, this.pulseSpeed);
  }

  stopPulse() {
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
  }

  isPulsing() {
    return this.pulseInterval !== null;
  }

  _randomIndices(count) {
    // Utilise crypto.getRandomValues pour éviter Math.random non-sûr
    const buf = new Uint16Array(count);
    crypto.getRandomValues(buf);
    const indices = new Set();
    while (indices.size < count) {
      crypto.getRandomValues(buf);
      for (const v of buf) {
        indices.add(v % this.total);
        if (indices.size >= count) break;
      }
    }
    return [...indices];
  }

  // ============================================================
  //  CONVERSION BITS ↔ BYTES
  // ============================================================
  toBytes() {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) {
        b = (b << 1) | this.bits[i * 8 + j];
      }
      out[i] = b;
    }
    return out;
  }

  fromBytes(bytes) {
    if (bytes.length !== 32) throw new Error('32 octets requis');
    for (let i = 0; i < 32; i++) {
      const byte = bytes[i];
      for (let j = 0; j < 8; j++) {
        this.bits[i * 8 + j] = (byte >> (7 - j)) & 1;
      }
    }
    this._refreshAll();
    this._notify();
  }

  // ============================================================
  //  VALIDATION CLÉ PRIVÉE SECP256K1
  // ============================================================
  isValidPrivateKey() {
    const bytes = this.toBytes();
    // Tous les octets doivent être cohérents
    let allZero = true;
    for (const b of bytes) if (b !== 0) { allZero = false; break; }
    if (allZero) return false;

    // Vérifier que d < N (ordre de courbe secp256k1)
    const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const d = BigInt('0x' + hex);
    return d > 0n && d < N;
  }

  // ============================================================
  //  NOTIFICATION
  // ============================================================
  _notify() {
    this.onChange({
      bits: this.bits.slice(),
      bytes: this.toBytes(),
      valid: this.isValidPrivateKey()
    });
  }
}
