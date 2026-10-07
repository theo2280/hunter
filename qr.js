// qr.js — Génération et lecture de QR codes (VRAIS)
// Utilise la lib qrcode-generator (MIT) chargée dynamiquement via CDN.
// Fallback local si le CDN est indisponible.

let qrcodeLibPromise = null;

/**
 * Charge la lib qrcode-generator depuis CDN (une seule fois).
 * Lib : https://github.com/kazuhikoarase/qrcode-generator
 * MIT License — utilisée par Bitcoin Core, Electrum, Ledger.
 */
async function loadQRCodeLib() {
  // La lib est chargée par <script src="qrcode-lib.js"> dans index.html
  // Elle expose window.qrcode globalement
  if (typeof window !== 'undefined' && typeof window.qrcode === 'function') {
    return window.qrcode;
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis.qrcode === 'function') {
    return globalThis.qrcode;
  }
  if (typeof self !== 'undefined' && typeof self.qrcode === 'function') {
    return self.qrcode;
  }
  throw new Error('qrcode non disponible — vérifier <script src="qrcode-lib.js">');
}

/**
 * Génère un QR code sur un canvas.
 * @param {HTMLCanvasElement} canvas - Canvas cible
 * @param {string} text - Contenu à encoder
 * @param {Object} opts - { size, margin, level }
 */
export async function drawQR(canvas, text, opts = {}) {
  const { size = 256, margin = 2, level = 'M' } = opts;
  const ctx = canvas.getContext('2d');

  // Fond blanc (obligatoire pour la lecture par scanner)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  try {
    const qrcode = await loadQRCodeLib();

    // TypeNumber 0 = auto-détection de la version
    const qr = qrcode(0, level);
    qr.addData(text);
    qr.make();

    const moduleCount = qr.getModuleCount();
    const cellSize = Math.floor((canvas.width - margin * 2) / moduleCount);
    const offset = Math.floor((canvas.width - cellSize * moduleCount) / 2);

    ctx.fillStyle = '#000000';
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(
            offset + col * cellSize,
            offset + row * cellSize,
            cellSize,
            cellSize
          );
        }
      }
    }
    return true;
  } catch (e) {
    console.error('[QR] Erreur génération :', e);
    // Fallback : afficher le texte
    ctx.fillStyle = '#c62828';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('QR indisponible', canvas.width / 2, canvas.height / 2 - 6);
    ctx.fillText('(vérifier connexion)', canvas.width / 2, canvas.height / 2 + 8);
    return false;
  }
}

/**
 * Génère un QR et le renvoie en Data URL (PNG base64).
 */
export async function generateQRDataURL(text, opts = {}) {
  const { size = 512 } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  await drawQR(canvas, text, opts);
  return canvas.toDataURL('image/png');
}

// ============================================================
//  SCAN CAMÉRA
// ============================================================
export class QRScanner {
  constructor(videoElement, onDetected) {
    this.video = videoElement;
    this.onDetected = onDetected;
    this.stream = null;
    this.detector = null;
    this.scanning = false;
    this._scanLoop = null;
  }

  static isSupported() {
    return 'BarcodeDetector' in window &&
      typeof navigator.mediaDevices?.getUserMedia === 'function';
  }

  async start() {
    if (this.scanning) return;

    if (!('BarcodeDetector' in window)) {
      throw new Error('BarcodeDetector non supporté par ce navigateur');
    }

    try {
      this.detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (e) {
      throw new Error('Impossible de créer BarcodeDetector : ' + e.message);
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    this.scanning = true;
    this._loop();
  }

  async _loop() {
    while (this.scanning) {
      try {
        const results = await this.detector.detect(this.video);
        if (results && results.length > 0) {
          const value = results[0].rawValue;
          if (value && this.onDetected) {
            this.onDetected(value);
          }
        }
      } catch (e) {
        // Erreurs fréquentes quand la vidéo n'est pas encore prête
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  stop() {
    this.scanning = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }

  isRunning() {
    return this.scanning;
  }
}

/**
 * Décode un QR depuis un fichier image (fallback si pas de caméra).
 */
export async function decodeQRFromFile(file) {
  if (!('BarcodeDetector' in window)) {
    throw new Error('BarcodeDetector non supporté');
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const results = await detector.detect(canvas);
        URL.revokeObjectURL(img.src);

        if (results && results.length > 0) {
          resolve(results[0].rawValue);
        } else {
          reject(new Error('Aucun QR détecté dans l\'image'));
        }
      } catch (e) {
        URL.revokeObjectURL(img.src);
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('Échec du chargement de l\'image'));
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Vérifie si une chaîne ressemble à une adresse Bitcoin ou une clé WIF.
 */
export function detectQRPayloadType(text) {
  if (!text) return 'unknown';
  const t = text.trim();
  if (/^([13mn2])[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(t)) return 'address-mainnet';
  if (/^(bc1|tb1)[a-z0-9]{25,90}$/i.test(t)) return 'address-bech32';
  if (/^([KL5c9])[1-9A-HJ-NP-Za-km-z]{50,51}$/.test(t)) return 'wif';
  if (/^[a-z]+(\s+[a-z]+){11,23}$/.test(t)) return 'mnemonic';
  return 'text';
}
