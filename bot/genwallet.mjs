// Generator portfela dla bota. Odpalasz TYLKO lokalnie u siebie:
//   cd bot && npm install && node genwallet.mjs
//
// Klucz prywatny wypisuje sie na ekran i nigdzie go nie zapisuje.
// Skopiuj go do GitHub -> Settings -> Secrets and variables -> Actions -> New repository secret
// pod nazwa SOLANA_PRIVATE_KEY. Nigdy nie wklejaj go do plikow w repo.

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();

console.log('');
console.log('  ADRES PORTFELA (publiczny, mozesz go wklejac gdziekolwiek):');
console.log('  ' + kp.publicKey.toBase58());
console.log('');
console.log('  KLUCZ PRYWATNY (base58) — SEKRET, do GitHub Secrets jako SOLANA_PRIVATE_KEY:');
console.log('  ' + bs58.encode(kp.secretKey));
console.log('');
console.log('  Ten klucz = pelna kontrola nad kasa na tym adresie.');
console.log('  Zapisz go w menedzerze hasel, wyczysc historie terminala, nie wysylaj nikomu.');
console.log('');
