/**
 * HAJSOMAT — podglad bota tradingowego SOL/USDC.
 *
 * Apka nic nie handluje. Czyta dwa zrodla:
 *   1. state/*.json z repo na GitHubie (co robil bot, po co, z jakim skutkiem),
 *   2. lancuch Solany przez RPC (realne saldo i lista transakcji portfela).
 *
 * Calosc w jednym pliku, bo taka byla umowa.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient as SvgGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';

// ─────────────────────────────────────────────────────────────────────────────
// Motyw
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  bg: '#06080B',
  bg2: '#0B0F14',
  card: '#0E141B',
  cardHi: '#141C26',
  line: '#1C2733',
  text: '#E8EFF6',
  dim: '#7C8B9C',
  faint: '#4A5866',
  green: '#2BFF88',
  greenDim: 'rgba(43,255,136,0.12)',
  red: '#FF4D5E',
  amber: '#FFB020',
  cyan: '#45E0FF',
  violet: '#9B6BFF',
};

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const JUP = 'https://lite-api.jup.ag/swap/v1';
// Bot uzywa tego adresu, gdy symuluje bez portfela — nie ma czego odpytywac.
const NO_WALLET = '11111111111111111111111111111111';

// Do nazywania sald z lancucha. Minty muszą się zgadzać z bot/trade.mjs.
const MINTS = {
  [USDC_MINT]: 'USDC',
  [SOL_MINT]: 'SOL',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 'JTO',
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'PYTH',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: 'ORCA',
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: 'RENDER',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ': 'W',
  TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6: 'TNSR',
  DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7: 'DRIFT',
  KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS: 'KMNO',
  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv': 'PENGU',
};

const DEFAULTS = {
  repo: '',
  branch: 'main',
  wallet: '',
  rpc: 'https://api.mainnet-beta.solana.com',
  usdPln: 4.0,
};

const STORE_KEY = 'hajsomat:cfg:v1';
const CACHE_KEY = 'hajsomat:cache:v1';

// Kursy EBC zmieniaja sie raz na dzien roboczy — odpytywanie czesciej nie ma sensu.
const FX_TTL = 6 * 3600 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Formatowanie
// ─────────────────────────────────────────────────────────────────────────────

function nf(n, d = 2) {
  if (n == null || !isFinite(n)) return '—';
  const neg = n < 0;
  const s = Math.abs(n).toFixed(d);
  const [i, f] = s.split('.');
  const gi = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '−' : '') + gi + (f ? ',' + f : '');
}

// Bot liczy wszystko w dolarach, bo w nich handluje. Apka pokazuje wylacznie
// zlotowki — przelicznik siedzi tutaj, w jednym miejscu, zamiast w kazdym
// wywolaniu. Ustawia go Shell, gdy tylko pozna aktualny kurs.
let FX = DEFAULTS.usdPln;
const setFx = (r) => {
  if (r && isFinite(r) && r > 0) FX = r;
};

const money = (n, d = 2) => (n == null || !isFinite(n) ? '—' : `${nf(n * FX, d)} zł`);

/** Cena tokena — BONK kosztuje ulamek grosza, SOL trzysta zlotych. */
function priceFmt(n) {
  if (n == null || !isFinite(n)) return '—';
  const v = n * FX;
  const a = Math.abs(v);
  const d = a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 9;
  return `${nf(v, d)} zł`;
}

/** Ilosc tokena — 0,1234 SOL kontra 40 000 000 BONK. */
const qtyFmt = (n) => (n == null || !isFinite(n) ? '—' : nf(n, Math.abs(n) >= 1000 ? 0 : 4));
const signed = (n, d = 2) =>
  n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${nf(Math.abs(n) * FX, d)} zł`;
const signedPct = (n, d = 2) =>
  n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${nf(Math.abs(n) * 100, d)}%`;
const shortAddr = (a) =>
  a === NO_WALLET ? 'brak portfela' : a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '—';

function ago(ts) {
  if (!ts) return '—';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)} s temu`;
  if (s < 3600) return `${Math.floor(s / 60)} min temu`;
  if (s < 86400) return `${Math.floor(s / 3600)} godz. temu`;
  return `${Math.floor(s / 86400)} dni temu`;
}

function clockPl(ts) {
  const d = new Date(typeof ts === 'string' ? Date.parse(ts) : ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dayKey(ts) {
  const d = new Date(typeof ts === 'string' ? Date.parse(ts) : ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function durPl(ms) {
  if (!ms || !isFinite(ms)) return '—';
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  if (h < 48) return `${h.toFixed(1)} godz.`;
  return `${(h / 24).toFixed(1)} dni`;
}

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const tap = () => {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
};

// ─────────────────────────────────────────────────────────────────────────────
// Siec
// ─────────────────────────────────────────────────────────────────────────────

async function jget(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const rawUrl = (repo, branch, file) =>
  `https://raw.githubusercontent.com/${repo.trim().replace(/^\/+|\/+$/g, '')}/${branch || 'main'}/state/${file}?t=${Date.now()}`;

