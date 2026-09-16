import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const k = Keypair.generate();
console.log('Address:', k.publicKey.toBase58());
console.log('Secret key (paste into .env on your server only, never share it):');
console.log(bs58.encode(k.secretKey));
