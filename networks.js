// networks.js — Configuration des réseaux Bitcoin
export const NETWORKS = {
  mainnet: {
    label: 'Mainnet',
    p2pkh: 0x00,
    p2sh: 0x05,
    bech32: 'bc',
    coinType: 0,
    addressPrefixes: { p2pkh: /^1/, p2sh: /^3/, bech32: /^bc1/i }
  },
  testnet: {
    label: 'Testnet',
    p2pkh: 0x6f,
    p2sh: 0xc4,
    bech32: 'tb',
    coinType: 1,
    addressPrefixes: { p2pkh: /^[mn]/, p2sh: /^2/, bech32: /^tb1/i }
  }
};

export function detectNetwork(address) {
  const a = address.trim();
  if (/^bc1/i.test(a) || /^1/.test(a) || /^3/.test(a)) return 'mainnet';
  if (/^tb1/i.test(a) || /^[mn]/.test(a) || /^2/.test(a)) return 'testnet';
  return null;
}

export function detectAddressType(address, network = 'mainnet') {
  const n = NETWORKS[network];
  if (!n) return null;
  const a = address.trim();
  if (n.addressPrefixes.bech32.test(a)) return 'P2WPKH';
  if (n.addressPrefixes.p2sh.test(a)) return 'P2SH';
  if (n.addressPrefixes.p2pkh.test(a)) return 'P2PKH';
  return null;
}
