/** Presentation-only adapter. No writes, orders, policy changes or account resets.
 * safeRead(path, now) -> validated feed | null (ENOENT only); otherwise throws.
 * mergeEth55(base, feed | null | Error, now) -> a new public arena view.
 * The publisher must atomically retain the last valid financial snapshot when
 * blocked. A malformed feed is NOT converted into a fictitious 1000 USD account.
 * Freshness is checked at publication time. The old APK has no per-player timer;
 * refresh the merged public view independently to enforce ETH's 2-minute bound.
 */
import fs from 'node:fs';

export const ETH55_PUBLIC_PATH = new URL('../logs/eth55-paper-v1/public.json', import.meta.url);
export const ETH55_STALE_MS = 2 * 60000;
export const BASE_STALE_MS = 12 * 60000; // Existing APK's freshness threshold.
export const MAX_FEED_BYTES = 256 * 1024;
const PROTOCOL = 'eth55-original-hl-paper-v1-20260928';
const ID = 'eth55';
class FeedError extends Error {}
const fail = label => { throw new FeedError(`ETH55: niepoprawny publiczny odczyt (${label}).`); };
const requireOk = (ok, label) => { if (!ok) fail(label); };
function object(value, required, optional = []) {
  requireOk(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'obiekt');
  const allowed = new Set([...required, ...optional]);
  requireOk(required.every(k => Object.hasOwn(value, k)) &&
    Reflect.ownKeys(value).every(k => allowed.has(k)), 'pola obiektu');
}
function text(value, max, label, empty = false) {
  requireOk(typeof value === 'string' && value.length <= max && (empty || value.trim()) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), label);
}
function number(value, label, min = -1e15, max = 1e15) {
  requireOk(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, label);
}
function count(value, label) { requireOk(Number.isSafeInteger(value) && value >= 0, label); }
function timestamp(value, now, label, nullable = false) {
  if (nullable && value === null) return;
  requireOk(Number.isSafeInteger(value) && value > 0 && value <= now, label);
}
function list(value, max, label) { requireOk(Array.isArray(value) && value.length <= max, label); }
function near(a, b) { return Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b)); }
function identifier(value) {
  text(value, 100, 'id zdarzenia');
  requireOk(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value), 'id zdarzenia');
}