async function rpc(url, method, params) {
  const j = await jget(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (j.error) throw new Error(j.error.message || 'blad RPC');
  return j.result;
}

async function fetchChain(rpcUrl, wallet) {
  const [balRes, tokRes, sigRes] = await Promise.all([
    rpc(rpcUrl, 'getBalance', [wallet]),
    rpc(rpcUrl, 'getTokenAccountsByOwner', [
      wallet,
      { programId: TOKEN_PROGRAM },
      { encoding: 'jsonParsed' },
    ]).catch(() => ({ value: [] })),
    rpc(rpcUrl, 'getSignaturesForAddress', [wallet, { limit: 40 }]).catch(() => []),
  ]);

  const sol = (balRes?.value ?? 0) / 1e9;
  const tok = {};
  for (const a of tokRes?.value || []) {
    const info = a?.account?.data?.parsed?.info;
    if (!info) continue;
    const amt = info.tokenAmount?.uiAmount || 0;
    if (amt > 0) tok[info.mint] = (tok[info.mint] || 0) + amt;
  }
  const usdc = tok[USDC_MINT] || 0;
  const txs = (sigRes || []).map((s) => ({
    sig: s.signature,
    ts: s.blockTime ? s.blockTime * 1000 : null,
    err: !!s.err,
    slot: s.slot,
    memo: s.memo,
  }));
  return { sol, usdc, tok, txs };
}

async function fetchPrice() {
  const q = await jget(
    `${JUP}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=50`
  );
  return Number(q.outAmount) / 1e6;
}

async function fetchFx() {
  try {
    const j = await jget('https://api.frankfurter.app/latest?from=USD&to=PLN', {}, 8000);
    const v = j?.rates?.PLN;
    return isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Analityka
// ─────────────────────────────────────────────────────────────────────────────

function computeStats({ state, trades, equity, price, chain }) {
  const sells = (trades || []).filter((t) => t.type === 'SELL' && t.pnlUsd != null);
  const wins = sells.filter((t) => t.pnlUsd > 0);
  const losses = sells.filter((t) => t.pnlUsd <= 0);

  const realized = sells.reduce((a, t) => a + t.pnlUsd, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlUsd, 0));

  // Ceny z ostatniego przebiegu bota — jedyne zrodlo wyceny dla altow.
  const prices = { ...(state?.lastRun?.prices || {}) };
  if (price) prices.SOL = price;

  // Stan w wersji 1 mial jedna pozycje SOL; nowy trzyma mape symbol -> pozycja.
  const rawPos = state?.positions || (state?.position ? { SOL: state.position } : {});
  const positions = Object.entries(rawPos).map(([sym, p]) => {
    const qty = p.qty ?? p.sizeSol ?? 0;
    const now = prices[sym] ?? p.entryPrice;
    return { ...p, sym, qty, now, value: qty * now, pnl: qty * now - p.costUsd };
  });
  const unrealized = positions.reduce((a, p) => a + p.pnl, 0);

  // Kapital liczy bot (zna ceny wszystkich aktywow); lancuch to zapasowe zrodlo.
  const liveEquity =
    state?.lastRun?.equityUsd ??
    (equity?.length ? equity.at(-1).equityUsd : chain && price ? chain.usdc + chain.sol * price : null);

  const curve = (equity || [])
    .filter((e) => isFinite(e?.equityUsd) && e.equityUsd > 0)
    .map((e) => ({ t: e.ts, v: e.equityUsd, p: e.price, pos: e.pos }));

  const start = state?.startEquity ?? (curve.length ? curve[0].v : null);
  const roi = start && liveEquity ? (liveEquity - start) / start : null;

  const at = (msAgo) => {
    const cut = Date.now() - msAgo;
    const pt = curve.find((x) => x.t >= cut);
    return pt ? pt.v : null;
  };
  const v24 = at(86400000);
  const v7d = at(7 * 86400000);
  const chg24 = v24 && liveEquity ? liveEquity - v24 : null;
  const chg7d = v7d && liveEquity ? liveEquity - v7d : null;

  let peak = -Infinity;
  let maxDD = 0;
  let maxDDUsd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.v);
    const dd = peak > 0 ? (peak - p.v) / peak : 0;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDUsd = peak - p.v;
    }
  }
  const peakEq = Math.max(state?.peakEquity ?? 0, peak === -Infinity ? 0 : peak, liveEquity || 0);
  const curDD = peakEq > 0 && liveEquity ? (peakEq - liveEquity) / peakEq : 0;

  // Serie zwyciestw i porazek
  let bestStreak = 0;
  let worstStreak = 0;
  let cur = 0;
  for (const t of sells) {
    const w = t.pnlUsd > 0;
    if (w) cur = cur > 0 ? cur + 1 : 1;
    else cur = cur < 0 ? cur - 1 : -1;
    bestStreak = Math.max(bestStreak, cur);
    worstStreak = Math.min(worstStreak, cur);
  }
  const streakNow = cur;

  // PnL po dniach (ostatnie 14)
  const byDay = new Map();
  for (const t of sells) {
    const k = dayKey(t.ts);
    byDay.set(k, (byDay.get(k) || 0) + t.pnlUsd);
  }
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const k = dayKey(d.getTime());
    days.push({ key: k, label: `${d.getDate()}.${d.getMonth() + 1}`, pnl: byDay.get(k) || 0 });
  }

  const holds = sells.filter((t) => t.holdMs).map((t) => t.holdMs);
  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null;

  const dryCount = (trades || []).filter((t) => t.dry).length;

  return {
    liveEquity,
    start,
    roi,
    realized,
    unrealized,
    total: realized + unrealized,
    chg24,
    chg24pct: v24 ? chg24 / v24 : null,
    chg7d,
    chg7dpct: v7d ? chg7d / v7d : null,
    count: sells.length,
    winsN: wins.length,
    lossesN: losses.length,
    winRate: sells.length ? wins.length / sells.length : null,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    expectancy: sells.length ? realized / sells.length : null,
    best: sells.length ? Math.max(...sells.map((t) => t.pnlUsd)) : null,
    worst: sells.length ? Math.min(...sells.map((t) => t.pnlUsd)) : null,
    maxDD,
    maxDDUsd,
    curDD,
    peakEq,
    bestStreak,
    worstStreak: Math.abs(worstStreak),
    streakNow,
    days,
    avgHold,
    volume: state?.stats?.volumeUsd ?? 0,
    curve,
    positions,
    prices,
    scan: state?.lastRun?.scan || [],
    perAsset: Object.entries(state?.perAsset || {})
      .map(([sym, v]) => ({ sym, ...v }))
      .sort((a, b) => b.pnl - a.pnl),
    dryCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Male klocki UI
// ─────────────────────────────────────────────────────────────────────────────

function Card({ children, style, glow }) {
  return (
    <View style={[s.card, glow && { borderColor: 'rgba(43,255,136,0.25)' }, style]}>{children}</View>
  );
}

function SectionTitle({ children, right }) {
  return (
    <View style={s.sectionRow}>
      <Text style={s.sectionTitle}>{children}</Text>
      {right}
    </View>
  );
}

function Pill({ text, tone = 'dim', small }) {
  const map = {
    green: [C.green, 'rgba(43,255,136,0.12)'],
    red: [C.red, 'rgba(255,77,94,0.12)'],
    amber: [C.amber, 'rgba(255,176,32,0.12)'],
    cyan: [C.cyan, 'rgba(69,224,255,0.12)'],
    violet: [C.violet, 'rgba(155,107,255,0.14)'],
    dim: [C.dim, 'rgba(124,139,156,0.10)'],
  };
  const [fg, bg] = map[tone] || map.dim;
  return (
    <View style={[s.pill, { backgroundColor: bg }, small && { paddingVertical: 2, paddingHorizontal: 7 }]}>
      <Text style={[s.pillText, { color: fg }, small && { fontSize: 10 }]}>{text}</Text>
    </View>
  );
}

function Stat({ label, value, sub, tone, flex = 1 }) {
  const color = tone === 'green' ? C.green : tone === 'red' ? C.red : C.text;
  return (
    <View style={{ flex }}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={s.statSub}>{sub}</Text> : null}
    </View>
  );
}

function Row({ label, value, tone, mono = true }) {
  const color =
    tone === 'green' ? C.green : tone === 'red' ? C.red : tone === 'cyan' ? C.cyan : tone === 'dim' ? C.dim : C.text;
  return (
    <View style={s.kvRow}>
      <Text style={s.kvLabel}>{label}</Text>
      <Text style={[s.kvValue, mono && { fontFamily: MONO }, { color }]}>{value}</Text>
    </View>
  );
}

function Icon({ name, color = C.dim, size = 22 }) {
  const props = { stroke: color, strokeWidth: 1.8, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'pulse' && <Path d="M2 12h4l3-8 4 16 3-8h6" {...props} />}
      {name === 'swap' && (
        <G {...props}>
          <Path d="M7 20V5M7 5 4 8M7 5l3 3" />
          <Path d="M17 4v15M17 19l-3-3M17 19l3-3" />
        </G>
      )}
      {name === 'chart' && (
        <G {...props}>
          <Path d="M4 20V11M10 20V4M16 20v-6M22 20H2" />
        </G>
      )}
      {name === 'gear' && (
        <G {...props}>
          <Path d="M3 7h18M3 12h18M3 17h18" />
          <Circle cx="9" cy="7" r="2" fill={C.bg} />
          <Circle cx="16" cy="12" r="2" fill={C.bg} />
          <Circle cx="7" cy="17" r="2" fill={C.bg} />
        </G>
      )}
    </Svg>
  );
}

