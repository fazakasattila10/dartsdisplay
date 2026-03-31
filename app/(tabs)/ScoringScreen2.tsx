import { onValue, push, ref, set } from 'firebase/database';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { db } from '../../lib/firebase';
import { generateVirtualLeg } from './virtualDarts';

type Props = {
  onExit: () => void;
  clubId: string;
  initialBoardNr?: number | null;
};

type PlayerStats = {
  name: string;
  score: number;
  legs: number;
  dartsThrownTotal: number;
  pointsScoredTotal: number;
  legDartsThrown: number;
  legPointsScored: number;
  c100: number;
  c140: number;
  c180: number;
  wonLegs: number;
  wonLegDartsTotal: number;
  bestLegDarts: number | null;
  highOut: number;
};

type ThrowMsg = {
  v: number;
  ts: number;
  by: string;
  dUsed?: 1 | 2 | 3;
};

type SetupDraft = {
  player1: string;
  player2: string;
  vsVirtual: boolean;
  virtualLevel: number;
  virtualSide: 0 | 1;
};

type MatchConfig = {
  vsVirtual: boolean;
  virtualLevel: number;
  virtualSide: 0 | 1;
};

type VirtualPlanState = {
  darts: number[];
  turns: number[];
  turnIndex: number;
  dartIndex: number;
} | null;
function cloneVirtualPlan(plan: VirtualPlanState): VirtualPlanState {
  if (!plan) return null;
  return {
    darts: [...plan.darts],
    turns: [...plan.turns],
    turnIndex: plan.turnIndex,
    dartIndex: plan.dartIndex,
  };
}

const ensureScoringFullscreen = () => {
  if (typeof document === 'undefined') return;
  if (document.fullscreenElement) return;
  void ensureDocFullscreen().catch(() => {});
};


const PLAYER_NAME_HISTORY_KEY = 'scoring2.playerNameHistory';
const START_SCORE = 501;
const MAX_CHECKOUT = 170;
const BOGEY_OUTS = new Set([169, 168, 166, 165, 163, 162, 159]);
const QUICK_PORTRAIT_ROWS: Array<Array<{ label: string; kind?: 'num' | 'action' | 'quick'; value?: number }>> = [
  [{ label: '1' }, { label: '2' }, { label: '3' }],
  [{ label: '4' }, { label: '5' }, { label: '6' }],
  [{ label: '7' }, { label: '8' }, { label: '9' }],
  [{ label: 'OK', kind: 'action' }, { label: '0' }, { label: 'DEL', kind: 'action' }],
  [
    { label: 'LEFT', kind: 'action' },
    { label: '60', kind: 'quick', value: 60 },
    { label: 'UNDO', kind: 'action' },
  ],
  [
    { label: '121', kind: 'quick', value: 121 },
    { label: '125', kind: 'quick', value: 125 },
    { label: '140', kind: 'quick', value: 140 },
  ],
  [
    { label: '81', kind: 'quick', value: 81 },
    { label: '85', kind: 'quick', value: 85 },
    { label: '100', kind: 'quick', value: 100 },
  ],
  [
    { label: '26', kind: 'quick', value: 26 },
    { label: '41', kind: 'quick', value: 41 },
    { label: '45', kind: 'quick', value: 45 },
  ],
];
const VIRTUAL_PREF_KEY = 'scoring2.virtualPrefs';
const FRESH_LIMIT_MS = 2 * 60 * 1000;
const INACTIVITY_MS = 3 * 60 * 1000;
const INACTIVITY_CHECK_MS = 3 * 60 * 1000;