function validate(feed, now) {
  timestamp(now, Number.MAX_SAFE_INTEGER, 'zegar publikacji');
  object(feed, ['schema', 'kind', 'protocol', 'paper', 'ordersEnabled', 'initial', 'startedAt',
    'lastObservedAt', 'updatedAt', 'status', 'error', 'player', 'recentTrades'],
    ['cycleMs', 'decisionLagMs', 'seq', 'quality']);
  requireOk(feed.schema === 1 && feed.kind === 'hajsomat-eth55-paper' && feed.protocol === PROTOCOL &&
    feed.paper === true && feed.ordersEnabled === false && feed.initial === 1000, 'protokół PAPER');
  timestamp(feed.startedAt, now, 'start');
  timestamp(feed.updatedAt, now, 'publikacja');
  timestamp(feed.lastObservedAt, now, 'obserwacja', true);
  requireOk(feed.startedAt <= feed.updatedAt && (feed.lastObservedAt === null ||
    (feed.startedAt <= feed.lastObservedAt && feed.lastObservedAt <= feed.updatedAt)), 'kolejność dat');
  requireOk(['running', 'blocked'].includes(feed.status), 'status');
  if (feed.status === 'running') requireOk(feed.error === null, 'błąd aktywnego źródła');
  else text(feed.error, 1600, 'powód blokady');
  // Explicit public diagnostics emitted by arena-eth55-summary.mjs. Not passed
  // through into the old league's quality/cost fields and not an open extension bag.
  for (const key of ['cycleMs', 'decisionLagMs']) {
    if (Object.hasOwn(feed, key) && feed[key] !== null) number(feed[key], key, 0);
  }
  if (Object.hasOwn(feed, 'seq')) count(feed.seq, 'seq');
  if (Object.hasOwn(feed, 'quality')) {
    object(feed.quality, ['missedSlots', 'blockedSignals', 'gapMinutes', 'fundingApproxEvents']);
    for (const key of ['missedSlots', 'blockedSignals', 'fundingApproxEvents']) count(feed.quality[key], key);
    number(feed.quality.gapMinutes, 'gapMinutes', 0); // Core stores real elapsed minutes, possibly fractional.
  }

  const p = feed.player;
  object(p, ['id', 'name', 'description', 'color', 'capital', 'roi', 'drawdown', 'fees', 'funding',
    'closed', 'wins', 'fills', 'status', 'nextDecision', 'positions', 'history', 'lastAction',
    'signalSource', 'decisionMinutes', 'leverage'], ['startedAt', 'lastObservedAt']);
  for (const key of ['startedAt', 'lastObservedAt']) {
    if (Object.hasOwn(p, key)) requireOk(p[key] === feed[key], `niespójna data gracza ${key}`);
  }
  requireOk(p.id === ID, 'id gracza');
  text(p.name, 100, 'nazwa'); text(p.description, 1800, 'opis', true);
  text(p.color, 7, 'kolor'); requireOk(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(p.color), 'kolor');
  text(p.lastAction, 1000, 'ostatnia akcja', true); text(p.signalSource, 800, 'źródło');
  number(p.capital, 'kapitał'); number(p.roi, 'ROI'); number(p.drawdown, 'obsunięcie', 0);
  number(p.fees, 'prowizje', 0); number(p.funding, 'funding');
  requireOk(near(p.roi, p.capital / 1000 - 1), 'ROI niezgodne z kapitałem');
  count(p.closed, 'zamknięte cykle'); count(p.wins, 'wygrane'); count(p.fills, 'realizacje');
  requireOk(p.wins <= p.closed && p.closed <= p.fills, 'liczniki');
  number(p.decisionMinutes, 'interwał', .01, 10080); number(p.leverage, 'dźwignia', Number.MIN_VALUE, 1000);
  requireOk(['waiting', 'holding', 'blocked'].includes(p.status), 'status gracza');
  if (p.nextDecision !== null) {
    // Schedule, not an observation: future is legitimate here only.
    requireOk(Number.isSafeInteger(p.nextDecision) && p.nextDecision >= feed.startedAt &&
      p.nextDecision <= 8640000000000000, 'następna decyzja');
  }
  const observedStamp = (at, label) => {
    timestamp(at, now, label);
    requireOk(feed.lastObservedAt !== null && at >= feed.startedAt && at <= feed.lastObservedAt, label);
  };
  list(p.positions, 1, 'pozycje');
  for (const pos of p.positions) {
    object(pos, ['symbol', 'side', 'qty', 'entryPrice', 'mark', 'notional', 'pnlUsd', 'openedAt', 'stage']);
    requireOk(pos.symbol === 'ETH' && pos.side === 'LONG', 'wyłącznie ETH LONG');
    for (const k of ['qty', 'entryPrice', 'mark']) number(pos[k], k, Number.MIN_VALUE);
    number(pos.notional, 'nominał', 0); number(pos.pnlUsd, 'P&L pozycji');
    requireOk(near(pos.notional, pos.qty * pos.mark) && near(pos.pnlUsd, pos.qty * (pos.mark - pos.entryPrice)),
      'wycena pozycji');
    observedStamp(pos.openedAt, 'otwarcie pozycji'); text(pos.stage, 160, 'etap', true);
  }
  requireOk(!(p.status === 'holding' && !p.positions.length) &&
    !(p.status === 'waiting' && p.positions.length), 'status pozycji');
  list(p.history, 193, 'historia');
  let previous = 0;
  for (const point of p.history) {
    object(point, ['at', 'equity']); observedStamp(point.at, 'czas historii');
    requireOk(point.at > previous, 'kolejność historii'); previous = point.at;
    number(point.equity, 'kapitał historyczny');
  }
  list(feed.recentTrades, 60, 'realizacje');
  const ids = new Set();
  for (const trade of feed.recentTrades) {
    object(trade, ['id', 'at', 'playerId', 'symbol', 'side', 'qty', 'price', 'fee', 'reason'], ['pnlUsd']);
    identifier(trade.id); requireOk(!ids.has(trade.id), 'powtórzone id realizacji'); ids.add(trade.id);
    requireOk(trade.playerId === ID && trade.symbol === 'ETH' && ['BUY', 'SELL'].includes(trade.side), 'realizacja ETH');
    observedStamp(trade.at, 'czas realizacji');
    number(trade.qty, 'ilość realizacji', Number.MIN_VALUE); number(trade.price, 'cena realizacji', Number.MIN_VALUE);
    number(trade.fee, 'koszt realizacji', 0); text(trade.reason, 800, 'powód realizacji');
    if (Object.hasOwn(trade, 'pnlUsd')) number(trade.pnlUsd, 'wynik realizacji');
  }
  requireOk(feed.recentTrades.length <= p.fills, 'realizacje większe od licznika');
  if (feed.lastObservedAt === null) {
    requireOk(p.capital === 1000 && p.roi === 0 && p.drawdown === 0 && p.fees === 0 && p.funding === 0 &&
      p.closed === 0 && p.wins === 0 && p.fills === 0 && !p.history.length && !p.positions.length &&
      !feed.recentTrades.length, 'wyniki bez obserwacji');
  }
  return structuredClone(feed);
}