function LiveDot({ ok }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: 1100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(a, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  const col = ok ? C.green : C.amber;
  return (
    <View style={{ width: 10, height: 10, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: col,
          opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
          transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
        }}
      />
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: col }} />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wykresy
// ─────────────────────────────────────────────────────────────────────────────

function EquityChart({ points, height = 170, baseline }) {
  const [w, setW] = useState(320);
  if (!points || points.length < 2) {
    return (
      <View style={[s.chartEmpty, { height }]} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        <Text style={s.emptyText}>Za malo danych na wykres — bot dopiero zbiera historie.</Text>
      </View>
    );
  }

  const padT = 12;
  const padB = 18;
  const h = height - padT - padB;
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.v);
  const minX = xs[0];
  const maxX = xs[xs.length - 1] || minX + 1;
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  if (baseline != null) {
    minY = Math.min(minY, baseline);
    maxY = Math.max(maxY, baseline);
  }
  const span = maxY - minY || Math.max(1, maxY * 0.01);
  minY -= span * 0.12;
  maxY += span * 0.12;

  const X = (t) => ((t - minX) / (maxX - minX || 1)) * w;
  const Y = (v) => padT + h - ((v - minY) / (maxY - minY)) * h;

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
  const area = `${d} L${w} ${padT + h} L0 ${padT + h} Z`;

  const up = ys[ys.length - 1] >= (baseline ?? ys[0]);
  const col = up ? C.green : C.red;
  const last = points[points.length - 1];

  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Svg width="100%" height={height}>
        <Defs>
          <SvgGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={col} stopOpacity="0.30" />
            <Stop offset="1" stopColor={col} stopOpacity="0" />
          </SvgGradient>
        </Defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <Line
            key={f}
            x1="0"
            x2={w}
            y1={padT + h * f}
            y2={padT + h * f}
            stroke={C.line}
            strokeWidth="1"
            strokeDasharray="3 6"
          />
        ))}
        {baseline != null && baseline > minY && baseline < maxY && (
          <Line
            x1="0"
            x2={w}
            y1={Y(baseline)}
            y2={Y(baseline)}
            stroke={C.faint}
            strokeWidth="1"
            strokeDasharray="5 4"
          />
        )}
        <Path d={area} fill="url(#eqfill)" />
        <Path d={d} stroke={col} strokeWidth="2.2" fill="none" strokeLinejoin="round" strokeLinecap="round" />
        <Circle cx={X(last.t)} cy={Y(last.v)} r="4.5" fill={col} />
        <Circle cx={X(last.t)} cy={Y(last.v)} r="9" fill={col} fillOpacity="0.18" />
      </Svg>
      <View style={s.chartAxis}>
        <Text style={s.axisText}>{clockPl(minX)}</Text>
        <Text style={s.axisText}>{money(minY + (maxY - minY) / 2, 0)}</Text>
        <Text style={s.axisText}>teraz</Text>
      </View>
    </View>
  );
}

function DayBars({ days }) {
  const [w, setW] = useState(320);
  const h = 92;
  const max = Math.max(0.01, ...days.map((d) => Math.abs(d.pnl)));
  const gap = 4;
  const bw = Math.max(4, (w - gap * (days.length - 1)) / days.length);
  const mid = h / 2;

  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Svg width="100%" height={h}>
        <Line x1="0" x2={w} y1={mid} y2={mid} stroke={C.line} strokeWidth="1" />
        {days.map((d, i) => {
          const bh = (Math.abs(d.pnl) / max) * (mid - 6);
          const x = i * (bw + gap);
          const up = d.pnl >= 0;
          return (
            <Rect
              key={d.key}
              x={x}
              y={up ? mid - bh : mid}
              width={bw}
              height={Math.max(d.pnl === 0 ? 1.5 : 2, bh)}
              rx="2"
              fill={d.pnl === 0 ? C.line : up ? C.green : C.red}
              fillOpacity={d.pnl === 0 ? 0.6 : 0.85}
            />
          );
        })}
      </Svg>
      <View style={s.chartAxis}>
        <Text style={s.axisText}>{days[0]?.label}</Text>
        <Text style={s.axisText}>ostatnie 14 dni</Text>
        <Text style={s.axisText}>{days[days.length - 1]?.label}</Text>
      </View>
    </View>
  );
}

function WinLossBar({ wins, losses }) {
  const total = wins + losses;
  const wpct = total ? wins / total : 0;
  return (
    <View>
      <View style={s.wlBar}>
        <View style={{ flex: Math.max(wpct, 0.001), backgroundColor: C.green }} />
        <View style={{ flex: Math.max(1 - wpct, 0.001), backgroundColor: C.red, opacity: 0.75 }} />
      </View>
      <View style={s.wlLegend}>
        <Text style={[s.wlText, { color: C.green }]}>{wins} wygranych</Text>
        <Text style={[s.wlText, { color: C.dim }]}>{total ? `${(wpct * 100).toFixed(0)}%` : '—'}</Text>
        <Text style={[s.wlText, { color: C.red }]}>{losses} stratnych</Text>
      </View>
    </View>
  );
}