function isCheckoutPossible(remaining: number) {
  return remaining > 0 && remaining <= MAX_CHECKOUT && !BOGEY_OUTS.has(remaining);
}
function getCheckoutDartOptions(remaining: number): Array<1 | 2 | 3> {
  if (remaining >= 99) {
    if ([100, 101, 104, 107, 110].includes(remaining)) return [2, 3];
    return [3];
  }
  if (remaining >= 41 && remaining !== 50) return [2, 3];
  return [1, 2, 3];
}
const clampToDigits = (s: string) => s.replace(/[^\d]/g, '');
const toInt = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
function format2AndroidLike(n: number) {
  const s2 = n.toFixed(2);
  if (s2.endsWith('00')) return n.toFixed(1);
  if (s2.endsWith('0')) return n.toFixed(1);
  return s2;
}
function freshPlayer(name: string): PlayerStats {
  return {
    name,
    score: START_SCORE,
    legs: 0,
    dartsThrownTotal: 0,
    pointsScoredTotal: 0,
    legDartsThrown: 0,
    legPointsScored: 0,
    c100: 0,
    c140: 0,
    c180: 0,
    wonLegs: 0,
    wonLegDartsTotal: 0,
    bestLegDarts: null,
    highOut: 0,
  };
}
function makeClientId() {
  return Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36).slice(-4);
}
function parseScoreTail(raw: string | null): { deviceInfo: string | null; ts: number } {
  if (!raw) return { deviceInfo: null, ts: 0 };
  const parts = raw.trim().split('_');
  if (parts.length < 2) return { deviceInfo: null, ts: 0 };
  const tsMaybe = Number(parts[parts.length - 1]);
  const ts = Number.isFinite(tsMaybe) ? Math.trunc(tsMaybe) : 0;
  const deviceInfo = parts.length >= 24 ? parts[parts.length - 2] || null : null;
  return { deviceInfo, ts };
}
function loadVirtualPrefs(): { enabled: boolean; level: number; side: 0 | 1 } {
  try {
    if (typeof window === 'undefined') return { enabled: false, level: 5, side: 1 };
    const raw = window.localStorage.getItem(VIRTUAL_PREF_KEY);
    if (!raw) return { enabled: false, level: 5, side: 1 };
    const parsed = JSON.parse(raw);
    const level = Math.max(1, Math.min(12, Number(parsed?.level) || 5));
    const side: 0 | 1 = parsed?.side === 0 ? 0 : 1;
    return { enabled: !!parsed?.enabled, level, side };
  } catch {
    return { enabled: false, level: 5, side: 1 };
  }
}
function saveVirtualPrefs(v: { enabled: boolean; level: number; side: 0 | 1 }) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(VIRTUAL_PREF_KEY, JSON.stringify(v));
  } catch {}
}
function loadPlayerNameHistory(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(PLAYER_NAME_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function savePlayerNameHistory(names: string[]) {
  try {
    if (typeof window === 'undefined') return;
    const cleaned = Array.from(
      new Set(
        names
          .map((v) => String(v || '').trim())
          .filter(Boolean)
      )
    ).slice(0, 20);

    window.localStorage.setItem(PLAYER_NAME_HISTORY_KEY, JSON.stringify(cleaned));
  } catch {}
}
type WakeLockSentinelLike = {
  released?: boolean;
  release?: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

type WakeLockState = {
  supported: boolean;
  active: boolean;
  error: string | null;
};

function useDisplayWakeLock(enabled: boolean) {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);
  const requestInFlightRef = useRef(false);
  const [state, setState] = useState<WakeLockState>(() => ({
    supported: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
    active: false,
    error: null,
  }));

  const releaseWakeLock = useCallback(async () => {
    const current = sentinelRef.current;
    sentinelRef.current = null;

    if (!current?.release) {
      setState((prev) => ({ ...prev, active: false }));
      return;
    }

    try {
      await current.release();
    } catch {}

    setState((prev) => ({ ...prev, active: false }));
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (!enabled) return false;
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (!('wakeLock' in navigator)) {
      setState({ supported: false, active: false, error: null });
      return false;
    }
    if (document.visibilityState !== 'visible') return false;
    if (sentinelRef.current && !sentinelRef.current.released) {
      setState((prev) => ({ ...prev, supported: true, active: true, error: null }));
      return true;
    }
    if (requestInFlightRef.current) return false;

    requestInFlightRef.current = true;
    try {
      const wakeLockApi = (navigator as Navigator & {
        wakeLock?: { request?: (type: 'screen') => Promise<WakeLockSentinelLike> };
      }).wakeLock;

      const sentinel = await wakeLockApi?.request?.('screen');
      if (!sentinel) {
        setState({ supported: true, active: false, error: 'Wake lock not granted.' });
        return false;
      }

      const handleRelease = () => {
        sentinelRef.current = null;
        setState((prev) => ({ ...prev, active: false }));
      };

      sentinel.addEventListener?.('release', handleRelease);
      sentinelRef.current = sentinel;
      setState({ supported: true, active: true, error: null });
      return true;
    } catch (err: any) {
      setState({
        supported: true,
        active: false,
        error: err?.message ?? 'Wake lock request failed.',
      });
      return false;
    } finally {
      requestInFlightRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      void releaseWakeLock();
      return;
    }

    void requestWakeLock();

    const retry = () => {
      if (!enabled) return;
      void requestWakeLock();
    };

    document.addEventListener('visibilitychange', retry);
    window.addEventListener('focus', retry);
    window.addEventListener('pageshow', retry);
    window.addEventListener('pointerdown', retry, { passive: true });
    window.addEventListener('touchstart', retry, { passive: true });
    window.addEventListener('keydown', retry);

    return () => {
      document.removeEventListener('visibilitychange', retry);
      window.removeEventListener('focus', retry);
      window.removeEventListener('pageshow', retry);
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('touchstart', retry);
      window.removeEventListener('keydown', retry);
      void releaseWakeLock();
    };
  }, [enabled, releaseWakeLock, requestWakeLock]);

  return state;
}
export default function ScoringScreen2({ onExit, clubId, initialBoardNr }: Props) {
  const { width, height } = useWindowDimensions();
  const isPortrait = height >= width;
  const wakeLock = useDisplayWakeLock(true);
    const initialVirtualPrefs = useMemo(() => loadVirtualPrefs(), []);
  const [playerNameHistory, setPlayerNameHistory] = useState<string[]>(() => loadPlayerNameHistory());
  const [players, setPlayers] = useState<[PlayerStats, PlayerStats]>(() => [freshPlayer('PL.1'), freshPlayer('PL.2')]);
  const [active, setActive] = useState<0 | 1>(0);
  const [input, setInput] = useState('');
  const [legStarter, setLegStarter] = useState<0 | 1>(0);
  const [lastThrow, setLastThrow] = useState<[number, number]>([0, 0]);
  const [hasLegStarted, setHasLegStarted] = useState(false);
  const [showInactiveDialog, setShowInactiveDialog] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [pendingCheckout, setPendingCheckout] = useState<null | { player: 0 | 1; checkoutValue: number }>(null);
  const [boardNr, setBoardNr] = useState<number | null>(() => initialBoardNr ?? null);
  const [saveInProgress, setSaveInProgress] = useState(false);
  const [showNamesDialog, setShowNamesDialog] = useState(false);
  const [showMenuDialog1, setShowMenuDialog1] = useState(false);

  const [showMenuName1Suggestions, setShowMenuName1Suggestions] = useState(false);
  const [showMenuName2Suggestions, setShowMenuName2Suggestions] = useState(false);
  const [showMenuDialog2, setShowMenuDialog2] = useState(false);
  const [showBoardDialog, setShowBoardDialog] = useState(false);
  const [showLevelPicker, setShowLevelPicker] = useState(false);
  const [menuBoardTmp, setMenuBoardTmp] = useState<number | null>(null);
  const [warnedBusyBoard, setWarnedBusyBoard] = useState<number | null>(null);
  const [showOnlineInfo, setShowOnlineInfo] = useState(false);

  const [matchConfig, setMatchConfig] = useState<MatchConfig>({
    vsVirtual: false,
    virtualLevel: initialVirtualPrefs.level,
    virtualSide: initialVirtualPrefs.side,
  });
  const [draft, setDraft] = useState<SetupDraft>({
    player1: players[0].name,
    player2: players[1].name,
    vsVirtual: initialVirtualPrefs.enabled,
    virtualLevel: initialVirtualPrefs.level,
    virtualSide: initialVirtualPrefs.side,
  });
  const [name1Touched, setName1Touched] = useState(false);
  const [name2Touched, setName2Touched] = useState(false);

  const legStarterRef = useRef<0 | 1>(0);
  const playersRef = useRef(players);
  const lastThrowRef = useRef(lastThrow);
  const activeRef = useRef(active);
  const hasLegStartedRef = useRef(hasLegStarted);
  const undoStack = useRef<
  Array<{
    players: [PlayerStats, PlayerStats];
    active: 0 | 1;
    lastThrow: [number, number];
    virtualPlan: VirtualPlanState;
  }>
>([]);
  const lastLocalSendRef = useRef<number>(0);
  const clientIdRef = useRef<string>(makeClientId());
  const deviceInfoRef = useRef<string>(clientIdRef.current);
  const virtualPlanRef = useRef<VirtualPlanState>(null);
  const virtualTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { legStarterRef.current = legStarter; }, [legStarter]);
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { lastThrowRef.current = lastThrow; }, [lastThrow]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { hasLegStartedRef.current = hasLegStarted; }, [hasLegStarted]);
  useEffect(() => { setBoardNr(initialBoardNr ?? null); }, [initialBoardNr]);

  const [myRole, setMyRole] = useState<null | 'L' | 'R'>(null);
  const [onlineDisabled, setOnlineDisabled] = useState(false);
  const onlineDisabledRef = useRef(false);
  const lastSeenLRef = useRef<number>(0);
  const lastSeenRRef = useRef<number>(0);
  const subscribedAtRef = useRef<number>(0);
  const [showOnlineDetectedDialog, setShowOnlineDetectedDialog] = useState(false);
  const onlineDialogShownForBoardRef = useRef<string | null>(null);
  const prevOnlineRef = useRef(false);

  useEffect(() => { onlineDisabledRef.current = onlineDisabled; }, [onlineDisabled]);

  const [boardTailMap, setBoardTailMap] = useState<Record<number, { deviceInfo: string | null; ts: number }>>({
    1: { deviceInfo: null, ts: 0 }, 2: { deviceInfo: null, ts: 0 }, 3: { deviceInfo: null, ts: 0 }, 4: { deviceInfo: null, ts: 0 },
    5: { deviceInfo: null, ts: 0 }, 6: { deviceInfo: null, ts: 0 }, 7: { deviceInfo: null, ts: 0 }, 8: { deviceInfo: null, ts: 0 },
  });

  const myPlayerIdx: 0 | 1 | null = useMemo(() => (myRole === 'L' ? 0 : myRole === 'R' ? 1 : null), [myRole]);
  const isOnline = !matchConfig.vsVirtual && myRole != null && !onlineDisabled;
  const virtualSide = matchConfig.vsVirtual ? matchConfig.virtualSide : null;
  const activeIsHuman = virtualSide == null || active !== virtualSide;
  const canInteract = (isOnline ? (myPlayerIdx == null ? true : active === myPlayerIdx) : true) && activeIsHuman;
  const canSaveStats = !!clubId?.trim() && boardNr != null;
  const isCurrentVirtualMatch = matchConfig.vsVirtual;

  const avg = (p: PlayerStats) => (p.dartsThrownTotal > 0 ? p.pointsScoredTotal / p.dartsThrownTotal : 0);
  const avgX3 = (p: PlayerStats) => avg(p) * 3;
  const legAvg = (p: PlayerStats) => (p.legDartsThrown > 0 ? p.legPointsScored / p.legDartsThrown : 0);
  const wonAvg = (p: PlayerStats) => (p.wonLegDartsTotal > 0 ? (p.wonLegs * START_SCORE) / p.wonLegDartsTotal : 0);
const [pendingVirtualCheckout, setPendingVirtualCheckout] = useState<null | {
  nextPlayers: [PlayerStats, PlayerStats];
  nextLegStarter: 0 | 1;
}>(null);

  const markLocalFirebaseSend = () => { lastLocalSendRef.current = Date.now(); };
 const pushUndo = () => {
  const cloned: [PlayerStats, PlayerStats] = [{ ...playersRef.current[0] }, { ...playersRef.current[1] }];
  undoStack.current.push({
    players: cloned,
    active: activeRef.current,
    lastThrow: [...lastThrowRef.current] as [number, number],
    virtualPlan: cloneVirtualPlan(virtualPlanRef.current),
  });
};
  const clearUndoForNewLeg = () => {
    undoStack.current = [];
    setHasLegStarted(false);
  };
  const safeSetInputWith180Limit = (next: string) => {
    if (!canInteract) return;
    const digits = clampToDigits(next).slice(0, 3);
    if (!digits) return setInput('');
    const n = toInt(digits);
    if (n > 180) {
      const trimmed = digits.slice(0, -1);
      const t = trimmed ? toInt(trimmed) : 0;
      setInput(trimmed && t <= 180 ? trimmed : '');
      return;
    }
    setInput(digits);
  };
  const onDigit = (d: number) => {
    ensureScoringFullscreen();
    canInteract && safeSetInputWith180Limit(`${input}${d}`);
  };
  const onDel = () => {
    ensureScoringFullscreen();
    canInteract && input && setInput(input.slice(0, -1));
  };


  function buildAndroidValueString() {
    const p1 = playersRef.current[0];
    const p2 = playersRef.current[1];
    const ts = Date.now();
    const currentLastThrow = lastThrowRef.current;
    return [
      p1.name,
      p2.name,
      String(p1.score),
      String(p2.score),
      String(currentLastThrow[0] || 0),
      String(currentLastThrow[1] || 0),
      String(p1.legDartsThrown),
      String(p2.legDartsThrown),
      String(p1.legs),
      String(p2.legs),
      format2AndroidLike(avg(p1)),
      format2AndroidLike(avg(p2)),
      format2AndroidLike(avgX3(p1)),
      format2AndroidLike(avgX3(p2)),
      String(p1.c100),
      String(p2.c100),
      String(p1.c140),
      String(p2.c140),
      String(p1.c180),
      String(p2.c180),
      String(p1.highOut),
      String(p2.highOut),
      String(deviceInfoRef.current),
      String(ts),
    ].join('_');
  }

  async function pushToFirebase() {
    if (boardNr == null) return;
    markLocalFirebaseSend();
    try {
      await set(ref(db, `score/${clubId}/${boardNr}`), buildAndroidValueString());
    } catch {}
  }

  async function saveStatsToHistory() {
    if (!canSaveStats || saveInProgress) return;
    try {
      setSaveInProgress(true);
      const value = buildAndroidValueString().trim();
      if (!value || value === '—') return;
      await push(ref(db, `history/${clubId}/${boardNr}`), value);
    } catch {} finally {
      setSaveInProgress(false);
    }
  }

  async function writeThrow(side: 'L' | 'R', msg: ThrowMsg) {
    if (boardNr == null) return;
    markLocalFirebaseSend();
    try {
      await set(ref(db, `throws/${clubId}/${boardNr}/${side}`), msg);
    } catch {}
  }
  const playerIdxToSide = (pIdx: 0 | 1): 'L' | 'R' => (pIdx === 0 ? 'L' : 'R');

  const prepareVirtualPlan = (level = matchConfig.virtualLevel) => {
    if (!matchConfig.vsVirtual) {
      virtualPlanRef.current = null;
      return;
    }
    const plan = generateVirtualLeg(level);
    virtualPlanRef.current = { darts: plan.darts, turns: plan.turns, turnIndex: 0, dartIndex: 0 };
  };

  const resetOnlineState = () => {
    setMyRole(null);
    lastSeenLRef.current = 0;
    lastSeenRRef.current = 0;
    subscribedAtRef.current = Date.now();
  };

  const finalizeNewLeg = (nextPlayers: [PlayerStats, PlayerStats], nextLegStarter: 0 | 1) => {
    playersRef.current = nextPlayers;
    lastThrowRef.current = [0, 0];
    setPlayers(nextPlayers);
    setPendingCheckout(null);
    setShowCheckout(false);
    clearUndoForNewLeg();
    setLastThrow([0, 0]);
    setLegStarter(nextLegStarter);
    setActive(nextLegStarter);
    if (matchConfig.vsVirtual) prepareVirtualPlan(matchConfig.virtualLevel);
  };

  const applyScoringAs = (
    pIdx: 0 | 1,
    opts: { kind: 'score' | 'left' | 'check'; value?: number; allowZero?: boolean },
    source: 'local' | 'remote' | 'virtual',
    remoteCheckoutDartsUsed?: 1 | 2 | 3
  ) => {
    const curPlayers = playersRef.current;
    const curLastThrow = lastThrowRef.current;
    const p = curPlayers[pIdx];
    const oppIdx: 0 | 1 = pIdx === 0 ? 1 : 0;
    let throwValue = 0;

    if (opts.kind === 'check') {
      if (!isCheckoutPossible(p.score)) return { applied: false as const };
      throwValue = p.score;
    } else if (opts.kind === 'score') {
      throwValue = opts.value ?? 0;
      if (throwValue > 180) return { applied: false as const };
    } else {
      const left = opts.value ?? 0;
      if (left === 0 && !isCheckoutPossible(p.score)) return { applied: false as const };
      throwValue = p.score - left;
      if (throwValue > 180) return { applied: false as const };
      if (throwValue < 0) throwValue = 0;
    }

    const allowZero = opts.kind === 'score' && throwValue === 0 && opts.allowZero === true;
    if (opts.kind !== 'check' && throwValue <= 0 && !allowZero) {
      if (source === 'local') setInput('');
      return { applied: false as const };
    }

    if (!hasLegStartedRef.current) {
      setHasLegStarted(true);
      setLegStarter(activeRef.current);
    }
    if (source === 'local') pushUndo();

    const prevScore = p.score;
    const tentative = prevScore - throwValue;
    const wasBust = tentative < 0 || tentative === 1;
    const isCheckout = !wasBust && tentative === 0;
    const nextLastThrow: [number, number] = [...curLastThrow] as [number, number];
    nextLastThrow[pIdx] = throwValue;

    if (wasBust) {
      const nextPlayers: [PlayerStats, PlayerStats] = [{ ...curPlayers[0] }, { ...curPlayers[1] }];
      const np = { ...nextPlayers[pIdx] };
      np.dartsThrownTotal += 3;
      np.legDartsThrown += 3;
      nextPlayers[pIdx] = np;
      playersRef.current = nextPlayers;
      lastThrowRef.current = nextLastThrow;
      setPlayers(nextPlayers);
      setLastThrow(nextLastThrow);
      if (source === 'local') setInput('');
      setActive(oppIdx);
      return { applied: true as const, throwValue, isCheckout: false as const, wasBust: true as const };
    }

    if (isCheckout) {
      lastThrowRef.current = nextLastThrow;
      setLastThrow(nextLastThrow);

      if (source === 'local') {
        setPendingCheckout({ player: pIdx, checkoutValue: throwValue });
        setShowCheckout(true);
        setInput('');
        return { applied: true as const, throwValue, isCheckout: true as const, wasBust: false as const };
      }

     if (!remoteCheckoutDartsUsed) return { applied: false as const };

const nextPlayers: [PlayerStats, PlayerStats] = [{ ...curPlayers[0] }, { ...curPlayers[1] }];
const np = { ...nextPlayers[pIdx] };
np.dartsThrownTotal += remoteCheckoutDartsUsed;
np.pointsScoredTotal += throwValue;
np.legDartsThrown += remoteCheckoutDartsUsed;
np.legPointsScored += throwValue;

if (throwValue >= 100 && throwValue < 140) np.c100 += 1;
if (throwValue >= 140 && throwValue < 180) np.c140 += 1;
if (throwValue === 180) np.c180 += 1;

np.legs += 1;
np.wonLegs += 1;
np.wonLegDartsTotal += np.legDartsThrown;
np.bestLegDarts = np.bestLegDarts == null ? np.legDartsThrown : Math.min(np.bestLegDarts, np.legDartsThrown);
np.highOut = Math.max(np.highOut, throwValue);

const other = { ...nextPlayers[oppIdx] };

np.score = START_SCORE;
other.score = START_SCORE;

np.legDartsThrown = 0;
np.legPointsScored = 0;
other.legDartsThrown = 0;
other.legPointsScored = 0;

nextPlayers[pIdx] = np;
nextPlayers[oppIdx] = other;

const nextLegStarter: 0 | 1 = legStarterRef.current === 0 ? 1 : 0;

if (source === 'virtual') {
  setPendingVirtualCheckout({ nextPlayers, nextLegStarter });
  return { applied: true as const, throwValue, isCheckout: true as const, wasBust: false as const };
}

finalizeNewLeg(nextPlayers, nextLegStarter);
return { applied: true as const, throwValue, isCheckout: true as const, wasBust: false as const };
    }

    const nextPlayers: [PlayerStats, PlayerStats] = [{ ...curPlayers[0] }, { ...curPlayers[1] }];
    const np = { ...nextPlayers[pIdx] };
    np.score = tentative;
    np.dartsThrownTotal += 3;
    np.pointsScoredTotal += throwValue;
    np.legDartsThrown += 3;
    np.legPointsScored += throwValue;
    if (throwValue >= 100 && throwValue < 140) np.c100 += 1;
    if (throwValue >= 140 && throwValue < 180) np.c140 += 1;
    if (throwValue === 180) np.c180 += 1;
    nextPlayers[pIdx] = np;
    playersRef.current = nextPlayers;
    lastThrowRef.current = nextLastThrow;
    setPlayers(nextPlayers);
    setLastThrow(nextLastThrow);
    if (source === 'local') setInput('');
    setActive(oppIdx);
    return { applied: true as const, throwValue, isCheckout: false as const, wasBust: false as const };
  };

  const confirmCheckout = (dartsUsed: 1 | 2 | 3) => {
    if (!canInteract) return;
    const pending = pendingCheckout;
    if (!pending) {
      setShowCheckout(false);
      return;
    }
    const curPlayers = playersRef.current;
    const pIdx = pending.player;
    const oppIdx: 0 | 1 = pIdx === 0 ? 1 : 0;
    const throwValue = pending.checkoutValue;
    const nextPlayers: [PlayerStats, PlayerStats] = [{ ...curPlayers[0] }, { ...curPlayers[1] }];
    const np = { ...nextPlayers[pIdx] };
    np.dartsThrownTotal += dartsUsed;
    np.pointsScoredTotal += throwValue;
    np.legDartsThrown += dartsUsed;
    np.legPointsScored += throwValue;
    if (throwValue >= 100 && throwValue < 140) np.c100 += 1;
    if (throwValue >= 140 && throwValue < 180) np.c140 += 1;
    if (throwValue === 180) np.c180 += 1;
    np.legs += 1;
    np.wonLegs += 1;
    np.wonLegDartsTotal += np.legDartsThrown;
    np.bestLegDarts = np.bestLegDarts == null ? np.legDartsThrown : Math.min(np.bestLegDarts, np.legDartsThrown);
    np.highOut = Math.max(np.highOut, throwValue);
    const other = { ...nextPlayers[oppIdx] };
    np.score = START_SCORE;
    other.score = START_SCORE;
    np.legDartsThrown = 0;
    np.legPointsScored = 0;
    other.legDartsThrown = 0;
    other.legPointsScored = 0;
    nextPlayers[pIdx] = np;
    nextPlayers[oppIdx] = other;
    const nextLegStarter: 0 | 1 = legStarterRef.current === 0 ? 1 : 0;
    finalizeNewLeg(nextPlayers, nextLegStarter);
    setInput('');
    if (boardNr != null) {
      const side = playerIdxToSide(pIdx);
      void writeThrow(side, { v: throwValue, ts: Date.now(), by: clientIdRef.current, dUsed: dartsUsed });
    }
  };
const confirmVirtualCheckoutOk = () => {
  if (!pendingVirtualCheckout) return;

  finalizeNewLeg(
    pendingVirtualCheckout.nextPlayers,
    pendingVirtualCheckout.nextLegStarter
  );
  setPendingVirtualCheckout(null);
  setInput('');
};
  const applyScoring = (opts: { kind: 'score' | 'left' | 'check'; value?: number; allowZero?: boolean }) => {
    if (!canInteract) return;
    const pIdx = active;
    if (isOnline && myPlayerIdx != null && pIdx !== myPlayerIdx) return;
    const res = applyScoringAs(pIdx, opts, 'local');
    if (res.applied && !res.isCheckout && boardNr != null && !matchConfig.vsVirtual) {
      const side = playerIdxToSide(pIdx);
      void writeThrow(side, { v: res.throwValue, ts: Date.now(), by: clientIdRef.current });
    }
  };

  const onOk = () => {
     ensureScoringFullscreen();
    if (!canInteract || input === '') return;
    const v = toInt(input);
    applyScoring({ kind: 'score', value: v, allowZero: input === '0' });
  };
  const onLeft = () => canInteract && applyScoring({ kind: 'left', value: toInt(input || '0') });
  const onQuick = (v: number) => {
    ensureScoringFullscreen();
    canInteract && applyScoring({ kind: 'score', value: v });
  };
const onUndo = () => {
  if (isOnline) return;
  if (!canInteract && pendingVirtualCheckout == null) return;

  const prev = undoStack.current.pop();
  if (!prev) return;

  if (virtualTimeoutRef.current) {
    clearTimeout(virtualTimeoutRef.current);
    virtualTimeoutRef.current = null;
  }

  virtualPlanRef.current = cloneVirtualPlan(prev.virtualPlan);
  playersRef.current = prev.players;
  lastThrowRef.current = prev.lastThrow;

  setPendingVirtualCheckout(null);
  setShowCheckout(false);
  setPlayers(prev.players);
  setActive(prev.active);
  setLastThrow(prev.lastThrow);
  setInput('');

  if (undoStack.current.length === 0) setHasLegStarted(false);
};
  useEffect(() => { void pushToFirebase(); }, [players, lastThrow, boardNr]);

  useEffect(() => {
    if (boardNr == null) {
      lastLocalSendRef.current = 0;
      return;
    }
    markLocalFirebaseSend();
    const id = setInterval(() => {
      if (boardNr == null) return;
      const last = lastLocalSendRef.current || 0;
      if (!last) return;
      if (Date.now() - last > INACTIVITY_MS) {
        setBoardNr(null);
        resetOnlineState();
        setShowMenuDialog2(false);
        setShowInactiveDialog(true);
      }
    }, INACTIVITY_CHECK_MS);
    return () => clearInterval(id);
  }, [boardNr]);

  useEffect(() => {
    if (!showMenuDialog2) return;
    const unsubs = [1,2,3,4,5,6,7,8].map((n) => onValue(ref(db, `score/${clubId}/${n}`), (snap) => {
      const raw = snap.val() == null ? null : String(snap.val());
      setBoardTailMap((prev) => ({ ...prev, [n]: parseScoreTail(raw) }));
    }));
    return () => unsubs.forEach((u) => u());
  }, [showMenuDialog2, clubId]);
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName || '').toLowerCase();

      // ha inputba ír (pl. név dialog), NE nyúljunk bele
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
        return;
      }

      // csak akkor működjön, ha tényleg lehet interakció
      if (!canInteract) return;

      // számok
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        onDigit(Number(e.key));
        return;
      }

      // enter = OK
      if (e.key === 'Enter') {
        e.preventDefault();
        onOk();
        return;
      }

      // törlés
      if (e.key === 'Backspace') {
        e.preventDefault();
        onDel();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canInteract, input]);
  useEffect(() => {
    resetOnlineState();
    if (boardNr == null || onlineDisabled || matchConfig.vsVirtual) return;
    const lRef = ref(db, `throws/${clubId}/${boardNr}/L`);
    const rRef = ref(db, `throws/${clubId}/${boardNr}/R`);
    const unsubL = onValue(lRef, (snap) => {
      if (onlineDisabledRef.current) return;
      const v = snap.val() as ThrowMsg | null;
      if (!v || typeof v !== 'object') return;
      if (v.by === clientIdRef.current) return;
      if (!v.ts || v.ts <= lastSeenLRef.current) return;
      if (v.ts <= subscribedAtRef.current) return;
      lastSeenLRef.current = v.ts;
      setMyRole((prev) => (onlineDisabledRef.current ? null : prev ?? 'R'));
      if (typeof v.v === 'number' && v.v >= 0) {
        const isCheckoutMsg = typeof v.dUsed === 'number';
        if (isCheckoutMsg) applyScoringAs(0, { kind: 'score', value: v.v, allowZero: v.v === 0 }, 'remote', v.dUsed);
        else applyScoringAs(0, { kind: 'score', value: v.v, allowZero: v.v === 0 }, 'remote');
      }
    });
    const unsubR = onValue(rRef, (snap) => {
      if (onlineDisabledRef.current) return;
      const v = snap.val() as ThrowMsg | null;
      if (!v || typeof v !== 'object') return;
      if (v.by === clientIdRef.current) return;
      if (!v.ts || v.ts <= lastSeenRRef.current) return;
      if (v.ts <= subscribedAtRef.current) return;
      lastSeenRRef.current = v.ts;
      setMyRole((prev) => (onlineDisabledRef.current ? null : prev ?? 'L'));
      if (typeof v.v === 'number' && v.v >= 0) {
        const isCheckoutMsg = typeof v.dUsed === 'number';
        if (isCheckoutMsg) applyScoringAs(1, { kind: 'score', value: v.v, allowZero: v.v === 0 }, 'remote', v.dUsed);
        else applyScoringAs(1, { kind: 'score', value: v.v, allowZero: v.v === 0 }, 'remote');
      }
    });
    return () => { unsubL(); unsubR(); };
  }, [boardNr, clubId, onlineDisabled, matchConfig.vsVirtual]);

  useEffect(() => {
    const onlineNow = !matchConfig.vsVirtual && myRole != null && !onlineDisabledRef.current;
    if (boardNr == null) {
      prevOnlineRef.current = onlineNow;
      return;
    }
    if (onlineDisabledRef.current || matchConfig.vsVirtual) {
      prevOnlineRef.current = onlineNow;
      return;
    }
    const key = `${clubId}:${boardNr}`;
    if (onlineNow && !prevOnlineRef.current && onlineDialogShownForBoardRef.current !== key) {
      onlineDialogShownForBoardRef.current = key;
      setShowOnlineDetectedDialog(true);
    }
    prevOnlineRef.current = onlineNow;
  }, [myRole, boardNr, clubId, onlineDisabled, matchConfig.vsVirtual]);

  useEffect(() => {
    if (!matchConfig.vsVirtual || active !== matchConfig.virtualSide) return;
    if (virtualTimeoutRef.current) clearTimeout(virtualTimeoutRef.current);
    virtualTimeoutRef.current = setTimeout(() => {
      const plan = virtualPlanRef.current;
      if (!plan) {
        prepareVirtualPlan(matchConfig.virtualLevel);
      }
      const actualPlan = virtualPlanRef.current;
      if (!actualPlan) return;
      const turnValue = actualPlan.turns[actualPlan.turnIndex] ?? 0;
      const remainingDarts = actualPlan.darts.length - actualPlan.dartIndex;
      const isFinalTurn = remainingDarts <= 3;
      const dartsUsed = (isFinalTurn ? Math.max(1, Math.min(3, remainingDarts)) : 3) as 1 | 2 | 3;
      const res = applyScoringAs(matchConfig.virtualSide, { kind: 'score', value: turnValue, allowZero: turnValue === 0 }, 'virtual', isFinalTurn ? dartsUsed : undefined);
      if (res.applied) {
        actualPlan.turnIndex += 1;
        actualPlan.dartIndex += isFinalTurn ? dartsUsed : 3;
      }
    }, 650);
    return () => {
      if (virtualTimeoutRef.current) clearTimeout(virtualTimeoutRef.current);
    };
 }, [active, legStarter, matchConfig]);

  useEffect(() => () => {
    if (virtualTimeoutRef.current) clearTimeout(virtualTimeoutRef.current);
  }, []);

 const shouldDimBoardCircle = (n: number) => {
  const tail = boardTailMap[n];
  if (!tail) return false;

  const isFresh = tail.ts > 0 && Date.now() - tail.ts <= FRESH_LIMIT_MS;
  if (!isFresh) return false;

  // ha ugyanez az eszköz használta legutóbb, ne számítson foglaltnak
  if (tail.deviceInfo && tail.deviceInfo === deviceInfoRef.current) return false;

  return true;
};

  const openMenu = () => {
     ensureScoringFullscreen();
    const persisted = loadVirtualPrefs();
    setDraft({
      player1: matchConfig.vsVirtual ? (matchConfig.virtualSide === 0 ? players[1].name : players[0].name) : players[0].name,
      player2: matchConfig.vsVirtual ? players[matchConfig.virtualSide].name : players[1].name,
      vsVirtual: matchConfig.vsVirtual || persisted.enabled,
      virtualLevel: matchConfig.vsVirtual ? matchConfig.virtualLevel : persisted.level,
      virtualSide: matchConfig.vsVirtual ? matchConfig.virtualSide : persisted.side,
    });
    setName1Touched(false);
    setName2Touched(false);
    setShowOnlineInfo(false);
    setMenuBoardTmp(null);
    setWarnedBusyBoard(null);
    setShowMenuDialog1(true);
    setShowMenuName1Suggestions(false);
    setShowMenuName2Suggestions(false);
  };

  const openNames = () => {
    setTmpNamesFromCurrent();
    setShowNamesDialog(true);
  };