/** Only logs/eth55-paper-v1/public.json (strict public projection) is read.
 * This is not a journal; the existing parent alone publishes state/arena.json.
 * ENOENT means not installed, not a zero account.
 * Read is bounded even if another process grows the file between stat and read.
 * Callers should publish via atomic rename; no state/journal/credentials are read.
 */
export function safeRead(path = ETH55_PUBLIC_PATH, now = Date.now()) {
  let fd;
  try { fd = fs.openSync(path, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new FeedError('ETH55: nie można odczytać publicznego pliku.');
  }
  try {
    const stat = fs.fstatSync(fd);
    requireOk(stat.isFile() && stat.size <= MAX_FEED_BYTES, 'rozmiar/typ pliku');
    const bytes = Buffer.alloc(MAX_FEED_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    requireOk(size <= MAX_FEED_BYTES, 'rozmiar pliku');
    const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, size)));
    return validate(parsed, now);
  } catch (error) {
    if (error instanceof FeedError) throw error;
    throw new FeedError('ETH55: publiczny plik jest nieczytelny lub niepoprawny.');
  } finally { fs.closeSync(fd); }
}

const stampText = at => at === null ? 'brak obserwacji' : new Date(at).toISOString();
function annotated(original, annotation, max) {
  // Reserve space for the safety annotation; never truncate it away.
  const suffix = ` ${annotation}`;
  return `${original.slice(0, Math.max(0, max - suffix.length))}${suffix}`.slice(0, max).trim();
}
function block(base, reason) {
  return {...base, status: 'blocked', error: [base.error, reason].filter(Boolean).join(' ').slice(0, 1600),
    note: annotated(base.note, 'ETH55: brak poprawnego odczytu; nie dopisano fikcyjnego rachunku.', 2000)};
}