/** Gdzie stoi cena miedzy stop-lossem a take-profitem. */
function PositionGauge({ stop, tp, entry, price }) {
  if (![stop, tp, price].every((x) => isFinite(x)) || tp <= stop) return null;
  const f = clamp((price - stop) / (tp - stop), 0, 1);
  const fe = clamp((entry - stop) / (tp - stop), 0, 1);
  const win = price >= entry;
  return (
    <View style={{ marginTop: 14 }}>
      <View style={s.gaugeTrack}>
        <LinearGradient
          colors={['rgba(255,77,94,0.35)', 'rgba(124,139,156,0.18)', 'rgba(43,255,136,0.35)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={[s.gaugeEntry, { left: `${fe * 100}%` }]} />
        <View
          style={[
            s.gaugeDot,
            { left: `${f * 100}%`, backgroundColor: win ? C.green : C.red, shadowColor: win ? C.green : C.red },
          ]}
        />
      </View>
      <View style={s.gaugeLabels}>
        <Text style={[s.axisText, { color: C.red }]}>stop {money(stop)}</Text>
        <Text style={s.axisText}>wejscie {money(entry)}</Text>
        <Text style={[s.axisText, { color: C.green }]}>TP {money(tp)}</Text>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ekran: Kokpit
// ─────────────────────────────────────────────────────────────────────────────

function Kokpit({ data, cfg, goSettings }) {
  const { state, stats, price, chain, err } = data;
  const [range, setRange] = useState('7d');

  if (!cfg.repo && !cfg.wallet) {
    return (
      <Card>
        <Text style={s.h2}>Zacznij tutaj</Text>
        <Text style={s.p}>
          Apka nie wie jeszcze, ktory bot ma obserwowac. Wpisz w ustawieniach repozytorium z botem
          (np. <Text style={s.code}>twojnick/hajsomat</Text>) albo sam adres portfela.
        </Text>
        <Pressable style={s.btn} onPress={goSettings}>
          <Text style={s.btnText}>Otworz ustawienia</Text>
        </Pressable>
      </Card>
    );
  }

  const cutoff = range === '24h' ? 86400000 : range === '7d' ? 7 * 86400000 : Infinity;
  const curve = stats.curve.filter((p) => Date.now() - p.t <= cutoff);
  const totalTone = stats.total > 0 ? 'green' : stats.total < 0 ? 'red' : undefined;

  const lastRun = state?.lastRun;
  const stale = lastRun ? Date.now() - Date.parse(lastRun.ts) > 25 * 60000 : true;

  return (
    <>
      {err ? (
        <View style={s.errBanner}>
          <Text style={s.errText}>{err}</Text>
        </View>
      ) : null}

      {/* Kapital */}
      <Card glow>
        <View style={s.headRow}>
          <Text style={s.eyebrow}>KAPITAL W PORTFELU</Text>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            {state?.mode === 'DRY' && <Pill text="SYMULACJA" tone="amber" small />}
            {state?.mode === 'LIVE' && <Pill text="LIVE" tone="green" small />}
            {state?.halted && <Pill text="STOP" tone="red" small />}
          </View>
        </View>

        <Text style={s.bigNumber} numberOfLines={1} adjustsFontSizeToFit>
          {money(stats.liveEquity)}
        </Text>
        <Text style={s.bigSub}>
          {stats.roi != null ? `ROI ${signedPct(stats.roi)}` : 'brak danych o zwrocie'}
          {stats.start != null ? `   ·   start ${money(stats.start, 0)}` : ''}
        </Text>

        <View style={s.divider} />

        <View style={s.statRow}>
          <Stat
            label="ZYSK LACZNIE"
            value={signed(stats.total)}
            sub={stats.start ? `z ${money(stats.start, 0)} startu` : null}
            tone={totalTone}
          />
          <Stat
            label="24 GODZ."
            value={stats.chg24 == null ? '—' : signed(stats.chg24)}
            sub={stats.chg24pct == null ? null : signedPct(stats.chg24pct)}
            tone={stats.chg24 > 0 ? 'green' : stats.chg24 < 0 ? 'red' : undefined}
          />
          <Stat
            label="7 DNI"
            value={stats.chg7d == null ? '—' : signed(stats.chg7d)}
            sub={stats.chg7dpct == null ? null : signedPct(stats.chg7dpct)}
            tone={stats.chg7d > 0 ? 'green' : stats.chg7d < 0 ? 'red' : undefined}
          />
        </View>
      </Card>

      {/* Wykres */}
      <Card>
        <SectionTitle
          right={
            <View style={s.segment}>
              {['24h', '7d', 'max'].map((r) => (
                <Pressable
                  key={r}
                  onPress={() => {
                    tap();
                    setRange(r);
                  }}
                  style={[s.segBtn, range === r && s.segBtnOn]}
                >
                  <Text style={[s.segText, range === r && s.segTextOn]}>{r}</Text>
                </Pressable>
              ))}
            </View>
          }
        >
          Krzywa kapitalu
        </SectionTitle>
        <EquityChart points={curve} baseline={range === 'max' ? stats.start : curve[0]?.v} />
      </Card>

      {/* Pozycje */}
      <Card>
        <SectionTitle
          right={
            lastRun?.maxPositions ? (
              <Text style={s.statSub}>
                {stats.positions.length} z {lastRun.maxPositions} slotow
              </Text>
            ) : null
          }
        >
          Otwarte pozycje
        </SectionTitle>
        {stats.positions.length ? (
          stats.positions.map((p, i) => (
            <View key={p.sym} style={i > 0 ? { marginTop: 24 } : null}>
              {i > 0 && <View style={[s.divider, { marginTop: 0, marginBottom: 18 }]} />}
              <View style={s.headRow}>
                <View style={{ flex: 1 }}>
                  <View style={s.posHead}>
                    <Pill text={p.sym} tone="cyan" small />
                    <Text style={s.posBig}>{qtyFmt(p.qty)}</Text>
                  </View>
                  <Text style={s.statSub}>
                    wejscie {priceFmt(p.entryPrice)} · {ago(p.entryTs)}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[s.posPnl, { color: p.pnl >= 0 ? C.green : C.red }]}>
                    {signed(p.pnl)}
                  </Text>
                  <Text style={s.statSub}>
                    {p.costUsd ? signedPct(p.pnl / p.costUsd) : ''} niezrealizowane
                  </Text>
                </View>
              </View>
              <PositionGauge stop={p.stopPrice} tp={p.takeProfit} entry={p.entryPrice} price={p.now} />
              <View style={{ marginTop: 12 }}>
                <Row label="Kurs teraz" value={priceFmt(p.now)} />
                <Row label="Wartosc" value={money(p.value)} />
                <Row label="Kosztowala" value={money(p.costUsd)} />
                <Row
                  label="Trailing stop"
                  value={p.trailArmed ? 'uzbrojony' : 'jeszcze nie'}
                  tone={p.trailArmed ? 'green' : 'dim'}
                />
              </View>
            </View>
          ))
        ) : (
          <View style={s.emptyBox}>
            <Text style={s.emptyText}>
              Bot siedzi w USDC i czeka na okazje. Zero ryzyka rynkowego w tej chwili.
            </Text>
          </View>
        )}
      </Card>

      {/* Status bota */}
      <Card>
        <SectionTitle
          right={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <LiveDot ok={!stale && !state?.halted} />
              <Text style={s.statSub}>{lastRun ? ago(lastRun.ts) : 'brak danych'}</Text>
            </View>
          }
        >
          Co robi bot
        </SectionTitle>

        {state?.halted ? (
          <View style={s.warnBox}>
            <Text style={s.warnTitle}>Bezpiecznik zadzialal — handel wstrzymany</Text>
            <Text style={s.warnText}>{state.haltReason}</Text>
            <Text style={[s.warnText, { marginTop: 6, color: C.faint }]}>
              Wznow recznie: Actions → Hajsomat → Run workflow → reset_halt.
            </Text>
          </View>
        ) : null}

        {state?.lastError ? (
          <View style={[s.warnBox, { borderColor: 'rgba(255,77,94,0.3)' }]}>
            <Text style={s.warnTitle}>Ostatni przebieg sie wywalil</Text>
            <Text style={s.warnText}>{state.lastError.message}</Text>
          </View>
        ) : null}

        <View style={s.actionRow}>
          <Pill
            text={lastRun?.action || 'BRAK'}
            tone={
              lastRun?.action?.includes('BUY')
                ? 'cyan'
                : lastRun?.action?.includes('SELL')
                  ? 'violet'
                  : 'dim'
            }
          />
          {stale && <Pill text="dane nieswieze" tone="amber" small />}
        </View>
        <Text style={s.reason}>{lastRun?.reason || 'Bot jeszcze nic nie zaraportowal.'}</Text>
      </Card>

      {/* Skaner */}
      {stats.scan.length ? (
        <Card>
          <SectionTitle right={<Text style={s.statSub}>{stats.scan.length} aktywow</Text>}>
            Skaner rynku
          </SectionTitle>
          {stats.scan.map((c, i) => {
            const tone = c.enter ? C.green : c.held ? C.cyan : c.trend === 'up' ? C.amber : C.faint;
            return (
              <View key={c.sym} style={[s.scanRow, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
                <View style={s.scanHead}>
                  <View style={[s.scanDot, { backgroundColor: tone }]} />
                  <Text style={s.scanSym}>{c.sym}</Text>
                  <Text style={s.scanPrice}>{priceFmt(c.price)}</Text>
                  <View style={s.scanBarTrack}>
                    <View
                      style={[
                        s.scanBarFill,
                        { width: `${clamp((c.score / 10) * 100, 0, 100)}%`, backgroundColor: tone },
                      ]}
                    />
                  </View>
                  <Text style={s.scanScore}>{c.score}</Text>
                </View>
                <Text style={s.scanReason} numberOfLines={2}>
                  {c.reason}
                </Text>
              </View>
            );
          })}
          <Text style={s.scanLegend}>
            Zielony — gotowy do wejscia · niebieski — pozycja otwarta · pomaranczowy — trend jest,
            ale warunki jeszcze nie · szary — brak trendu wzrostowego.
          </Text>
        </Card>
      ) : null}

      {/* Portfel */}
      <Card>
        <SectionTitle>Portfel on-chain</SectionTitle>
        <View style={s.statRow}>
          <Stat label="SOL" value={nf(chain?.sol, 4)} sub={money((chain?.sol || 0) * (price || 0))} />
          <Stat label="USDC" value={nf(chain?.usdc, 2)} sub="gotowka" />
          <Stat label="KURS SOL" value={money(price)} sub="Jupiter" />
        </View>

        {chain?.tok
          ? (() => {
              const rest = Object.entries(chain.tok)
                .filter(([m]) => m !== USDC_MINT)
                .map(([m, v]) => ({ sym: MINTS[m] || `${m.slice(0, 4)}…`, v, m }))
                .sort((a, b) => b.v - a.v);
              if (!rest.length) return null;
              return (
                <View style={{ marginTop: 12 }}>
                  {rest.map((t) => (
                    <Row
                      key={t.m}
                      label={t.sym}
                      value={`${qtyFmt(t.v)}${stats.prices[t.sym] ? `   ${money(t.v * stats.prices[t.sym])}` : ''}`}
                    />
                  ))}
                </View>
              );
            })()
          : null}
        <Pressable
          onPress={async () => {
            tap();
            const a = state?.wallet || cfg.wallet;
            if (a) await Clipboard.setStringAsync(a);
          }}
          style={s.addrBox}
        >
          <Text style={s.addrText}>{state?.wallet || cfg.wallet || 'brak adresu'}</Text>
          <Text style={s.addrHint}>dotknij, aby skopiowac</Text>
        </Pressable>
      </Card>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ekran: Trejdy
// ─────────────────────────────────────────────────────────────────────────────

function TradeRow({ t }) {
  const kind = t.type === 'BUY' ? 'buy' : t.type === 'WITHDRAW' ? 'out' : 'sell';
  const mark = { buy: ['KUP', C.cyan], sell: ['SPRZ', C.violet], out: ['WYPŁ', C.amber] }[kind];
  const pnl = t.pnlUsd;
  const open = () => {
    if (t.sig) Linking.openURL(`https://solscan.io/tx/${t.sig}`).catch(() => {});
  };
  return (
    <Pressable onPress={t.sig ? open : undefined} style={({ pressed }) => [s.trade, pressed && { opacity: 0.6 }]}>
      <View style={[s.tradeMark, { backgroundColor: `${mark[1]}22` }]}>
        <Text style={[s.tradeMarkText, { color: mark[1] }]}>{mark[0]}</Text>
      </View>

      <View style={{ flex: 1, marginLeft: 12 }}>
        <View style={s.headRow}>
          <Text style={s.tradeTitle}>
            {qtyFmt(t.qty ?? t.sol)} <Text style={{ color: C.cyan }}>{t.sym || 'SOL'}</Text>{' '}
            <Text style={s.tradeAt}>po {priceFmt(t.price)}</Text>
          </Text>
          {pnl != null ? (
            <Text style={[s.tradePnl, { color: pnl >= 0 ? C.green : C.red }]}>{signed(pnl)}</Text>
          ) : (
            <Text style={[s.tradePnl, { color: C.dim }]}>{money(t.usd)}</Text>
          )}
        </View>
        <Text style={s.tradeMeta} numberOfLines={2}>
          {clockPl(t.ts)}
          {t.dry ? ' · symulacja' : ''}
          {t.holdMs ? ` · trzymane ${durPl(t.holdMs)}` : ''}
          {pnl != null && t.pnlPct != null ? ` · ${signedPct(t.pnlPct)}` : ''}
        </Text>
        <Text style={s.tradeReason} numberOfLines={2}>
          {t.reason}
        </Text>
      </View>
    </Pressable>
  );
}

function Trejdy({ data }) {
  const [mode, setMode] = useState('bot');
  const { trades, chain } = data;
  const list = useMemo(() => [...(trades || [])].reverse(), [trades]);

  return (
    <>
      <View style={[s.segment, { alignSelf: 'stretch', marginBottom: 14 }]}>
        {[
          ['bot', 'Decyzje bota'],
          ['chain', 'Lancuch'],
        ].map(([k, label]) => (
          <Pressable
            key={k}
            onPress={() => {
              tap();
              setMode(k);
            }}
            style={[s.segBtn, { flex: 1, paddingVertical: 9 }, mode === k && s.segBtnOn]}
          >
            <Text style={[s.segText, mode === k && s.segTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {mode === 'bot' ? (
        list.length ? (
          <Card style={{ paddingVertical: 4 }}>
            {list.map((t, i) => (
              <View key={t.id || i}>
                {i > 0 && <View style={s.rowDivider} />}
                <TradeRow t={t} />
              </View>
            ))}
          </Card>
        ) : (
          <Card>
            <View style={s.emptyBox}>
              <Text style={s.emptyText}>
                Jeszcze zadnych transakcji. Bot wchodzi tylko wtedy, gdy trend, RSI i zmiennosc
                zagraja razem — potrafi przeczekac wiele godzin.
              </Text>
            </View>
          </Card>
        )
      ) : (
        <Card style={{ paddingVertical: 4 }}>
          {chain?.txs?.length ? (
            chain.txs.map((tx, i) => (
              <View key={tx.sig}>
                {i > 0 && <View style={s.rowDivider} />}
                <Pressable
                  onPress={() => Linking.openURL(`https://solscan.io/tx/${tx.sig}`).catch(() => {})}
                  style={({ pressed }) => [s.trade, pressed && { opacity: 0.6 }]}
                >
                  <View
                    style={[
                      s.tradeMark,
                      { backgroundColor: tx.err ? 'rgba(255,77,94,0.14)' : 'rgba(43,255,136,0.10)' },
                    ]}
                  >
                    <Text style={[s.tradeMarkText, { color: tx.err ? C.red : C.green }]}>
                      {tx.err ? 'ERR' : 'OK'}
                    </Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={[s.tradeTitle, { fontFamily: MONO, fontSize: 13 }]}>
                      {shortAddr(tx.sig)}
                    </Text>
                    <Text style={s.tradeMeta}>
                      {tx.ts ? `${clockPl(tx.ts)} · ${ago(tx.ts)}` : `slot ${tx.slot}`}
                    </Text>
                  </View>
                </Pressable>
              </View>
            ))
          ) : (
            <View style={s.emptyBox}>
              <Text style={s.emptyText}>
                Brak transakcji na tym adresie (albo RPC nie odpowiedzial).
              </Text>
            </View>
          )}
        </Card>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ekran: Staty
// ─────────────────────────────────────────────────────────────────────────────

function Staty({ data }) {
  const { stats, state } = data;
  const pf = stats.profitFactor;

  return (
    <>
      <Card>
        <SectionTitle>Skutecznosc</SectionTitle>
        <WinLossBar wins={stats.winsN} losses={stats.lossesN} />
        <View style={[s.statRow, { marginTop: 18 }]}>
          <Stat label="TREJDY" value={String(stats.count)} sub="zamkniete" />
          <Stat
            label="TRAFIENIA"
            value={stats.winRate == null ? '—' : `${nf(stats.winRate * 100, 0)}%`}
            sub={`${stats.winsN}/${stats.count || 0}`}
            tone={stats.winRate > 0.5 ? 'green' : undefined}
          />
          <Stat
            label="PROFIT FACTOR"
            value={pf == null ? '—' : pf === Infinity ? '∞' : nf(pf, 2)}
            sub="zysk / strata"
            tone={pf > 1 ? 'green' : pf != null ? 'red' : undefined}
          />
        </View>
      </Card>

      <Card>
        <SectionTitle>Pieniadze</SectionTitle>
        <Row label="Zysk zrealizowany" value={signed(stats.realized)} tone={stats.realized >= 0 ? 'green' : 'red'} />
        <Row
          label="Zysk otwarty"
          value={stats.positions.length ? signed(stats.unrealized) : '—'}
          tone={stats.positions.length ? (stats.unrealized >= 0 ? 'green' : 'red') : 'dim'}
        />
        <Row label="Razem" value={signed(stats.total)} tone={stats.total >= 0 ? 'green' : 'red'} />
        <View style={s.divider} />
        <Row label="Sredni zysk z wygranej" value={money(stats.avgWin)} tone="green" />
        <Row label="Srednia strata" value={money(stats.avgLoss)} tone="red" />
        <Row
          label="Oczekiwana wartosc trejdu"
          value={stats.expectancy == null ? '—' : signed(stats.expectancy)}
          tone={stats.expectancy >= 0 ? 'green' : 'red'}
        />
        <Row label="Najlepszy trejd" value={stats.best == null ? '—' : signed(stats.best)} tone="green" />
        <Row label="Najgorszy trejd" value={stats.worst == null ? '—' : signed(stats.worst)} tone="red" />
        <View style={s.divider} />
        {state?.withdrawnTotal ? (
          <Row label="Wyplacone z portfela" value={money(state.withdrawnTotal)} tone="cyan" />
        ) : null}
        <Row label="Obrot lacznie" value={money(stats.volume, 0)} tone="dim" />
        <Row
          label="W zlotowkach"
          value={`${nf(stats.total * fxRate, 2)} zl`}
          tone={stats.total >= 0 ? 'green' : 'red'}
        />
      </Card>

      {stats.perAsset.length ? (
        <Card>
          <SectionTitle right={<Text style={s.statSub}>kto zarabia</Text>}>Wedlug aktywa</SectionTitle>
          {stats.perAsset.map((a, i) => {
            const wr = a.trades ? a.wins / a.trades : 0;
            return (
              <View key={a.sym} style={[s.assetRow, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
                <Text style={s.assetSym}>{a.sym}</Text>
                <View style={{ flex: 1 }}>
                  <View style={s.assetBarTrack}>
                    <View
                      style={[
                        s.assetBarFill,
                        {
                          width: `${clamp(wr * 100, 3, 100)}%`,
                          backgroundColor: a.pnl >= 0 ? C.green : C.red,
                        },
                      ]}
                    />
                  </View>
                  <Text style={s.assetMeta}>
                    {a.trades} {a.trades === 1 ? 'trejd' : 'trejdow'} · {nf(wr * 100, 0)}% trafien
                  </Text>
                </View>
                <Text style={[s.assetPnl, { color: a.pnl >= 0 ? C.green : C.red }]}>{signed(a.pnl)}</Text>
              </View>
            );
          })}
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Wynik dzien po dniu</SectionTitle>
        <DayBars days={stats.days} />
        <View style={{ marginTop: 10 }}>
          <Row
            label="Dni na plusie"
            value={String(stats.days.filter((d) => d.pnl > 0).length)}
            tone="green"
          />
          <Row
            label="Dni na minusie"
            value={String(stats.days.filter((d) => d.pnl < 0).length)}
            tone="red"
          />
        </View>
      </Card>

      <Card>
        <SectionTitle>Ryzyko</SectionTitle>
        <Row label="Szczyt kapitalu" value={money(stats.peakEq)} />
        <Row
          label="Obsuniecie teraz"
          value={`${nf(stats.curDD * 100, 2)}%`}
          tone={stats.curDD > 0.1 ? 'red' : 'dim'}
        />
        <Row
          label="Najwieksze obsuniecie"
          value={`${nf(stats.maxDD * 100, 2)}%  (${money(stats.maxDDUsd)})`}
          tone={stats.maxDD > 0.15 ? 'red' : undefined}
        />
        <View style={s.divider} />
        <Row label="Najdluzsza seria wygranych" value={`${stats.bestStreak}`} tone="green" />
        <Row label="Najdluzsza seria strat" value={`${stats.worstStreak}`} tone="red" />
        <Row
          label="Seria teraz"
          value={stats.streakNow === 0 ? '—' : `${Math.abs(stats.streakNow)} ${stats.streakNow > 0 ? 'wygranych' : 'strat'}`}
          tone={stats.streakNow > 0 ? 'green' : stats.streakNow < 0 ? 'red' : 'dim'}
        />
        <Row label="Sredni czas w pozycji" value={durPl(stats.avgHold)} tone="dim" />
      </Card>

      <Card>
        <SectionTitle>Ustawienia bota</SectionTitle>
        <Row label="Tryb" value={state?.mode === 'LIVE' ? 'prawdziwe pieniadze' : 'symulacja'} tone={state?.mode === 'LIVE' ? 'green' : 'amber'} />
        <Row label="Kapital startowy" value={money(stats.start)} />
        <Row label="Limit trejdow na dobe" value={String(state?.day?.trades ?? 0) + ' wykorzystane dzis'} tone="dim" />
        <Row label="Wynik dzisiaj" value={signed(state?.day?.realized ?? 0)} tone={(state?.day?.realized ?? 0) >= 0 ? 'green' : 'red'} />
        <Row label="Bezpiecznik" value={state?.halted ? 'AKTYWNY' : 'wylaczony'} tone={state?.halted ? 'red' : 'dim'} />
        {stats.dryCount > 0 && stats.dryCount < (data.trades?.length || 0) ? (
          <Text style={[s.statSub, { marginTop: 10 }]}>
            Uwaga: {stats.dryCount} z {data.trades.length} wpisow to symulacja — staty mieszaja
            oba tryby.
          </Text>
        ) : null}
      </Card>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ekran: Ustawienia
// ─────────────────────────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, hint, keyboardType }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={s.input}
        value={String(value ?? '')}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
      />
      {hint ? <Text style={s.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

function Ustawienia({ cfg, setCfg, onSaved, data }) {
  const [draft, setDraft] = useState(cfg);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(cfg), [cfg]);

  const set = (k) => (v) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setSaved(false);
  };

  const save = async () => {
    tap();
    const clean = {
      ...draft,
      repo: String(draft.repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
      wallet: String(draft.wallet || '').trim(),
      branch: String(draft.branch || 'main').trim() || 'main',
      rpc: String(draft.rpc || DEFAULTS.rpc).trim() || DEFAULTS.rpc,
      usdPln: Number(String(draft.usdPln).replace(',', '.')) || DEFAULTS.usdPln,
    };
    setCfg(clean);
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(clean));
    setSaved(true);
    onSaved?.();
  };

  return (
    <>
      <Card>
        <SectionTitle>Skad brac dane</SectionTitle>
        <Field
          label="REPOZYTORIUM Z BOTEM"
          value={draft.repo}
          onChange={set('repo')}
          placeholder="twojnick/hajsomat"
          hint="Publiczne repo, w ktorym workflow zapisuje folder state/. Bez tego apka pokaze tylko saldo."
        />
        <Field label="GALAZ" value={draft.branch} onChange={set('branch')} placeholder="main" />
        <Field
          label="ADRES PORTFELA"
          value={draft.wallet}
          onChange={set('wallet')}
          placeholder="zostaw puste — wezmie z state.json"
          hint="Sam klucz publiczny. Klucza prywatnego nigdy nie wpisuj do apki."
        />
      </Card>

      <Pressable style={[s.btn, saved && { backgroundColor: 'rgba(43,255,136,0.18)' }]} onPress={save}>
        <Text style={s.btnText}>{saved ? 'Zapisane ✓' : 'Zapisz i odswiez'}</Text>
      </Pressable>

      {cfg.repo ? (
        <Pressable
          style={[s.btn, s.btnGhost]}
          onPress={() => Linking.openURL(`https://github.com/${cfg.repo}/actions`).catch(() => {})}
        >
          <Text style={[s.btnText, { color: C.cyan }]}>Otworz GitHub Actions</Text>
        </Pressable>
      ) : null}

      <Card style={{ marginTop: 18 }}>
        <SectionTitle>Diagnostyka</SectionTitle>
        <Row label="state.json" value={data.state ? 'wczytany' : 'brak'} tone={data.state ? 'green' : 'red'} />
        <Row label="Wpisy historii" value={String(data.trades?.length || 0)} tone="dim" />
        <Row label="Punkty krzywej" value={String(data.equity?.length || 0)} tone="dim" />
        <Row label="Saldo z lancucha" value={data.chain ? 'ok' : 'brak'} tone={data.chain ? 'green' : 'red'} />
        <Row label="Kurs SOL z Jupitera" value={data.price ? money(data.price) : 'brak'} tone={data.price ? 'green' : 'red'} />
        <Row
          label="Kurs USD/PLN"
          value={data.fx ? `${nf(data.fx.rate, 4)}   (${ago(data.fx.ts)})` : `${nf(cfg.usdPln, 2)}   (zapasowy)`}
          tone={data.fx ? 'green' : 'dim'}
        />
        {data.err ? <Text style={[s.warnText, { marginTop: 10 }]}>{data.err}</Text> : null}
      </Card>

      <Text style={s.footer}>
        Hajsomat czyta i pokazuje. Handluje bot w GitHub Actions — kod masz w repo, w{' '}
        <Text style={s.code}>bot/trade.mjs</Text>.{'\n\n'}
        Handel automatyczny na krypto potrafi stracic caly wklad. Trzymaj tam tylko tyle, ile
        gotow jestes stracic.
      </Text>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Aplikacja
// ─────────────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'kokpit', label: 'Kokpit', icon: 'pulse' },
  { key: 'trejdy', label: 'Trejdy', icon: 'swap' },
  { key: 'staty', label: 'Staty', icon: 'chart' },
  { key: 'ustawienia', label: 'Ustawienia', icon: 'gear' },
];

function Shell() {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState('kokpit');
  const [cfg, setCfg] = useState(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const fxRef = useRef(null);
  const [data, setData] = useState({
    state: null,
    trades: [],
    equity: [],
    chain: null,
    price: null,
    err: null,
    stats: computeStats({ state: null, trades: [], equity: [], price: null, chain: null }),
  });

  // Wczytanie konfiguracji i ostatniego znanego stanu
  useEffect(() => {
    (async () => {
      try {
        const [rawCfg, rawCache] = await Promise.all([
          AsyncStorage.getItem(STORE_KEY),
          AsyncStorage.getItem(CACHE_KEY),
        ]);
        const c = rawCfg ? { ...DEFAULTS, ...JSON.parse(rawCfg) } : DEFAULTS;
        setCfg(c);
        if (rawCache) {
          const cached = JSON.parse(rawCache);
          if (cached.fx?.rate) fxRef.current = cached.fx;
          setData((d) => ({
            ...d,
            ...cached,
            stats: computeStats({ ...cached, price: cached.price }),
          }));
        }
      } catch {
        /* pierwsze uruchomienie */
      }
      setReady(true);
    })();
  }, []);

  const load = useCallback(
    async (silent) => {
      if (!silent) setBusy(true);
      const errs = [];
      let state = null;
      let trades = [];
      let equity = [];
      let chain = null;
      let price = null;

      if (cfg.repo) {
        const [rs, rt, re] = await Promise.allSettled([
          jget(rawUrl(cfg.repo, cfg.branch, 'state.json')),
          jget(rawUrl(cfg.repo, cfg.branch, 'trades.json')),
          jget(rawUrl(cfg.repo, cfg.branch, 'equity.json')),
        ]);
        if (rs.status === 'fulfilled') state = rs.value;
        else errs.push('Nie moge pobrac state.json — sprawdz nazwe repo, galaz i czy repo jest publiczne.');
        if (rt.status === 'fulfilled' && Array.isArray(rt.value)) trades = rt.value;
        if (re.status === 'fulfilled' && Array.isArray(re.value)) equity = re.value;
      }

      const raw = (cfg.wallet || state?.wallet || '').trim();
      const wallet = raw === NO_WALLET ? '' : raw;
      const [rc, rp] = await Promise.allSettled([
        wallet ? fetchChain(cfg.rpc, wallet) : Promise.reject(new Error('brak adresu')),
        fetchPrice(),
      ]);
      if (rc.status === 'fulfilled') chain = rc.value;
      else if (wallet) errs.push('RPC nie oddal salda — publiczny wezel bywa przeciazony.');
      if (raw === NO_WALLET) {
        errs.push('Bot jedzie na wirtualnym kapitale — portfel jeszcze nie podpiety.');
      }
      if (rp.status === 'fulfilled') price = rp.value;
      else price = state?.lastRun?.price ?? null;

      // Kurs USD/PLN sam sie odswieza, ale nie czesciej niz co szesc godzin.
      let fx = fxRef.current;
      if (!fx || Date.now() - fx.ts > FX_TTL) {
        const v = await fetchFx();
        if (v) fx = { rate: v, ts: Date.now() };
      }
      fxRef.current = fx;

      const next = { state, trades, equity, chain, price, fx, err: errs[0] || null };
      setData({ ...next, stats: computeStats(next) });
      setBusy(false);
      try {
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(next));
      } catch {
        /* cache to luksus */
      }
    },
    [cfg]
  );

  useEffect(() => {
    if (ready) load(true);
  }, [ready, load]);

  // Odswiezanie w tle co 45 s, ale tylko gdy apka jest na wierzchu
  useEffect(() => {
    let id = null;
    const start = () => {
      if (!id) id = setInterval(() => load(true), 45000);
    };
    const stop = () => {
      if (id) clearInterval(id);
      id = null;
    };
    start();
    const sub = AppState.addEventListener('change', (st) => (st === 'active' ? (load(true), start()) : stop()));
    return () => {
      stop();
      sub.remove();
    };
  }, [load]);

  if (!ready) {
    return (
      <View style={[s.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={C.green} />
      </View>
    );
  }

  // Kurs pobrany automatycznie; wpis z ustawien sluzy tylko gdy nie ma sieci.
  // Ustawiamy go przed renderem, bo korzystaja z niego wszystkie formatery kwot.
  const fxRate = data.fx?.rate ?? cfg.usdPln;
  setFx(fxRate);

  return (
    <View style={s.root}>
      <LinearGradient
        colors={['#0B1A14', '#06080B', '#06080B']}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height="100%">
          {Array.from({ length: 24 }).map((_, i) => (
            <Line
              key={i}
              x1="0"
              x2="100%"
              y1={i * 48}
              y2={i * 48}
              stroke="#FFFFFF"
              strokeOpacity="0.018"
              strokeWidth="1"
            />
          ))}
        </Svg>
      </View>

      <View style={[s.header, { paddingTop: insets.top + 10 }]}>
        <View>
          <Text style={s.logo}>
            HAJS<Text style={{ color: C.green }}>OMAT</Text>
          </Text>
          <Text style={s.logoSub}>
            {data.state?.mode === 'LIVE' ? 'tryb bojowy' : 'tryb symulacji'} · SOL/USDC
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.headLabel}>KURS SOL</Text>
          <Text style={s.headPrice}>{money(data.price)}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 96 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={busy}
            onRefresh={() => {
              tap();
              load(false);
            }}
            tintColor={C.green}
            colors={[C.green]}
            progressBackgroundColor={C.card}
          />
        }
      >
        {tab === 'kokpit' && <Kokpit data={data} cfg={cfg} goSettings={() => setTab('ustawienia')} />}
        {tab === 'trejdy' && <Trejdy data={data} />}
        {tab === 'staty' && <Staty data={data} />}
        {tab === 'ustawienia' && (
          <Ustawienia cfg={cfg} setCfg={setCfg} data={data} onSaved={() => load(false)} />
        )}
      </ScrollView>

      <View style={[s.tabbar, { paddingBottom: insets.bottom + 8 }]}>
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <Pressable
              key={t.key}
              style={s.tabBtn}
              onPress={() => {
                tap();
                setTab(t.key);
              }}
            >
              <Icon name={t.icon} color={on ? C.green : C.faint} size={21} />
              <Text style={[s.tabLabel, on && { color: C.green }]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <StatusBar style="light" />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Style
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  header: {
    paddingHorizontal: 18,
    paddingBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  logo: { color: C.text, fontSize: 22, fontWeight: '900', letterSpacing: 2 },
  logoSub: { color: C.faint, fontSize: 11, marginTop: 2, letterSpacing: 0.5 },
  headLabel: { color: C.faint, fontSize: 9, fontWeight: '800', letterSpacing: 1.2, marginBottom: 2 },
  headPrice: { color: C.text, fontSize: 18, fontWeight: '700', fontFamily: MONO },

  card: {
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: C.line,
  },

  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  sectionTitle: { color: C.text, fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },

  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { color: C.faint, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },

  bigNumber: {
    color: C.text,
    fontSize: 44,
    fontWeight: '800',
    fontFamily: MONO,
    marginTop: 10,
    letterSpacing: -1,
  },
  bigSub: { color: C.dim, fontSize: 12, marginTop: 4 },

  divider: { height: 1, backgroundColor: C.line, marginVertical: 16 },
  rowDivider: { height: 1, backgroundColor: C.line, marginHorizontal: 14 },

  statRow: { flexDirection: 'row', gap: 12 },
  statLabel: { color: C.faint, fontSize: 9, fontWeight: '800', letterSpacing: 1.1, marginBottom: 5 },
  statValue: { color: C.text, fontSize: 17, fontWeight: '700', fontFamily: MONO },
  statSub: { color: C.faint, fontSize: 11, marginTop: 3 },

  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 7,
  },
  kvLabel: { color: C.dim, fontSize: 13, flex: 1 },
  kvValue: { color: C.text, fontSize: 13, fontWeight: '600' },

  pill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 20,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },

  segment: {
    flexDirection: 'row',
    backgroundColor: C.bg2,
    borderRadius: 10,
    padding: 3,
    borderWidth: 1,
    borderColor: C.line,
  },
  segBtn: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 8, alignItems: 'center' },
  segBtnOn: { backgroundColor: C.cardHi },
  segText: { color: C.faint, fontSize: 12, fontWeight: '700' },
  segTextOn: { color: C.text },

  chartAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  axisText: { color: C.faint, fontSize: 10 },
  chartEmpty: { alignItems: 'center', justifyContent: 'center' },

  emptyBox: { paddingVertical: 18, alignItems: 'center' },
  emptyText: { color: C.dim, fontSize: 13, textAlign: 'center', lineHeight: 19 },

  posBig: { color: C.text, fontSize: 22, fontWeight: '800', fontFamily: MONO },
  posPnl: { fontSize: 22, fontWeight: '800', fontFamily: MONO },
  posHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },

  scanRow: { paddingVertical: 11 },
  scanHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scanDot: { width: 7, height: 7, borderRadius: 4 },
  scanSym: { color: C.text, fontSize: 13, fontWeight: '800', width: 58 },
  scanPrice: { color: C.dim, fontSize: 11, fontFamily: MONO, width: 82 },
  scanBarTrack: { flex: 1, height: 5, borderRadius: 3, backgroundColor: C.bg2, overflow: 'hidden' },
  scanBarFill: { height: '100%', borderRadius: 3 },
  scanScore: { color: C.dim, fontSize: 11, fontFamily: MONO, width: 18, textAlign: 'right' },
  scanReason: { color: C.faint, fontSize: 11, marginTop: 5, marginLeft: 15, lineHeight: 15 },
  scanLegend: { color: C.faint, fontSize: 10, lineHeight: 15, marginTop: 12 },

  assetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  assetSym: { color: C.text, fontSize: 13, fontWeight: '800', width: 62 },
  assetBarTrack: { height: 5, borderRadius: 3, backgroundColor: C.bg2, overflow: 'hidden' },
  assetBarFill: { height: '100%', borderRadius: 3 },
  assetMeta: { color: C.faint, fontSize: 10, marginTop: 5 },
  assetPnl: { fontSize: 13, fontWeight: '800', fontFamily: MONO },

  gaugeTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: C.bg2,
    overflow: 'visible',
    justifyContent: 'center',
  },
  gaugeDot: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    borderWidth: 2,
    borderColor: C.card,
    shadowOpacity: 0.8,
    shadowRadius: 6,
    elevation: 4,
  },
  gaugeEntry: {
    position: 'absolute',
    width: 2,
    height: 16,
    marginLeft: -1,
    backgroundColor: C.dim,
    borderRadius: 1,
  },
  gaugeLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },

  wlBar: { height: 10, borderRadius: 5, flexDirection: 'row', overflow: 'hidden', backgroundColor: C.bg2 },
  wlLegend: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  wlText: { fontSize: 11, fontWeight: '700' },

  actionRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 8 },
  reason: { color: C.text, fontSize: 13, lineHeight: 20 },

  warnBox: {
    backgroundColor: 'rgba(255,176,32,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,176,32,0.25)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  warnTitle: { color: C.amber, fontSize: 13, fontWeight: '800', marginBottom: 4 },
  warnText: { color: C.dim, fontSize: 12, lineHeight: 18 },

  errBanner: {
    backgroundColor: 'rgba(255,77,94,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,77,94,0.28)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  errText: { color: C.red, fontSize: 12, lineHeight: 18 },

  addrBox: {
    marginTop: 14,
    backgroundColor: C.bg2,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: C.line,
  },
  addrText: { color: C.dim, fontSize: 11, fontFamily: MONO },
  addrHint: { color: C.faint, fontSize: 10, marginTop: 5 },

  trade: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 14, paddingHorizontal: 14 },
  tradeMark: { width: 46, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  tradeMarkText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.6 },
  tradeTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  tradeAt: { color: C.dim, fontWeight: '500' },
  tradePnl: { fontSize: 14, fontWeight: '800', fontFamily: MONO },
  tradeMeta: { color: C.faint, fontSize: 11, marginTop: 3 },
  tradeReason: { color: C.dim, fontSize: 11, marginTop: 5, lineHeight: 16 },

  h2: { color: C.text, fontSize: 18, fontWeight: '800', marginBottom: 8 },
  p: { color: C.dim, fontSize: 13, lineHeight: 20, marginBottom: 16 },
  code: { fontFamily: MONO, color: C.cyan, fontSize: 12 },

  fieldLabel: { color: C.faint, fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginBottom: 7 },
  input: {
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 13 : 10,
    color: C.text,
    fontSize: 14,
    fontFamily: MONO,
  },
  fieldHint: { color: C.faint, fontSize: 11, marginTop: 6, lineHeight: 16 },

  btn: {
    backgroundColor: 'rgba(43,255,136,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(43,255,136,0.3)',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  btnGhost: { backgroundColor: 'transparent', borderColor: 'rgba(69,224,255,0.28)' },
  btnText: { color: C.green, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },

  footer: { color: C.faint, fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 8, paddingHorizontal: 10 },

  tabbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    backgroundColor: 'rgba(10,14,19,0.96)',
    borderTopWidth: 1,
    borderTopColor: C.line,
    paddingTop: 10,
  },
  tabBtn: { flex: 1, alignItems: 'center', gap: 3 },
  tabLabel: { color: C.faint, fontSize: 10, fontWeight: '700' },
});