const setTmpNamesFromCurrent = () => {
  if (matchConfig.vsVirtual) {
    const humanIdx = matchConfig.virtualSide === 0 ? 1 : 0;
    setDraft((prev) => ({ ...prev, player1: players[humanIdx].name, virtualLevel: matchConfig.virtualLevel, virtualSide: matchConfig.virtualSide, vsVirtual: true }));
  } else {
    setDraft((prev) => ({ ...prev, player1: players[0].name, player2: players[1].name, vsVirtual: false }));
  }
  setName1Touched(false);
  setName2Touched(false);
};
  const confirmNamesOnly = () => {
    if (matchConfig.vsVirtual) {
      const humanIdx: 0 | 1 = matchConfig.virtualSide === 0 ? 1 : 0;
      const next: [PlayerStats, PlayerStats] = [{ ...playersRef.current[0] }, { ...playersRef.current[1] }];
      next[humanIdx] = { ...next[humanIdx], name: (draft.player1 || 'Player').trim() || 'Player' };
      playersRef.current = next;
      setPlayers(next);
    } else {
      const n1 = (draft.player1 || 'PL.1').trim() || 'PL.1';
      const n2 = (draft.player2 || 'PL.2').trim() || 'PL.2';
      const next: [PlayerStats, PlayerStats] = [{ ...playersRef.current[0], name: n1 }, { ...playersRef.current[1], name: n2 }];
      playersRef.current = next;
      setPlayers(next);
    }
    const namesToStore = matchConfig.vsVirtual
      ? [(draft.player1 || 'Player').trim()]
      : [
          (draft.player1 || 'PL.1').trim(),
          (draft.player2 || 'PL.2').trim(),
        ];

    const nextHistory = Array.from(
      new Set([
        ...namesToStore.filter(Boolean),
        ...playerNameHistory,
      ])
    ).slice(0, 20);

    setPlayerNameHistory(nextHistory);
    savePlayerNameHistory(nextHistory);
    setShowNamesDialog(false);
  };

  const applySetupStep1 = () => {
  setShowMenuDialog1(false);
  setWarnedBusyBoard(null);
  setMenuBoardTmp(null);

  if (!clubId?.trim()) {
    startGameFromSetup(false);
    return;
  }

  setShowMenuDialog2(true);
};
  const toggleDraftVirtualSwap = () => setDraft((prev) => ({ ...prev, virtualSide: prev.virtualSide === 0 ? 1 : 0 }));
  const swapHumanNames = () => setDraft((prev) => ({ ...prev, player1: prev.player2, player2: prev.player1 }));

  const setVsVirtualDraft = (value: boolean) => {
    setDraft((prev) => {
      if (value) {
        return { ...prev, vsVirtual: true, virtualLevel: prev.virtualLevel || initialVirtualPrefs.level || 5 };
      }

      const nextPlayer1 = (prev.player1 || '').trim() ? prev.player1 : 'PL.1';
      const nextPlayer2Raw = prev.player2 || '';
      const nextPlayer2 =
        nextPlayer2Raw.trim() && !/^Lv\./i.test(nextPlayer2Raw.trim()) ? nextPlayer2Raw : 'PL.2';

      return {
        ...prev,
        vsVirtual: false,
        player1: nextPlayer1,
        player2: nextPlayer2,
      };
    });
  };
