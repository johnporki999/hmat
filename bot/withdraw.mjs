/**
 * HAJSOMAT — wyplata srodkow z portfela bota.
 *
 * Osobny skrypt i osobny workflow, odpalany WYLACZNIE recznie. Nigdy z crona:
 * automatyczne wysylanie pieniedzy poza portfel to nie jest cos, co ma sie dziac
 * samo.
 *
 * Adres docelowy siedzi w sekrecie WITHDRAW_ADDRESS — nie ma go w kodzie ani
 * w historii repo. Skrypt sprawdza go zanim cokolwiek wysle.
 *
 * Zabezpieczenia:
 *   - trzeba wpisac slowo potwierdzenia,
 *   - domyslnie dziala w trybie podgladu i niczego nie wysyla,
 *   - odmawia, gdy adres jest niepoprawny, wlasny albo nie jest zwyklym portfelem,
 *   - nigdy nie rusza rezerwy SOL na oplaty,
 *   - odmawia wyplaty calosci przy otwartych pozycjach.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';

const env = (k, d = '') => {
  const v = process.env[k];
  return v == null || String(v).trim() === '' ? d : String(v).trim();
};
const envBool = (k, d) => {
  const v = env(k).toLowerCase();
  if (!v) return d;
  return ['1', 'true', 'yes', 'y', 'on', 'tak'].includes(v);
};
const envNum = (k, d) => {
  const v = Number.parseFloat(env(k));
  return Number.isFinite(v) ? v : d;
};

const USDC = { mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), dec: 6 };
const CONFIRM_WORD = 'WYPLACAM';

const RPC_URL = env('RPC_URL', 'https://api.mainnet-beta.solana.com');
const PREVIEW = envBool('PREVIEW', true);
const AMOUNT = env('AMOUNT', 'all');
const INCLUDE_SOL = envBool('INCLUDE_SOL', false);
const ALLOW_OPEN = envBool('ALLOW_OPEN', false);
const FEE_RESERVE_SOL = envNum('FEE_RESERVE_SOL', 0.02);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(path.resolve(__dirname, '..'), 'state');
const F_STATE = path.join(STATE_DIR, 'state.json');
const F_TRADES = path.join(STATE_DIR, 'trades.json');

const LOG = [];
const log = (...a) => {
  const line = a.join(' ');
  LOG.push(line);
  console.log(line);
};
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJSON(f, d) {
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d;
  } catch {
    return d;
  }
}
function writeJSON(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main() {
  log(`=== WYPLATA ${new Date().toISOString()} ${PREVIEW ? '[PODGLAD]' : '[NA SERIO]'} ===`);

  // ── Potwierdzenie ─────────────────────────────────────────────────────────
  const confirm = env('CONFIRM');
  if (confirm !== CONFIRM_WORD) {
    throw new Error(
      `brak potwierdzenia — w polu confirm trzeba wpisac dokladnie ${CONFIRM_WORD} (bylo: "${confirm || 'puste'}")`
    );
  }

  // ── Klucze i adresy ───────────────────────────────────────────────────────
  const rawKey = env('SOLANA_PRIVATE_KEY');
  let keypair = null;
  if (rawKey) {
    try {
      keypair = rawKey.startsWith('[')
        ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey)))
        : Keypair.fromSecretKey(bs58.decode(rawKey));
    } catch (e) {
      throw new Error(`SOLANA_PRIVATE_KEY nie da sie sparsowac: ${e.message}`);
    }
  }
  const fromStr = keypair ? keypair.publicKey.toBase58() : env('WALLET_ADDRESS');
  if (!fromStr) throw new Error('nie znam portfela zrodlowego (SOLANA_PRIVATE_KEY albo WALLET_ADDRESS)');
  if (!keypair && !PREVIEW) throw new Error('bez SOLANA_PRIVATE_KEY moge tylko pokazac podglad');
  const from = new PublicKey(fromStr);

  const destStr = env('WITHDRAW_ADDRESS');
  if (!destStr) {
    throw new Error('brak sekretu WITHDRAW_ADDRESS — ustaw adres, na ktory maja isc pieniadze');
  }
  let dest;
  try {
    dest = new PublicKey(destStr);
  } catch {
    throw new Error('WITHDRAW_ADDRESS nie jest poprawnym adresem Solany');
  }
  if (dest.equals(from)) throw new Error('adres docelowy jest tym samym portfelem co zrodlowy');
  // Adres poza krzywa to PDA — nikt nie ma do niego klucza, pieniadze przepadaja.
  // Sama krzywa to za malo: minty i programy tez na niej leza, wiec nizej
  // sprawdzamy jeszcze, czym to konto naprawde jest.
  if (!PublicKey.isOnCurve(dest.toBytes())) {
    throw new Error('WITHDRAW_ADDRESS to adres PDA, nie portfel — nikt nie mialby do tych srodkow klucza');
  }
  log(`> z:  ${fromStr}`);
  log(`> na: ${destStr}`);

  // ── Stan bota ─────────────────────────────────────────────────────────────
  const state = readJSON(F_STATE, null);
  const open = state?.positions ? Object.keys(state.positions) : [];
  if (open.length) {
    log(`! uwaga: bot ma otwarte pozycje (${open.join(', ')}) — one zostaja w portfelu`);
    if (AMOUNT === 'all' && !ALLOW_OPEN) {
      throw new Error(
        'wyplata calosci przy otwartych pozycjach. Najpierw zamknij je: Actions -> Hajsomat — bot ' +
          '-> Run workflow -> force_sell. Albo zaznacz allow_open, jesli swiadomie zostawiasz pozycje.'
      );
    }
  }

  // ── Czy cel to na pewno portfel ───────────────────────────────────────────
  const conn = new Connection(RPC_URL, 'confirmed');
  const destInfoRaw = await conn.getAccountInfo(dest);
  if (destInfoRaw) {
    if (destInfoRaw.executable) {
      throw new Error('WITHDRAW_ADDRESS to adres programu, nie portfela — sprawdz go');
    }
    if (!destInfoRaw.owner.equals(SystemProgram.programId)) {
      throw new Error(
        `WITHDRAW_ADDRESS nie jest zwyklym portfelem (konto nalezy do ${destInfoRaw.owner.toBase58()}) — ` +
          'to wyglada na mint albo konto tokenowe, a nie na adres, z ktorego wyplacisz srodki'
      );
    }
    log('> cel: istniejacy portfel');
  } else {
    log('> cel: adres jeszcze nieuzywany (to normalne dla nowego portfela)');
  }

  // ── Salda ─────────────────────────────────────────────────────────────────
  const lamports = await conn.getBalance(from, 'confirmed');
  const sol = lamports / LAMPORTS_PER_SOL;

  const fromAta = await getAssociatedTokenAddress(USDC.mint, from);
  let usdcBal = 0;
  try {
    const b = await conn.getTokenAccountBalance(fromAta);
    usdcBal = b.value.uiAmount || 0;
  } catch {
    log('! portfel nie ma konta USDC');
  }
  log(`> saldo: ${sol.toFixed(4)} SOL + ${usd(usdcBal)} USDC`);

  // ── Ile wysylamy ──────────────────────────────────────────────────────────
  let sendUsdc;
  if (AMOUNT.toLowerCase() === 'all') {
    sendUsdc = usdcBal;
  } else {
    sendUsdc = Number.parseFloat(AMOUNT.replace(',', '.'));
    if (!Number.isFinite(sendUsdc) || sendUsdc <= 0) {
      throw new Error(`kwota "${AMOUNT}" jest nieprawidlowa — podaj liczbe albo slowo all`);
    }
    if (sendUsdc > usdcBal + 1e-9) {
      throw new Error(`chcesz wyplacic ${usd(sendUsdc)}, a w portfelu jest ${usd(usdcBal)}`);
    }
  }
  sendUsdc = Math.floor(sendUsdc * 10 ** USDC.dec) / 10 ** USDC.dec;

  const sendSol = INCLUDE_SOL ? Math.max(0, sol - FEE_RESERVE_SOL) : 0;
  if (INCLUDE_SOL && sendSol < 0.001) {
    log(`! po odjeciu rezerwy ${FEE_RESERVE_SOL} SOL nie ma czego wysylac — pomijam SOL`);
  }
  if (sendUsdc <= 0 && sendSol < 0.001) throw new Error('nie ma czego wyplacac');

  log(`> do wyslania: ${usd(sendUsdc)} USDC${sendSol >= 0.001 ? ` + ${sendSol.toFixed(4)} SOL` : ''}`);
  if (sendSol >= 0.001) {
    log(`  (w portfelu zostanie ${FEE_RESERVE_SOL} SOL na oplaty — bez tego bot przestanie handlowac)`);
  }

  if (PREVIEW) {
    log('');
    log('To byl tylko podglad — nic nie zostalo wyslane.');
    log('Zeby wyplacic naprawde, odpal workflow ponownie z odznaczonym "preview".');
    return { preview: true, sendUsdc, sendSol, dest: destStr };
  }

  // ── Wysylka ───────────────────────────────────────────────────────────────
  const ixs = [];
  if (sendUsdc > 0) {
    const destAta = await getAssociatedTokenAddress(USDC.mint, dest);
    const destInfo = await conn.getAccountInfo(destAta);
    if (!destInfo) {
      log('> adres docelowy nie ma jeszcze konta USDC — zakladam je (koszt ok. 0,002 SOL)');
      ixs.push(createAssociatedTokenAccountInstruction(from, destAta, dest, USDC.mint));
    }
    ixs.push(
      createTransferCheckedInstruction(
        fromAta,
        USDC.mint,
        destAta,
        from,
        BigInt(Math.round(sendUsdc * 10 ** USDC.dec)),
        USDC.dec,
        [],
        TOKEN_PROGRAM_ID
      )
    );
  }
  if (sendSol >= 0.001) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: dest,
        lamports: Math.floor(sendSol * LAMPORTS_PER_SOL),
      })
    );
  }

  const tx = new Transaction().add(...ixs);
  tx.feePayer = from;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(keypair);

  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(
      `symulacja nieudana: ${JSON.stringify(sim.value.err)} :: ${(sim.value.logs || []).slice(-3).join(' | ')}`
    );
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  log(`> wyslano ${sig}`);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  log(`> potwierdzone: https://solscan.io/tx/${sig}`);

  // ── Ksiegowosc ────────────────────────────────────────────────────────────
  // Wyplata zmniejsza kapital, ale nie jest strata. Bez korekty tych progow bot
  // policzylby obsuniecie wzgledem starego szczytu i wlaczyl bezpiecznik.
  if (state) {
    const solPrice = state?.lastRun?.prices?.SOL || 0;
    const takenUsd = sendUsdc + sendSol * solPrice;
    const cut = (v) => (typeof v === 'number' ? Math.max(1, v - takenUsd) : v);
    state.startEquity = cut(state.startEquity);
    state.peakEquity = cut(state.peakEquity);
    if (state.day) state.day.startEquity = cut(state.day.startEquity);
    state.withdrawnTotal = (state.withdrawnTotal || 0) + takenUsd;
    state.lastWithdraw = { ts: new Date().toISOString(), usd: takenUsd, sig, to: destStr };
    writeJSON(F_STATE, state);
    log(`> ksiegowosc skorygowana o ${usd(takenUsd)}, lacznie wyplacone ${usd(state.withdrawnTotal)}`);

    const trades = readJSON(F_TRADES, []);
    trades.push({
      id: `${Date.now()}-WITHDRAW`,
      ts: new Date().toISOString(),
      sym: 'USDC',
      type: 'WITHDRAW',
      qty: sendUsdc,
      usd: takenUsd,
      price: 1,
      pnlUsd: null,
      pnlPct: null,
      reason: `wyplata na ${destStr.slice(0, 4)}…${destStr.slice(-4)}`,
      sig,
      dry: false,
    });
    writeJSON(F_TRADES, trades);
  }

  await sleep(1500);
  return { preview: false, sendUsdc, sendSol, sig, dest: destStr };
}

function summary(result, error) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  const lines = ['# Wyplata', ''];
  if (error) lines.push(`**Nie wyplacono:** \`${error.message}\``, '');
  else if (result) {
    lines.push(
      result.preview ? '**Tryb podgladu — nic nie wyslano.**' : '**Wyplacone.**',
      '',
      `- USDC: ${usd(result.sendUsdc)}`,
      `- SOL: ${result.sendSol ? result.sendSol.toFixed(4) : '—'}`,
      `- Na adres: \`${result.dest}\``,
      result.sig ? `- Transakcja: https://solscan.io/tx/${result.sig}` : '',
      ''
    );
  }
  lines.push('<details><summary>Log</summary>', '', '```', ...LOG, '```', '</details>');
  try {
    fs.appendFileSync(f, lines.join('\n') + '\n');
  } catch {
    /* kosmetyka */
  }
}

try {
  summary(await main(), null);
} catch (e) {
  log(`!! ${e.message}`);
  summary(null, e);
  process.exit(1);
}
