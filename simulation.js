// simulation.js — Mode simulation : validation chaîne complète
export const TEST_VECTORS = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  passphrase: '',
  expected: {
    mainnet: {
      "m/44'/0'/0'/0/0": { type: 'P2PKH', address: '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA' },
      "m/49'/0'/0'/0/0": { type: 'P2SH',  address: '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf' },
      "m/84'/0'/0'/0/0": { type: 'P2WPKH', address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' }
    },
    testnet: {
      "m/44'/1'/0'/0/0": { type: 'P2PKH', address: 'mkpZhYtJu2r87Js3pDiWJDmPte2NRZ8bJV' },
      "m/49'/1'/0'/0/0": { type: 'P2SH',  address: '2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2' },
      "m/84'/1'/0'/0/0": { type: 'P2WPKH', address: 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl' }
    }
  }
};