const blurActiveElement = () => {
  if (typeof document === 'undefined') return;
  const el = document.activeElement as HTMLElement | null;
  el?.blur?.();
};
const startGameFromSetup = (withBoard: boolean, forcedBoard?: number | null) => {
  blurActiveElement();
  const selectedBoard = withBoard ? (forcedBoard ?? menuBoardTmp) : null;
    const nextMatchConfig: MatchConfig = {
      vsVirtual: draft.vsVirtual,
      virtualLevel: draft.virtualLevel,
      virtualSide: draft.virtualSide,
    };
    setMatchConfig(nextMatchConfig);
    saveVirtualPrefs({ enabled: draft.vsVirtual, level: draft.virtualLevel, side: draft.virtualSide });
    const namesToStore = draft.vsVirtual
          ? [(draft.player1 || 'Player').trim()]
          : [
              (draft.player1 || 'PL.1').trim(),
              (draft.player2 || 'PL.2').trim(),
            ];

        const nextHistory = Array.from(
          new Set([
            ...namesToStore.filter(Boolean),
            ...playerNameHistory,
          ])
        ).slice(0, 20);

        setPlayerNameHistory(nextHistory);
        savePlayerNameHistory(nextHistory);
    let p1: PlayerStats;
    let p2: PlayerStats;
    if (draft.vsVirtual) {
      const humanName = (draft.player1 || 'Player').trim() || 'Player';
      const virtualName = `Lv.${draft.virtualLevel}`;
      if (draft.virtualSide === 0) {
        p1 = freshPlayer(virtualName);
        p2 = freshPlayer(humanName);
      } else {
        p1 = freshPlayer(humanName);
        p2 = freshPlayer(virtualName);
      }
    } else {
      p1 = freshPlayer((draft.player1 || 'PL.1').trim() || 'PL.1');
      p2 = freshPlayer((draft.player2 || 'PL.2').trim() || 'PL.2');
    }

    const nextPlayers: [PlayerStats, PlayerStats] = [p1, p2];
    playersRef.current = nextPlayers;
    lastThrowRef.current = [0, 0];
    setPlayers(nextPlayers);
    setActive(0);
    setLegStarter(0);
    setInput('');
    setLastThrow([0, 0]);
    undoStack.current = [];
    setHasLegStarted(false);
    setBoardNr(selectedBoard);
    setMenuBoardTmp(selectedBoard);
    onlineDialogShownForBoardRef.current = null;
    prevOnlineRef.current = false;
    setShowOnlineDetectedDialog(false);
    setOnlineDisabled(false);
    resetOnlineState();
    setShowMenuDialog2(false);
    if (draft.vsVirtual) prepareVirtualPlan(draft.virtualLevel);
    else virtualPlanRef.current = null;
  };

  const handleBoardPickInSetup = (n: number) => {
  if (!clubId?.trim()) return;

  const busy = shouldDimBoardCircle(n);

  if (busy && warnedBusyBoard !== n) {
    setWarnedBusyBoard(n);
    return;
  }

  setWarnedBusyBoard(null);
  setMenuBoardTmp(n);
  startGameFromSetup(true, n);
};

  const renderBroadcastIcon = () => {
    const src = require('./broadcast.png');
    const isActive = boardNr != null;
    return (
      <View style={styles.broadcastOuter} pointerEvents="none">
        <View style={[styles.broadcastCircle, isActive ? styles.broadcastCircleOn : styles.broadcastCircleOff]}>
          <Image source={src} style={styles.broadcastIconInside} />
        </View>
        {isActive ? (
          <View style={styles.broadcastBadge}>
            <Text style={styles.broadcastBadgeText}>{boardNr}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  const statsChips = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.statsBarInner}>
      <View style={styles.statsEdgeSpacer} />
      <StatChip label="Throws" v1={players[0].legDartsThrown} v2={players[1].legDartsThrown} />
      <StatChip label="Avg." v1={format2AndroidLike(avg(players[0]))} v2={format2AndroidLike(avg(players[1]))} />
      <StatChip label="Avg.x3" v1={format2AndroidLike(avgX3(players[0]))} v2={format2AndroidLike(avgX3(players[1]))} />
      <StatChip label="Leg Avg." v1={format2AndroidLike(legAvg(players[0]))} v2={format2AndroidLike(legAvg(players[1]))} />
      <StatChip label="100+" v1={players[0].c100} v2={players[1].c100} />
      <StatChip label="140+" v1={players[0].c140} v2={players[1].c140} />
      <StatChip label="180+" v1={players[0].c180} v2={players[1].c180} />
      <StatChip label="Won Avg." v1={format2AndroidLike(wonAvg(players[0]))} v2={format2AndroidLike(wonAvg(players[1]))} />
      <StatChip label="Best" v1={players[0].bestLegDarts ?? 0} v2={players[1].bestLegDarts ?? 0} />
      <StatChip label="H.Out" v1={players[0].highOut} v2={players[1].highOut} />
      {canSaveStats ? <SaveStatChip label={saveInProgress ? 'saving...' : 'save stats'} onPress={() => void saveStatsToHistory()} /> : null}
      <View style={styles.statsEdgeSpacer} />
    </ScrollView>
  );

  const showOnlineBadgeLeft = isOnline && myPlayerIdx != null && myPlayerIdx !== 0;
  const showOnlineBadgeRight = isOnline && myPlayerIdx != null && myPlayerIdx !== 1;

  const topHeader = (
    <View style={styles.topHeader}>
      <View style={styles.topNamesRow}>
        <Pressable onPress={openNames} hitSlop={10}>
          <View style={styles.nameWithDotRight}>
            <Text style={styles.nameSmall} numberOfLines={1}>{players[0].name}</Text>
            {showOnlineBadgeLeft ? <View style={styles.onlineBadge}><Text style={styles.onlineBadgeText}>online</Text></View> : null}
            <View style={[styles.activeDot, active === 0 ? styles.activeDotOn : styles.activeDotOff]} />
          </View>
        </Pressable>
        <Text style={styles.legsMid} numberOfLines={1}>{players[0].legs} - {players[1].legs}</Text>
        <Pressable onPress={openNames} hitSlop={10}>
          <View style={styles.nameWithDotLeft}>
            <View style={[styles.activeDot, active === 1 ? styles.activeDotOn : styles.activeDotOff]} />
            {showOnlineBadgeRight ? <View style={styles.onlineBadge}><Text style={styles.onlineBadgeText}>online</Text></View> : null}
            <Text style={styles.nameSmall} numberOfLines={1}>{players[1].name}</Text>
          </View>
        </Pressable>
      </View>

      {!isPortrait ? (
        <View style={styles.scoreRowLandscape}>
          <View style={styles.scoreSideLandscape}>
            <Text style={styles.lastMiniLeft} numberOfLines={1}>{lastThrow[0] || 0}</Text>
            <Text style={styles.scoreBigLeft} numberOfLines={1}>{players[0].score}</Text>
            <DualInput side="left" visible={active === 0 && canInteract} value={active === 0 ? input : ''} onChangeText={safeSetInputWith180Limit} />
          </View>
          <Pressable onPress={() => setShowBoardDialog(true)} hitSlop={10} style={styles.broadcastMid}>{renderBroadcastIcon()}</Pressable>
          <View style={[styles.scoreSideLandscape, styles.scoreSideLandscapeRight]}>
            <DualInput side="right" visible={active === 1 && canInteract} value={active === 1 ? input : ''} onChangeText={safeSetInputWith180Limit} />
            <Text style={styles.scoreBigRight} numberOfLines={1}>{players[1].score}</Text>
            <Text style={styles.lastMiniRight} numberOfLines={1}>{lastThrow[1] || 0}</Text>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.scoreRowPortrait}>
            <Text style={styles.scoreBigLeft} numberOfLines={1}>{players[0].score}</Text>
            <Text style={styles.scoreBigRight} numberOfLines={1}>{players[1].score}</Text>
          </View>
          <View style={styles.lastRowPortrait}>
            <Text style={styles.lastMiniLeft} numberOfLines={1}>{lastThrow[0] || 0}</Text>
            <Text style={styles.lastMiniRight} numberOfLines={1}>{lastThrow[1] || 0}</Text>
          </View>
          <View style={styles.inputsRowPortrait}>
            <DualInput side="left" visible={active === 0 && canInteract} value={active === 0 ? input : ''} onChangeText={safeSetInputWith180Limit} />
            <Pressable onPress={() => setShowBoardDialog(true)} hitSlop={10} style={styles.broadcastMidPortrait}>{renderBroadcastIcon()}</Pressable>
            <DualInput side="right" visible={active === 1 && canInteract} value={active === 1 ? input : ''} onChangeText={safeSetInputWith180Limit} />
          </View>
        </>
      )}
    </View>
  );

  const keyboard = isPortrait ? (
    <View style={styles.keyboard}>
      {QUICK_PORTRAIT_ROWS.map((row, idx) => (
        <View key={idx} style={styles.kRowFlex}>
          {row.map((k) => {
            const kind = k.kind ?? 'num';
            const label = k.label;
            const onPress = () => {
              if (!canInteract) return;
              if (label === 'DEL') return onDel();
              if (label === 'UNDO') return onUndo();
              if (label === 'OK') return onOk();
              if (label === 'LEFT') return onLeft();
              if (kind === 'quick') return onQuick(k.value ?? toInt(label));
              return onDigit(toInt(label));
            };
            return <KeyFlex key={label + idx} label={label} kind={kind} onPress={onPress} />;
          })}
        </View>
      ))}
    </View>
  ) : (
    <View style={styles.keyboard}>
      <View style={styles.kRowFlex}>
        <KeyFlex label="1" onPress={() => onDigit(1)} />
        <KeyFlex label="2" onPress={() => onDigit(2)} />
        <KeyFlex label="3" onPress={() => onDigit(3)} />
        <KeyFlex label="DEL" kind="action" onPress={onDel} />
        <KeyFlex label="UNDO" kind="action" onPress={onUndo} />
        <KeyFlex label="121" kind="quick" onPress={() => onQuick(121)} />
        <KeyFlex label="125" kind="quick" onPress={() => onQuick(125)} />
        <KeyFlex label="140" kind="quick" onPress={() => onQuick(140)} />
      </View>
      <View style={styles.kRowFlex}>
        <KeyFlex label="4" onPress={() => onDigit(4)} />
        <KeyFlex label="5" onPress={() => onDigit(5)} />
        <KeyFlex label="6" onPress={() => onDigit(6)} />
        <KeyFlex label="0" onPress={() => onDigit(0)} />
        <KeyFlex label="60" kind="quick" onPress={() => onQuick(60)} />
        <KeyFlex label="81" kind="quick" onPress={() => onQuick(81)} />
        <KeyFlex label="85" kind="quick" onPress={() => onQuick(85)} />
        <KeyFlex label="100" kind="quick" onPress={() => onQuick(100)} />
      </View>
      <View style={styles.kRowFlex}>
        <KeyFlex label="7" onPress={() => onDigit(7)} />
        <KeyFlex label="8" onPress={() => onDigit(8)} />
        <KeyFlex label="9" onPress={() => onDigit(9)} />
        <KeyFlex label="OK" kind="action" onPress={onOk} />
        <KeyFlex label="LEFT" kind="action" onPress={onLeft} />
        <KeyFlex label="26" kind="quick" onPress={() => onQuick(26)} />
        <KeyFlex label="41" kind="quick" onPress={() => onQuick(41)} />
        <KeyFlex label="45" kind="quick" onPress={() => onQuick(45)} />
      </View>
    </View>
  );

  return (
    <View style={styles.safe}>
      <View style={styles.screen}>
        {topHeader}
        <View style={styles.keyboardArea}>{keyboard}</View>
        <View style={styles.statsBar}>{statsChips}</View>
        <Pressable
          style={styles.cornerCheck}
          onPress={() => {
            blurActiveElement();
            if (canInteract) applyScoring({ kind: 'check' });
          }}
        >
          <Text style={styles.cornerCheckText}>check</Text>
        </Pressable>
        <Pressable
            style={styles.cornerMenu}
            onPress={() => {
              blurActiveElement();
              openMenu();
            }}
          >
          <Text style={styles.cornerText}>☰</Text>
        </Pressable>
      </View>


      <Modal visible={showBoardDialog} transparent animationType="fade" onRequestClose={() => setShowBoardDialog(false)}>
        <View style={styles.modalOverlay}><View style={styles.modalCard}>
          <Text style={styles.modalLabel}>Board Nr</Text>
          {!!clubId?.trim() ? (
            <>
              <View style={styles.boardPickGrid}>
                {[1,2,3,4,5,6,7,8].map((n) => {
                  const selected = boardNr === n;
                  const dim = shouldDimBoardCircle(n) && !selected;
                  return (
                    <Pressable key={n} onPress={() => setBoardNr(selected ? null : n)} style={({ pressed }) => [styles.boardPickCircle, selected ? styles.boardPickCircleOn : styles.boardPickCircleOff, dim ? styles.boardPickCircleDim : null, pressed ? { opacity: 0.8 } : null]}>
                      <Text style={[styles.boardPickText, selected ? styles.boardPickTextOn : styles.boardPickTextOff, dim ? styles.boardPickTextDim : null]}>{n}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.modalHintSmall}>Club: {clubId} • Current: {boardNr ?? '-'}</Text>
            </>
          ) : (
            <Text style={styles.modalHintSmall}>No club selected.</Text>
          )}
          <View style={styles.modalBtns}>
            <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShowBoardDialog(false)}><Text style={styles.modalBtnTextGhost}>Cancel</Text></Pressable>
            <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={() => setShowBoardDialog(false)}><Text style={styles.modalBtnTextOk}>OK</Text></Pressable>
          </View>
        </View></View>
      </Modal>

      
      <Modal visible={showMenuDialog1} transparent animationType="fade" onRequestClose={() => setShowMenuDialog1(false)}>
        <Pressable
          style={styles.modalOverlay}
          onPress={() => {
            setShowMenuName1Suggestions(false);
            setShowMenuName2Suggestions(false);
            setShowMenuDialog1(false);
          }}
          
        >
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>New game</Text>

            <View style={styles.namesBlock}>
              {draft.vsVirtual ? (
                draft.virtualSide === 0 ? (
                  <>
                    <Pressable onPress={() => setShowLevelPicker(true)} style={styles.modalInputLike}>
                      <Text style={styles.modalInputLikeText}>{`Lv.${draft.virtualLevel}`}</Text>
                    </Pressable>

                    <View style={styles.namesGap} />

                    <View style={styles.menuFieldWrap}>
                      {showMenuName1Suggestions && playerNameHistory.length > 0 ? (
                        <View style={styles.menuSuggestionsAbove}>
                          <View style={styles.nameSuggestionsWrap}>
                            {playerNameHistory.slice(0, 6).map((name) => (
                              <Pressable
                                key={`menu-p1-${name}`}
                                onPress={() => {
                                  setDraft((prev) => ({ ...prev, player1: name }));
                                  setName1Touched(true);
                                  setShowMenuName1Suggestions(false);
                                }}
                                style={styles.nameSuggestionChip}
                              >
                                <Text style={styles.nameSuggestionText}>{name}</Text>
                              </Pressable>
                            ))}
                          </View>
                        </View>
                      ) : null}

                      <TextInput
                        value={draft.player1}
                        onChangeText={(v) => setDraft((prev) => ({ ...prev, player1: v }))}
                        style={styles.modalInput}
                        placeholder="PL.2"
                        placeholderTextColor="rgba(0,0,0,0.45)"
                        onFocus={() => {
                          setShowMenuName1Suggestions(true);
                          setShowMenuName2Suggestions(false);

                          if (!name1Touched) {
                            setDraft((prev) => ({ ...prev, player1: '' }));
                            setName1Touched(true);
                          }
                        }}
                      />
                    </View>
                  </>
                ) : (
                  <>
                    <View style={styles.menuFieldWrap}>
                      {showMenuName1Suggestions && playerNameHistory.length > 0 ? (
                        <View style={styles.menuSuggestionsAbove}>
                          <View style={styles.nameSuggestionsWrap}>
                            {playerNameHistory.slice(0, 6).map((name) => (
                              <Pressable
                                key={`menu-p1-${name}`}
                                onPress={() => {
                                  setDraft((prev) => ({ ...prev, player1: name }));
                                  setName1Touched(true);
                                  setShowMenuName1Suggestions(false);
                                }}
                                style={styles.nameSuggestionChip}
                              >
                                <Text style={styles.nameSuggestionText}>{name}</Text>
                              </Pressable>
                            ))}
                          </View>
                        </View>
                      ) : null}

                      <TextInput
                        value={draft.player1}
                        onChangeText={(v) => setDraft((prev) => ({ ...prev, player1: v }))}
                        style={styles.modalInput}
                        placeholder="PL.1"
                        placeholderTextColor="rgba(0,0,0,0.45)"
                        onFocus={() => {
                          setShowMenuName1Suggestions(true);
                          setShowMenuName2Suggestions(false);

                          if (!name1Touched) {
                            setDraft((prev) => ({ ...prev, player1: '' }));
                            setName1Touched(true);
                          }
                        }}
                      />
                    </View>

                    <View style={styles.namesGap} />

                    <Pressable onPress={() => setShowLevelPicker(true)} style={styles.modalInputLike}>
                      <Text style={styles.modalInputLikeText}>{`Lv.${draft.virtualLevel}`}</Text>
                    </Pressable>
                  </>
                )
              ) : (
                <>
                  <View style={styles.menuFieldWrap}>
                    {showMenuName1Suggestions && playerNameHistory.length > 0 ? (
                      <View style={styles.menuSuggestionsAbove}>
                        <View style={styles.nameSuggestionsWrap}>
                          {playerNameHistory.slice(0, 6).map((name) => (
                            <Pressable
                              key={`menu-p1-${name}`}
                              onPress={() => {
                                setDraft((prev) => ({ ...prev, player1: name }));
                                setName1Touched(true);
                                setShowMenuName1Suggestions(false);
                              }}
                              style={styles.nameSuggestionChip}
                            >
                              <Text style={styles.nameSuggestionText}>{name}</Text>
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    ) : null}

                    <TextInput
                      value={draft.player1}
                      onChangeText={(v) => setDraft((prev) => ({ ...prev, player1: v }))}
                      style={styles.modalInput}
                      placeholder="PL.1"
                      placeholderTextColor="rgba(0,0,0,0.45)"
                      onFocus={() => {
                        setShowMenuName1Suggestions(true);
                        setShowMenuName2Suggestions(false);

                        if (!name1Touched) {
                          setDraft((prev) => ({ ...prev, player1: '' }));
                          setName1Touched(true);
                        }
                      }}
                    />
                  </View>

                  <View style={styles.namesGap} />

                  <View style={styles.menuFieldWrap}>
                    {showMenuName2Suggestions && playerNameHistory.length > 0 ? (
                      <View style={styles.menuSuggestionsAbove}>
                        <View style={styles.nameSuggestionsWrap}>
                          {playerNameHistory
                            .filter((name) => name !== draft.player1)
                            .slice(0, 6)
                            .map((name) => (
                              <Pressable
                                key={`menu-p2-${name}`}
                                onPress={() => {
                                  setDraft((prev) => ({ ...prev, player2: name }));
                                  setName2Touched(true);
                                  setShowMenuName2Suggestions(false);
                                }}
                                style={styles.nameSuggestionChip}
                              >
                                <Text style={styles.nameSuggestionText}>{name}</Text>
                              </Pressable>
                            ))}
                        </View>
                      </View>
                    ) : null}

                    <TextInput
                      value={draft.player2}
                      onChangeText={(v) => setDraft((prev) => ({ ...prev, player2: v }))}
                      style={styles.modalInput}
                      placeholder="PL.2"
                      placeholderTextColor="rgba(0,0,0,0.45)"
                      onFocus={() => {
                        setShowMenuName2Suggestions(true);
                        setShowMenuName1Suggestions(false);

                        if (!name2Touched) {
                          setDraft((prev) => ({ ...prev, player2: '' }));
                          setName2Touched(true);
                        }
                      }}
                    />
                  </View>
                </>
              )}

              <Pressable onPress={draft.vsVirtual ? toggleDraftVirtualSwap : swapHumanNames} hitSlop={10} style={styles.swapBtnBetween}>
                <Text style={styles.swapBtnText}>⇄</Text>
              </Pressable>
            </View>

            <View style={styles.virtualToggleRow}>
              <Switch
                value={draft.vsVirtual}
                onValueChange={(value) => {
                  setShowMenuName1Suggestions(false);
                  setShowMenuName2Suggestions(false);
                  setVsVirtualDraft(value);
                }}
              />
              <Text style={styles.switchLabel}>vs Virtual Player</Text>
            </View>

            <View style={styles.modalBtnsSingle}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnOk, styles.modalBtnArrow]}
                onPress={() => {
                  setShowMenuName1Suggestions(false);
                  setShowMenuName2Suggestions(false);
                  applySetupStep1();
                }}
              >
                <Image source={require('./rightarrow.png')} style={styles.modalBtnArrowImage} />
              </Pressable>
            </View>

            <Pressable onPress={onExit} hitSlop={8} style={styles.exitInline}>
              <Text style={styles.exitInlineText}>Exit scoring mode</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showLevelPicker} transparent animationType="fade" onRequestClose={() => setShowLevelPicker(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowLevelPicker(false)}>
          <Pressable style={styles.levelPickerCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Virtual player level</Text>
            <ScrollView style={styles.levelPickerScroll} contentContainerStyle={styles.levelPickerScrollContent}>
              {Array.from({ length: 12 }).map((_, idx) => {
                const level = idx + 1;
                const selected = draft.virtualLevel === level;
                return (
                  <Pressable
                    key={level}
                    onPress={() => {
                      setDraft((prev) => ({ ...prev, virtualLevel: level }));
                      setShowLevelPicker(false);
                    }}
                    style={[styles.levelPickerRow, selected ? styles.levelPickerRowOn : null]}
                  >
                    <Text style={[styles.levelPickerRowText, selected ? styles.levelPickerRowTextOn : null]}>{`Lv.${level}`}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showMenuDialog2} transparent animationType="fade" onRequestClose={() => setShowMenuDialog2(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowMenuDialog2(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            {!!clubId?.trim() ? (
              <>
                <Text style={styles.modalLabel}>Board Nr:</Text>
                <View style={styles.boardPickGrid}>
                  {[1,2,3,4,5,6,7,8].map((n) => {
                    const selected = menuBoardTmp === n;
                    const dim = shouldDimBoardCircle(n) && !selected;
                    return (
                      <Pressable key={n} onPress={() => handleBoardPickInSetup(n)} style={({ pressed }) => [styles.boardPickCircle, selected ? styles.boardPickCircleOn : styles.boardPickCircleOff, dim ? styles.boardPickCircleDim : null, pressed ? { opacity: 0.8 } : null]}>
                        <Text style={[styles.boardPickText, selected ? styles.boardPickTextOn : styles.boardPickTextOff, dim ? styles.boardPickTextDim : null]}>{n}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {warnedBusyBoard != null ? <Text style={styles.busyWarningText}>This board looks busy. Tap it again to continue anyway.</Text> : null}
              </>
            ) : null}

            {/* {!draft.vsVirtual ? (
              <View style={styles.onlineInlineWrap}>
                <Pressable onPress={() => setShowOnlineInfo((v) => !v)}><Text style={styles.onlineInlineText}>ONLINE</Text></Pressable>
                <Pressable onPress={() => setShowOnlineInfo((v) => !v)} style={styles.questionCircle}><Text style={styles.questionCircleText}>?</Text></Pressable>
              </View>
            ) : null}

            {showOnlineInfo && !draft.vsVirtual ? <Text style={styles.onlineInfoText}>Az ONLINE meccshez nem kell mást tennetek, csak ugyanazt a pályát kiválasztanotok mindketten és Start Game.</Text> : null} */}

            <View style={styles.modalBtns}>
              <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => startGameFromSetup(false)}>
                <Text style={styles.modalBtnTextGhost}>Start without board</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showNamesDialog} transparent animationType="fade" onRequestClose={() => setShowNamesDialog(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Players</Text>

            <View style={styles.namesBlock}>
              <Pressable
                onPress={() => {
                  if (!name1Touched) {
                    setDraft((prev) => ({ ...prev, player1: '' }));
                    setName1Touched(true);
                  }
                }}
              >
                <TextInput
                  value={draft.player1}
                  autoFocus={false}
                  onChangeText={(v) => {
                    if (!name1Touched) setName1Touched(true);
                    setDraft((prev) => ({ ...prev, player1: v }));
                  }}
                  style={styles.modalInput}
                  placeholder="Player 1"
                  placeholderTextColor="rgba(0,0,0,0.45)"
                />
              </Pressable>
              {playerNameHistory.length > 0 ? (
                <View style={styles.nameSuggestionsWrap}>
                  {playerNameHistory.slice(0, 6).map((name) => (
                    <Pressable
                      key={`p1-${name}`}
                      onPress={() => {
                        setDraft((prev) => ({ ...prev, player1: name }));
                        setName1Touched(true);
                      }}
                      style={styles.nameSuggestionChip}
                    >
                      <Text style={styles.nameSuggestionText}>{name}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <View style={styles.namesGap} />

              {matchConfig.vsVirtual ? (
                <View style={styles.modalInputDisabled}>
                  <Text style={styles.modalInputDisabledText}>{`Lv.${matchConfig.virtualLevel}`}</Text>
                </View>
              ) : (
                <Pressable
                  onPress={() => {
                    if (!name2Touched) {
                      setDraft((prev) => ({ ...prev, player2: '' }));
                      setName2Touched(true);
                    }
                  }}
                >
                  <TextInput
                    value={draft.player2}
                    autoFocus={false}
                    onChangeText={(v) => {
                      if (!name2Touched) setName2Touched(true);
                      setDraft((prev) => ({ ...prev, player2: v }));
                    }}
                    style={styles.modalInput}
                    placeholder="Player 2"
                    placeholderTextColor="rgba(0,0,0,0.45)"
                  />
                </Pressable>
                
              )}
                {!matchConfig.vsVirtual && playerNameHistory.length > 0 ? (
                  <View style={styles.nameSuggestionsWrap}>
                    {playerNameHistory
                      .filter((name) => name !== draft.player1)
                      .slice(0, 6)
                      .map((name) => (
                        <Pressable
                          key={`p2-${name}`}
                          onPress={() => {
                            setDraft((prev) => ({ ...prev, player2: name }));
                            setName2Touched(true);
                          }}
                          style={styles.nameSuggestionChip}
                        >
                          <Text style={styles.nameSuggestionText}>{name}</Text>
                        </Pressable>
                      ))}
                  </View>
                ) : null}
              {!matchConfig.vsVirtual ? (
                <Pressable onPress={swapHumanNames} hitSlop={10} style={styles.swapBtnBetween}>
                  <Text style={styles.swapBtnText}>⇄</Text>
                </Pressable>
              ) : null}
            </View>

            <View style={styles.modalBtns}>
              <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShowNamesDialog(false)}>
                <Text style={styles.modalBtnTextGhost}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={confirmNamesOnly}>
                <Text style={styles.modalBtnTextOk}>OK</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showCheckout} transparent animationType="fade" onRequestClose={() => setShowCheckout(false)}>
        <View style={styles.modalOverlay}><View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Checkout</Text>
          <Text style={styles.modalLabel}>Which dart did you finish on?</Text>
          <View style={styles.checkoutRow}>
            {getCheckoutDartOptions(pendingCheckout?.checkoutValue ?? 0).map((n) => (
              <Pressable key={n} style={[styles.checkoutBtn, styles.modalBtnOk]} onPress={() => confirmCheckout(n)}><Text style={styles.checkoutText}>{n}</Text></Pressable>
            ))}
          </View>
          <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShowCheckout(false)}><Text style={styles.modalBtnTextGhost}>Cancel</Text></Pressable>
        </View></View>
      </Modal>

      <Modal visible={showOnlineDetectedDialog} transparent animationType="fade" onRequestClose={() => setShowOnlineDetectedDialog(false)}>
        <View style={styles.modalOverlay}><View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Online mode</Text>
<Text style={styles.modalLabel}>It looks like another club member is playing on this board. You are in online mode. If this is not intentional, choose another board.</Text>
          <View style={[styles.modalBtns, { marginTop: 12 }]}>
            <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => {
              setOnlineDisabled(true);
              setShowOnlineDetectedDialog(false);
              setMyRole(null);
              prevOnlineRef.current = false;
              resetOnlineState();
              onlineDialogShownForBoardRef.current = boardNr != null ? `disabled:${clubId}:${boardNr}` : `disabled:${clubId}:-`;
            }}><Text style={styles.modalBtnTextGhost}>NO ONLINE</Text></Pressable>
            <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={() => setShowOnlineDetectedDialog(false)}><Text style={styles.modalBtnTextOk}>OK</Text></Pressable>
          </View>
        </View></View>
      </Modal>

      <Modal visible={showInactiveDialog} transparent animationType="fade" onRequestClose={() => setShowInactiveDialog(false)}>
        <View style={styles.modalOverlay}><View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Disconnected</Text>
<Text style={styles.modalLabel}>You were disconnected from the board due to inactivity. If you still want to use it, please connect again.</Text>
          <Pressable style={[styles.modalBtn, styles.modalBtnOk, { marginTop: 12 }]} onPress={() => setShowInactiveDialog(false)}><Text style={styles.modalBtnTextOk}>OK</Text></Pressable>
        </View></View>
      </Modal>
      <Modal
        visible={pendingVirtualCheckout != null}
        transparent
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Checkout</Text>
            <Text style={styles.modalLabel}>
              The virtual player checked out.
            </Text>

            <View style={styles.modalBtns}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={onUndo}
              >
                <Text style={styles.modalBtnTextGhost}>UNDO</Text>
              </Pressable>

              <Pressable
                style={[styles.modalBtn, styles.modalBtnOk]}
                onPress={confirmVirtualCheckoutOk}
              >
                <Text style={styles.modalBtnTextOk}>OK</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function DualInput(props: { side: 'left' | 'right'; visible: boolean; value: string; onChangeText: (t: string) => void }) {
  return (
    <View style={[styles.inputBoxWrap, props.side === 'left' ? styles.inputLeft : styles.inputRight]}>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        keyboardType="numeric"
        placeholder="0"
        placeholderTextColor="rgba(0,0,0,0.35)"
        style={[styles.input, props.visible ? styles.inputVisible : styles.inputHidden]}
        editable={props.visible}
      />
    </View>
  );
}

function StatChip(props: { label: string; v1: any; v2: any }) {
  return <View style={styles.statChip}><Text style={styles.statChipText}>{String(props.v1)} <Text style={styles.statChipLabel}>{props.label}</Text> {String(props.v2)}</Text></View>;
}
function SaveStatChip(props: { label: string; onPress: () => void }) {
  return <Pressable onPress={props.onPress} style={({ pressed }) => [styles.statChip, styles.saveStatChip, pressed ? styles.saveStatChipPressed : null]}><Text style={[styles.statChipText, styles.saveStatChipText]}>{props.label}</Text></Pressable>;
}
function ensureDocFullscreen() {
  if (typeof document === 'undefined') return Promise.resolve();
  if (document.fullscreenElement) return Promise.resolve();
  return document.documentElement.requestFullscreen?.() ?? Promise.resolve();
}
function KeyFlex(props: { label: string; onPress: () => void; kind?: 'num' | 'action' | 'quick' }) {
  const kind = props.kind ?? 'num';

  return (
    <Pressable
      onTouchStart={(e) => {
        e.preventDefault(); // fontos!
        props.onPress();
      }}
      style={({ pressed }) => [
        styles.keyFlex,
        kind === 'action' ? styles.keyAction : null,
        kind === 'quick' ? styles.keyQuick : null,
        pressed ? { opacity: 0.78 } : null,
      ]}
    >
      <Text style={[styles.keyText, kind !== 'num' ? styles.keyTextAction : null]}>
        {props.label}
      </Text>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#ffffff' },
  screen: { flex: 1, backgroundColor: '#ffffff' },
  topHeader: { paddingTop: 4, paddingHorizontal: 8, paddingBottom: 4 },
  topNamesRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  nameSmall: { color: 'rgba(0,0,0,0.65)', fontWeight: '900', fontSize: 16, maxWidth: 140 },
  legsMid: { color: 'rgba(0,0,0,0.55)', fontWeight: '900', fontSize: 22 },
  nameWithDotRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nameWithDotLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  activeDot: { width: 10, height: 10, borderRadius: 999 },
  activeDotOn: { backgroundColor: '#2f6f18' },
  activeDotOff: { backgroundColor: 'transparent' },
  onlineBadge: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.20)', borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: 'rgba(0,0,0,0.04)' },
  onlineBadgeText: { fontSize: 10, fontWeight: '900', color: 'rgba(0,0,0,0.55)', textTransform: 'uppercase' },
  scoreRowLandscape: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  scoreSideLandscape: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  scoreSideLandscapeRight: { justifyContent: 'flex-end' },
  scoreRowPortrait: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  inputsRowPortrait: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, marginTop: 4, marginBottom: 2, justifyContent: 'space-between' },
  lastRowPortrait: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  scoreBigLeft: { color: '#2f6f18', fontWeight: '900', fontSize: 54, letterSpacing: 1 },
  scoreBigRight: { color: '#2f6f18', fontWeight: '900', fontSize: 54, letterSpacing: 1 },
  lastMiniLeft: { color: 'rgba(0,0,0,0.45)', fontWeight: '900', fontSize: 28, width: 60, textAlign: 'left' },
  lastMiniRight: { color: 'rgba(0,0,0,0.45)', fontWeight: '900', fontSize: 28, width: 60, textAlign: 'right' },
  broadcastMid: { paddingHorizontal: 8 },
  broadcastMidPortrait: { width: 60, alignItems: 'center', justifyContent: 'center' },
  inputBoxWrap: { width: 92 },
  inputLeft: { alignItems: 'flex-start' },
  inputRight: { alignItems: 'flex-end' },
  input: { width: 92, backgroundColor: '#ffffff', borderWidth: 2, borderColor: 'rgba(0,0,0,0.18)', borderRadius: 10, paddingVertical: 6, textAlign: 'center', fontSize: 22, fontWeight: '900', color: 'rgba(0,0,0,0.85)' },
  inputVisible: { opacity: 1 },
  inputHidden: { opacity: 0 },
  keyboardArea: { flex: 1, paddingHorizontal: 6, paddingTop: 4, paddingBottom: 2 },
  keyboard: { flex: 1 },
  kRowFlex: { flex: 1, flexDirection: 'row', gap: 6, marginBottom: 6 },
  keyFlex: { flex: 1, borderRadius: 8, backgroundColor: '#f3d49b', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)' },
  keyAction: { backgroundColor: '#7a5b22' },
  keyQuick: { backgroundColor: '#c9b07a' },
  keyText: { color: '#b3422a', fontWeight: '900', fontSize: 26 },
  keyTextAction: { color: 'rgba(255,255,255,0.92)', fontSize: 18 },
  broadcastOuter: { width: 56, height: 56, position: 'relative', alignItems: 'center', justifyContent: 'center' },
  broadcastCircle: { width: 56, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'rgba(0,0,0,0.10)' },
  broadcastCircleOff: { backgroundColor: 'rgba(0,0,0,0.12)' },
  broadcastCircleOn: { backgroundColor: 'rgba(47,111,24,0.18)' },
  broadcastIconInside: { width: 26, height: 26, resizeMode: 'contain', tintColor: 'rgba(0,0,0,0.70)' },
  broadcastBadge: { position: 'absolute', right: -6, bottom: -6, width: 24, height: 24, borderRadius: 999, backgroundColor: '#2f6f18', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#ffffff', zIndex: 20, elevation: 20 },
  broadcastBadgeText: { color: '#ffffff', fontWeight: '900', fontSize: 12 },
  statsBar: { paddingHorizontal: 6, paddingBottom: 6, paddingTop: 4, backgroundColor: '#ffffff' },
  statsBarInner: { alignItems: 'center', gap: 8 },
  statsEdgeSpacer: { width: 66 },
  statChip: { height: 34, borderRadius: 10, backgroundColor: 'rgba(74,13,13,0.10)', paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  statChipText: { color: 'rgba(74,13,13,0.85)', fontWeight: '900' },
  statChipLabel: { color: 'rgba(74,13,13,0.45)' },
  saveStatChip: { borderWidth: 1, borderColor: 'rgba(74,13,13,0.12)' },
  saveStatChipPressed: { opacity: 0.78 },
  saveStatChipText: { textTransform: 'lowercase' },
  cornerCheck: { position: 'absolute', left: 6, bottom: 6, width: 64, height: 64, borderRadius: 999, backgroundColor: '#2f6f18', alignItems: 'center', justifyContent: 'center', zIndex: 999, elevation: 5 },
  cornerMenu: { position: 'absolute', right: 6, bottom: 6, width: 64, height: 64, borderRadius: 999, backgroundColor: '#2f6f18', alignItems: 'center', justifyContent: 'center', zIndex: 999, elevation: 5 },
  cornerText: { color: '#ffffff', fontWeight: '900', fontSize: 22 },
  cornerCheckText: { color: '#ffffff', fontWeight: '900', fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  modalCard: { width: '92%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 14, padding: 14 },
  modalTitle: { fontWeight: '900', fontSize: 18, marginBottom: 10, color: 'rgba(0,0,0,0.85)' },
  modalLabel: { fontWeight: '800', color: 'rgba(0,0,0,0.6)', marginTop: 6, marginBottom: 4 },
  modalInput: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontWeight: '800', color: 'rgba(0,0,0,0.85)' },
  modalInputDisabled: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.16)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 11, backgroundColor: 'rgba(0,0,0,0.04)' },
  modalInputDisabledText: { fontWeight: '900', color: 'rgba(0,0,0,0.72)' },
  boardPickGrid: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 2, justifyContent: 'space-between' },
  boardPickCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  boardPickCircleOff: { borderColor: 'rgba(0,0,0,0.18)', backgroundColor: 'rgba(0,0,0,0.04)' },
  boardPickCircleOn: { borderColor: '#2f6f18', backgroundColor: 'rgba(47,111,24,0.12)' },
  boardPickCircleDim: { opacity: 0.35 },
  boardPickText: { fontWeight: '900', fontSize: 13 },
  boardPickTextOff: { color: 'rgba(0,0,0,0.6)' },
  boardPickTextOn: { color: '#2f6f18' },
  boardPickTextDim: { color: 'rgba(0,0,0,0.45)' },
  modalHintSmall: { marginTop: 10, color: 'rgba(63,63,63,0.45)', fontWeight: '800', fontSize: 12 },
  namesGap: { height: 10 },
  swapBtnText: { fontSize: 20, fontWeight: '900', color: 'rgba(0,0,0,0.6)', transform: [{ rotate: '90deg' }, { translateY: -3 }] },
  swapBtnBetween: { position: 'absolute', right: 8, top: '50%', marginTop: -20, width: 40, height: 40, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.08)', alignItems: 'center', justifyContent: 'center' },
    nameSuggestionsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  menuFieldWrap: {
    position: 'relative',
  },

  menuSuggestionsAbove: {
    marginBottom: 8,
  },
  nameSuggestionChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.10)',
  },
  nameSuggestionText: {
    color: 'rgba(0,0,0,0.72)',
    fontWeight: '900',
    fontSize: 12,
  },
  namesBlock: { position: 'relative', paddingRight: 52 },
  virtualToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, marginBottom: 18 },
  switchLabel: { fontWeight: '900', color: 'rgba(0,0,0,0.72)' },
  modalInputLike: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 11, justifyContent: 'center', backgroundColor: '#fff' },
  modalInputLikeText: { fontWeight: '900', color: 'rgba(0,0,0,0.82)' },
  levelPickerCard: { width: '84%', maxWidth: 280, maxHeight: '70%', backgroundColor: '#fff', borderRadius: 14, padding: 14 },
  levelPickerScroll: { maxHeight: 320 },
  levelPickerScrollContent: { gap: 8 },
  levelPickerRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.06)' },
  levelPickerRowOn: { backgroundColor: 'rgba(47,111,24,0.16)', borderWidth: 1, borderColor: '#2f6f18' },
  levelPickerRowText: { color: 'rgba(0,0,0,0.78)', fontWeight: '900' },
  levelPickerRowTextOn: { color: '#2f6f18' },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 12 },
  modalBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  modalBtnGhost: { backgroundColor: 'rgba(0,0,0,0.08)' },
  modalBtnOk: { backgroundColor: '#2f6f18' },
  modalBtnTextGhost: { fontWeight: '900', color: 'rgba(0,0,0,0.75)' },
  modalBtnTextOk: { fontWeight: '900', color: '#ffffff' },
  modalBtnsSingle: { marginTop: 0, alignItems: 'flex-end' },
  modalBtnArrow: { minWidth: 72, minHeight: 44, alignSelf: 'flex-end', flexGrow: 0, justifyContent: 'center' },
  modalBtnArrowImage: { width: 24, height: 24, resizeMode: 'contain', tintColor: '#ffffff' },
  onlineInlineWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  onlineInlineText: { fontWeight: '900', color: 'rgba(0,0,0,0.55)', textDecorationLine: 'underline' },
  questionCircle: { width: 22, height: 22, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center' },
  questionCircleText: { color: 'rgba(0,0,0,0.65)', fontWeight: '900', fontSize: 12 },
  onlineInfoText: { marginTop: 10, marginBottom: 2, fontWeight: '900', color: '#b3422a' },
  busyWarningText: { marginTop: 10, fontWeight: '900', color: '#b3422a' },
  exitInline: { marginTop: 14, alignItems: 'center' },
  exitInlineText: { color: 'rgba(0,0,0,0.55)', fontWeight: '900', textDecorationLine: 'underline' },
  checkoutRow: { flexDirection: 'row', gap: 10, marginTop: 10, marginBottom: 12 },
  checkoutBtn: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  checkoutText: { color: 'white', fontWeight: '900', fontSize: 22 },
});