export function mergeEth55(base, extra, now = Date.now()) {
  if (extra === null || extra === undefined) return base; // Exact legacy no-file behavior.
  let feed;
  try {
    if (extra instanceof FeedError) throw extra;
    feed = validate(extra, now);
    requireOk(!base.players.some(p => p.id === ID) && base.players.length < 64, 'kolizja id gracza');
    requireOk(base.startedAt === null || feed.startedAt >= base.startedAt, 'start wcześniejszy od istniejącej ligi');
    const baseTradeIds = new Set(base.recentTrades.map(t => t.id));
    requireOk(feed.recentTrades.every(t => !baseTradeIds.has(t.id)) &&
      base.recentTrades.length + feed.recentTrades.length <= 2000, 'kolizja/limit realizacji ligi');
    requireOk(base.players.reduce((sum, p) => sum + p.history.length, feed.player.history.length) <= 30000,
      'limit historii ligi');
  } catch (error) {
    return block(base, error instanceof FeedError ? error.message : 'ETH55: niepoprawny publiczny odczyt.');
  }
  const baseStale = base.lastObservedAt === null || now - base.lastObservedAt >= BASE_STALE_MS;
  const extraStale = feed.lastObservedAt === null || now - feed.lastObservedAt > ETH55_STALE_MS;
  const reasons = [];
  if (base.status === 'blocked') reasons.push(base.error || 'Dotychczasowa liga jest zablokowana.');
  if (baseStale) reasons.push(`Dotychczasowa piątka: nieaktualne dane (${stampText(base.lastObservedAt)}). Świeży ETH55 tego nie zmienia.`);
  if (feed.status === 'blocked') reasons.push(`ETH55: ${feed.error}`);
  if (extraStale) reasons.push(`ETH55: ${feed.lastObservedAt === null ? 'brak pierwszej obserwacji' : 'obserwacja starsza niż 2 minuty'}; ostatnie saldo zachowane.`);
  if (feed.player.status === 'blocked' && feed.status !== 'blocked') reasons.push('ETH55: rachunek zablokowany.');
  const extraBlocked = extraStale || feed.status === 'blocked' || feed.player.status === 'blocked';
  const age = feed.lastObservedAt === null ? '' : `; wiek ${Math.floor((now - feed.lastObservedAt) / 1000)} s`;
  const player = {...feed.player,
    status: extraBlocked ? 'blocked' : feed.player.status,
    // Older APK drops these fields; the same facts are also in visible text.
    startedAt: feed.startedAt, lastObservedAt: feed.lastObservedAt, updatedAt: feed.updatedAt,
    description: annotated(feed.player.description, `Osobny start: ${stampText(feed.startedAt)}; własne 1000 USD. Nie ma wspólnego startu z piątką.`, 1800),
    signalSource: annotated(feed.player.signalSource, `ETH55 — obserwacja: ${stampText(feed.lastObservedAt)}${age}.`, 800),
    lastAction: extraBlocked ? annotated(feed.player.lastAction, `BLOKADA ETH55: ${extraStale ? 'brak świeżej obserwacji; ' : ''}${feed.error ?? 'rachunek wstrzymany'}. Wycena z obserwacji: ${stampText(feed.lastObservedAt)}.`, 1000) : feed.player.lastAction};
  const players = baseStale ? base.players.map(p => ({...p, status: 'blocked',
    lastAction: annotated(p.lastAction, `Piątka: ostatnia obserwacja ${stampText(base.lastObservedAt)}; brak świeżych danych.`, 1000)})) : [...base.players];
  // Max is a publication envelope, NOT a claim of common valuation time.
  // If base is stale, global status and all five player statuses are blocked.
  // Merely clamping history to the old timestamp would still misdate balances.
  const observed = [base.lastObservedAt, feed.lastObservedAt].filter(t => t !== null);
  return {...base, updatedAt: now, lastObservedAt: observed.length ? Math.max(...observed) : null,
    status: reasons.length ? 'blocked' : 'running', error: reasons.length ? reasons.join(' ').slice(0, 1600) : null,
    players: [...players, player],
    recentTrades: [...base.recentTrades, ...feed.recentTrades].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)),
    note: annotated(base.note, `ETH55 ma osobny start i inny czas obserwacji; ranking nie porównuje wspólnego okresu. Piątka: ${stampText(base.lastObservedAt)}. ETH55: ${stampText(feed.lastObservedAt)}.`, 2000)};
}
