import { onValue, ref } from 'firebase/database';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
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
import { addWatchedId, buildBoardShareUrl, buildQrImageUrl, getOrCreateDeviceId, parseBoardIdFromText, publishBoardRecord } from './broadcastShared';

type Props = {
  onExit: () => void;
  clubId: string;
  initialBoardNr?: number | null;
  onOpenScoring?: () => void;
  onOpenDisplay?: () => void;
  onOpenDisplayById?: (id: string) => void;
  openNewGameRequestKey?: number;
};

type CricketVariant = 'own' | 'penalty';
type CricketSector = 20 | 19 | 18 | 17 | 16 | 15 | 'B';

type PlayerState = {
  id: string;
  name: string;
  points: number;
  marks: Record<CricketSector, number>;
  isVirtual?: boolean;
  wins: number;
};

type SetupDraft = {
  humanNames: string[];
  vsVirtual: boolean;
  virtualLevel: number;
};

type GameSnapshot = {
  players: PlayerState[];
  active: number;
  boardNr: number | null;
  variant: CricketVariant;
  round: number;
  gameStarter: number;
};

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

const PLAYER_NAME_HISTORY_KEY = 'scoring2.playerNameHistory';
const VIRTUAL_PREF_KEY = 'cricket.virtualPrefs';
const BOARD_NRS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const SECTORS: CricketSector[] = [20, 19, 18, 17, 16, 15, 'B'];
const SECTOR_BUTTONS: CricketSector[] = [20, 19, 18, 17, 16, 15, 'B'];
const QUICK_BUTTONS: Array<'T 20' | 'T 19' | 'T 18' | 'T 17' | 'T 16' | 'T 15' | 'DBull'> = ['T 20', 'T 19', 'T 18', 'T 17', 'T 16', 'T 15', 'DBull'];
const FRESH_LIMIT_MS = 2 * 60 * 1000;
const INACTIVITY_MS = 2 * 60 * 1000;
const INACTIVITY_CHECK_MS = 2 * 60 * 1000;

function ensureDocFullscreen() {
  if (typeof document === 'undefined') return Promise.resolve();
  if (document.fullscreenElement) return Promise.resolve();
  return document.documentElement.requestFullscreen?.() ?? Promise.resolve();
}

function ensureKrikettFullscreen() {
  if (typeof document === 'undefined') return;
  if (document.fullscreenElement) return;
  void ensureDocFullscreen().catch(() => {});
}

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
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }
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

function makeClientId() {
  return Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36).slice(-4);
}

function parseScoreTail(raw: string | null): { deviceInfo: string | null; ts: number } {
  if (!raw) return { deviceInfo: null, ts: 0 };
  const parts = raw.trim().split('_');
  if (parts.length < 2) return { deviceInfo: null, ts: 0 };
  const tsMaybe = Number(parts[parts.length - 1]);
  const ts = Number.isFinite(tsMaybe) ? Math.trunc(tsMaybe) : 0;
  const deviceInfo = parts.length >= 3 ? parts[parts.length - 2] || null : null;
  return { deviceInfo, ts };
}

function loadPlayerNameHistory(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(PLAYER_NAME_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 20);
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
          .filter((v) => !/^PL\./i.test(v))
      )
    ).slice(0, 20);
    window.localStorage.setItem(PLAYER_NAME_HISTORY_KEY, JSON.stringify(cleaned));
  } catch {}
}

function loadVirtualPrefs(): { enabled: boolean; level: number } {
  try {
    if (typeof window === 'undefined') return { enabled: false, level: 5 };
    const raw = window.localStorage.getItem(VIRTUAL_PREF_KEY);
    if (!raw) return { enabled: false, level: 5 };
    const parsed = JSON.parse(raw);
    const level = Math.max(1, Math.min(12, Number(parsed?.level) || 5));
    return { enabled: !!parsed?.enabled, level };
  } catch {
    return { enabled: false, level: 5 };
  }
}

function saveVirtualPrefs(v: { enabled: boolean; level: number }) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(VIRTUAL_PREF_KEY, JSON.stringify(v));
  } catch {}
}

function createEmptyMarks(): Record<CricketSector, number> {
  return { 20: 0, 19: 0, 18: 0, 17: 0, 16: 0, 15: 0, B: 0 };
}

function freshPlayer(name: string, isVirtual = false, wins = 0): PlayerState {
  return {
    id: `${name}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    points: 0,
    marks: createEmptyMarks(),
    isVirtual,
    wins,
  };
}

function sectorValue(sector: CricketSector): number {
  return sector === 'B' ? 25 : sector;
}

function marksToSlashes(v: number) {
  if (v <= 0) return '';
  return '/'.repeat(Math.min(3, v));
}
function CricketMarkBox(props: {
  label: string;
  marks: number;
  compact?: boolean;
  hideLabel?: boolean;
  short?: boolean;
}) {
  const marks = Math.max(0, Math.min(3, Number(props.marks) || 0));

  return (
    <View
      style={[
        styles.cricketMarkChip,
        props.compact ? styles.cricketMarkChipCompact : null,
        props.short ? styles.cricketMarkChipShort : null,
      ]}
    >
      <View style={styles.cricketMarkChipBg}>
        <View style={[styles.cricketMarkThirdBase, styles.cricketMarkThird1, styles.cricketMarkThirdBaseLight]} />
        <View style={[styles.cricketMarkThirdBase, styles.cricketMarkThird2, styles.cricketMarkThirdBaseMid]} />
        <View style={[styles.cricketMarkThirdBase, styles.cricketMarkThird3, styles.cricketMarkThirdBaseDark]} />

        {marks >= 1 ? <View style={[styles.cricketMarkThirdFill, styles.cricketMarkThird1]} /> : null}
        {marks >= 2 ? <View style={[styles.cricketMarkThirdFillMid, styles.cricketMarkThird2]} /> : null}
        {marks >= 3 ? <View style={[styles.cricketMarkThirdFill, styles.cricketMarkThird3]} /> : null}
      </View>

      {!props.hideLabel ? (
        <Text style={styles.cricketMarkChipLabel} numberOfLines={1}>
          {props.label}
        </Text>
      ) : null}
    </View>
  );
}
function tokenCapacity(sector: CricketSector) {
  return sector === 'B' ? 2 : 3;
}

function tokenLabel(sector: CricketSector, marks: number) {
  if (sector === 'B') {
    if (marks <= 1) return 'Bull';
    return 'DBull';
  }
  if (marks <= 1) return String(sector);
  if (marks === 2) return `D${sector}`;
  return `T${sector}`;
}

function sumTurnCounts(turnCounts: Record<string, number>) {
  return Object.values(turnCounts).reduce((sum, v) => sum + v, 0);
}

function buildDartTokens(turnCounts: Record<string, number>): Array<{ sector: CricketSector; marks: number }> {
  const tokens: Array<{ sector: CricketSector; marks: number }> = [];

  for (const sector of SECTORS) {
    let remaining = turnCounts[String(sector)] || 0;
    const cap = tokenCapacity(sector);
    while (remaining > 0) {
      const marks = Math.min(cap, remaining);
      tokens.push({ sector, marks });
      remaining -= marks;
    }
  }

  return tokens;
}

function buildTurnLabel(turnCounts: Record<string, number>) {
  return buildDartTokens(turnCounts)
    .map((token) => tokenLabel(token.sector, token.marks))
    .join('-');
}

function clonePlayers(players: PlayerState[]) {
  return players.map((p) => ({ ...p, marks: { ...p.marks } }));
}

function allClosed(p: PlayerState) {
  return SECTORS.every((s) => p.marks[s] >= 3);
}

function canWin(players: PlayerState[], idx: number, variant: CricketVariant) {
  const p = players[idx];
  if (!allClosed(p)) return false;
  if (variant === 'own') return players.every((other, i) => i === idx || p.points >= other.points);
  return players.every((other, i) => i === idx || p.points <= other.points);
}

function normalizePlayerNames(names: string[]) {
  return names
    .map((name, idx) => (name || `PL.${idx + 1}`).trim() || `PL.${idx + 1}`)
    .slice(0, 4);
}

function applyCricketTurn(players: PlayerState[], playerIdx: number, turnCounts: Record<string, number>, variant: CricketVariant) {
  const next = clonePlayers(players);
  const player = next[playerIdx];

  for (const sector of SECTORS) {
    const key = String(sector);
    const hits = turnCounts[key] || 0;
    if (!hits) continue;

    const currentMarks = player.marks[sector];
    const toClose = Math.max(0, Math.min(3 - currentMarks, hits));
    const extras = Math.max(0, hits - toClose);
    player.marks[sector] = Math.min(3, currentMarks + hits);

    if (!extras) continue;

    const value = sectorValue(sector);
    const openOpponents = next.filter((opp, idx) => idx !== playerIdx && opp.marks[sector] < 3);
    if (openOpponents.length === 0) continue;

    if (variant === 'own') {
      player.points += extras * value;
    } else {
      openOpponents.forEach((opp) => {
        opp.points += extras * value;
      });
    }
  }

  return next;
}

function chooseVirtualTarget(players: PlayerState[], idx: number, variant: CricketVariant): CricketSector | null {
  const self = players[idx];

  const trailing =
    variant === 'own'
      ? players.some((p, i) => i !== idx && self.points < p.points)
      : players.some((p, i) => i !== idx && self.points > p.points);

  // Ha rosszabbul Ã¡ll pontban, elÅ‘szÃ¶r keressen olyan szektort,
  // amibÅ‘l AZONNAL pontot tud szerezni:
  // neki mÃ¡r ki van zÃ¡rva, az ellenfÃ©l(ek) kÃ¶zÃ¼l pedig valakinek mÃ©g nincs.
  if (trailing) {
    for (const sector of SECTORS) {
      const selfClosed = self.marks[sector] >= 3;
      const someoneOpen = players.some((p, i) => i !== idx && p.marks[sector] < 3);

      if (selfClosed && someoneOpen) {
        return sector;
      }
    }

    // Ha nincs azonnal pontszerzÅ‘ szektor, akkor 20 -> Bull sorrendben
    // keresse az elsÅ‘ olyan szektort, ami mÃ©g nincs neki lezÃ¡rva,
    // Ã©s az ellenfÃ©l(ek) kÃ¶zÃ¼l valakinek sincs lezÃ¡rva.
    // Ezt kezdi el gyÅ±jteni, hogy kÃ©sÅ‘bb pontot szerezhessen rajta.
    for (const sector of SECTORS) {
      const selfClosed = self.marks[sector] >= 3;
      const someoneOpen = players.some((p, i) => i !== idx && p.marks[sector] < 3);

      if (!selfClosed && someoneOpen) {
        return sector;
      }
    }
  }

  // Ha nem Ã¡ll rosszabbul pontban, akkor a normÃ¡l zÃ¡rÃ¡si sorrend:
  // 20 -> 19 -> ... -> 15 -> Bull
  for (const sector of SECTORS) {
    if (self.marks[sector] < 3) {
      return sector;
    }
  }

  // Ha mÃ¡r mindent lezÃ¡rt, Ã©s mÃ©g mindig rosszabbul Ã¡ll,
  // akkor prÃ³bÃ¡ljon pontot szerezni a mÃ©g nyitott ellenfÃ©l-szektorokon.
  if (trailing) {
    for (const sector of SECTORS) {
      const selfClosed = self.marks[sector] >= 3;
      const someoneOpen = players.some((p, i) => i !== idx && p.marks[sector] < 3);

      if (selfClosed && someoneOpen) {
        return sector;
      }
    }
  }

  return null;
}

function virtualHitMarks(level: number, sector: CricketSector): number {
  // GyengÃƒÂ©bb szintek: a rÃƒÂ©gi 6 kÃƒÂ¶rÃƒÂ¼lbelÃƒÂ¼l az ÃƒÂºj 12 legyen
  const t = Math.max(0.5, Math.min(6, level / 2));
  const r = Math.random();

  if (sector === 'B') {
    const p2 = 0.02 + t * 0.025;
    const p1 = 0.12 + t * 0.022;
    if (r < p2) return 2;
    if (r < p2 + p1) return 1;
    return 0;
  }

  const p3 = 0.02 + t * 0.025;
  const p2 = 0.08 + t * 0.022;
  const p1 = 0.14 + t * 0.02;
  if (r < p3) return 3;
  if (r < p3 + p2) return 2;
  if (r < p3 + p2 + p1) return 1;
  return 0;
}

function generateVirtualTurn(players: PlayerState[], idx: number, level: number, variant: CricketVariant) {
  let working = clonePlayers(players);
  const turnCounts: Record<string, number> = {};

  for (let dart = 0; dart < 3; dart += 1) {
    const target = chooseVirtualTarget(working, idx, variant);
    if (!target) break;
    const marks = virtualHitMarks(level, target);
    if (marks <= 0) continue;
    turnCounts[String(target)] = (turnCounts[String(target)] || 0) + marks;
    working = applyCricketTurn(working, idx, { [String(target)]: marks }, variant);
  }

  return turnCounts;
}

function canAppendMarks(turnCounts: Record<string, number>, sector: CricketSector, marksToAdd: number) {
  const nextCounts = { ...turnCounts, [String(sector)]: (turnCounts[String(sector)] || 0) + marksToAdd };
  if (sumTurnCounts(nextCounts) > 9) return false;
  const tokens = buildDartTokens(nextCounts);
  return tokens.length <= 3;
}

function buildCricketValueString(players: PlayerState[], round: number, deviceInfo: string) {
  const ts = Date.now();
  const playerChunks = players.flatMap((p) => [
    p.name,
    String(p.wins),
    String(p.points),
    String(p.marks[20] || 0),
    String(p.marks[19] || 0),
    String(p.marks[18] || 0),
    String(p.marks[17] || 0),
    String(p.marks[16] || 0),
    String(p.marks[15] || 0),
    String(p.marks.B || 0),
  ]);

  return [
    'cricket',
    String(players.length),
    ...playerChunks,
    String(round),
    String(deviceInfo),
    String(ts),
  ].join('_');
}

export default function KrikettScreen({ onExit, clubId, initialBoardNr, onOpenScoring, onOpenDisplay, onOpenDisplayById, openNewGameRequestKey }: Props) {
  useDisplayWakeLock(true);
  const { width, height } = useWindowDimensions();
  const isPortrait = height >= width;
  const initialVirtualPrefs = useMemo(() => loadVirtualPrefs(), []);

  const [playerNameHistory, setPlayerNameHistory] = useState<string[]>(() => loadPlayerNameHistory());
  const [players, setPlayers] = useState<PlayerState[]>(() => [freshPlayer('PL.1'), freshPlayer('PL.2')]);
  const [active, setActive] = useState(0);
  const [round, setRound] = useState(1);
  const [gameStarter, setGameStarter] = useState(0);
  const [variant, setVariant] = useState<CricketVariant>('own');
  const [boardNr, setBoardNr] = useState<number | null>(() => initialBoardNr ?? null);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [showBroadcastDialog, setShowBroadcastDialog] = useState(false);
  const [showScanDialog, setShowScanDialog] = useState(false);
  const [scanInput, setScanInput] = useState('');
  const [qrActivated, setQrActivated] = useState(false);
  const [locationCoords, setLocationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locationGranted, setLocationGranted] = useState(false);
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [showQuickMenu, setShowQuickMenu] = useState(false);
  const [showBoardDialog, setShowBoardDialog] = useState(false);
  const [showLevelPicker, setShowLevelPicker] = useState(false);
  const playersRef = useRef(players);
  const handledOpenNewGameKeyRef = useRef<number | null>(null);
  const [showWinnerDialog, setShowWinnerDialog] = useState(false);
  const [winnerText, setWinnerText] = useState('');
  const [winnerRound, setWinnerRound] = useState<number | null>(null);
  const [pendingWinnerIdx, setPendingWinnerIdx] = useState<number | null>(null);
  const [pendingTurn, setPendingTurn] = useState<Record<string, number>>({});
  const [showInactiveDialog, setShowInactiveDialog] = useState(false);
  const [draft, setDraft] = useState<SetupDraft>({
    humanNames: ['PL.1', 'PL.2'],
    vsVirtual: initialVirtualPrefs.enabled,
    virtualLevel: initialVirtualPrefs.level,
  });
  const [nameTouched, setNameTouched] = useState<boolean[]>([false, false, false, false]);
  const [menuBoardTmp, setMenuBoardTmp] = useState<number | null>(initialBoardNr ?? null);
  const [warnedBusyBoard, setWarnedBusyBoard] = useState<number | null>(null);
  const [pendingStartVariant, setPendingStartVariant] = useState<CricketVariant>('own');
  const [boardTailMap, setBoardTailMap] = useState<Record<number, { deviceInfo: string | null; ts: number }>>({
    1: { deviceInfo: null, ts: 0 }, 2: { deviceInfo: null, ts: 0 }, 3: { deviceInfo: null, ts: 0 }, 4: { deviceInfo: null, ts: 0 },
    5: { deviceInfo: null, ts: 0 }, 6: { deviceInfo: null, ts: 0 }, 7: { deviceInfo: null, ts: 0 }, 8: { deviceInfo: null, ts: 0 },
  });

  const undoStack = useRef<GameSnapshot[]>([]);
  const clientIdRef = useRef<string>(makeClientId());
  const deviceInfoRef = useRef<string>(getOrCreateDeviceId());
  const virtualTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLocalSendRef = useRef<number>(0);
  const [boardDialogMode, setBoardDialogMode] = useState<'switch' | 'start'>('switch');

  const roundFlashOpacity = useRef(new Animated.Value(0)).current;
  const roundFlashScale = useRef(new Animated.Value(0.88)).current;

  const turnLabel = useMemo(() => buildTurnLabel(pendingTurn), [pendingTurn]);

  const saveNameHistoryFrom = useCallback((names: string[]) => {
    const nextHistory = Array.from(
      new Set([...names.filter((v) => v && !/^PL\./i.test(v)), ...playerNameHistory])
    ).slice(0, 20);
    setPlayerNameHistory(nextHistory);
    savePlayerNameHistory(nextHistory);
  }, [playerNameHistory]);

  const markLocalFirebaseSend = () => {
    lastLocalSendRef.current = Date.now();
  };

  const resetBoardConnectionState = () => {
    setBoardNr(null);
    setMenuBoardTmp(null);
    setShowBoardDialog(false);
    setBoardDialogMode('switch');
    setWarnedBusyBoard(null);
    setShowInactiveDialog(true);
  };

  const pushToFirebase = useCallback(async (nextPlayers: PlayerState[], nextRound: number, nextBoardNr: number | null) => {
    if (!boardId) return;
    if (!locationGranted && !qrActivated) return;
    try {
      await publishBoardRecord({
        boardId,
        kind: 'cricket',
        stats: buildCricketValueString(nextPlayers, nextRound, deviceInfoRef.current),
        deviceId: deviceInfoRef.current,
        lat: locationGranted ? locationCoords?.lat ?? null : null,
        lng: locationGranted ? locationCoords?.lng ?? null : null,
      });
    } catch {}
  }, [boardId, locationGranted, qrActivated, locationCoords]);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);
  useEffect(() => {
    void pushToFirebase(players, round, boardNr);
  }, [players, round, boardId, locationGranted, qrActivated, locationCoords, pushToFirebase]);

  useEffect(() => {
    if (boardNr == null) {
      lastLocalSendRef.current = 0;
      return;
    }
    markLocalFirebaseSend();
    const id = setInterval(() => {
      const last = lastLocalSendRef.current || 0;
      if (!last) return;
      if (Date.now() - last > INACTIVITY_MS) {
        resetBoardConnectionState();
      }
    }, INACTIVITY_CHECK_MS);
    return () => clearInterval(id);
  }, [boardNr]);

  useEffect(() => {
    if (!showBoardDialog) return;
    const unsubs = BOARD_NRS.flatMap((n) => [
      onValue(ref(db, `score/${clubId}/${n}`), (snap) => {
        const raw = snap.val() == null ? null : String(snap.val());
        const tail = parseScoreTail(raw);
        setBoardTailMap((prev) => {
          const current = prev[n] || { deviceInfo: null, ts: 0 };
          if (tail.ts >= current.ts) return { ...prev, [n]: tail };
          return prev;
        });
      }),
      onValue(ref(db, `cricket/${clubId}/${n}`), (snap) => {
        const raw = snap.val() == null ? null : String(snap.val());
        const tail = parseScoreTail(raw);
        setBoardTailMap((prev) => {
          const current = prev[n] || { deviceInfo: null, ts: 0 };
          if (tail.ts >= current.ts) return { ...prev, [n]: tail };
          return prev;
        });
      }),
    ]);
    return () => unsubs.forEach((u) => u());
  }, [showBoardDialog, clubId]);

  useEffect(() => {
    if (!players[active]?.isVirtual) return;
    if (showWinnerDialog || showSetupDialog || showBoardDialog || showLevelPicker) return;

    if (virtualTimeoutRef.current) clearTimeout(virtualTimeoutRef.current);
    virtualTimeoutRef.current = setTimeout(() => {
      const turnCounts = generateVirtualTurn(players, active, draft.virtualLevel, variant);
      if (!Object.keys(turnCounts).length) {
        advanceTurn();
        return;
      }
      pushUndo();
      const nextPlayers = applyCricketTurn(players, active, turnCounts, variant);
      finishTurn(nextPlayers, active);
    }, 700);

    return () => {
      if (virtualTimeoutRef.current) clearTimeout(virtualTimeoutRef.current);
    };
  }, [players, active, draft.virtualLevel, variant, showWinnerDialog, showSetupDialog, showBoardDialog, showLevelPicker]);

  useEffect(() => () => {
    if (virtualTimeoutRef.current) clearTimeout(virtualTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (active !== gameStarter) return;
    if (showSetupDialog || showBoardDialog || showLevelPicker || showWinnerDialog) return;

    roundFlashOpacity.setValue(0);
    roundFlashScale.setValue(0.88);

    Animated.parallel([
      Animated.sequence([
        Animated.timing(roundFlashOpacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(520),
        Animated.timing(roundFlashOpacity, {
          toValue: 0,
          duration: 280,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
      Animated.sequence([
        Animated.timing(roundFlashScale, {
          toValue: 1.04,
          duration: 220,
          easing: Easing.out(Easing.back(1.4)),
          useNativeDriver: true,
        }),
        Animated.timing(roundFlashScale, {
          toValue: 1,
          duration: 200,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, [round, active, gameStarter, showSetupDialog, showBoardDialog, showLevelPicker, showWinnerDialog, roundFlashOpacity, roundFlashScale]);

  const shouldDimBoardCircle = (n: number) => {
    const tail = boardTailMap[n];
    if (!tail) return false;
    const isFresh = tail.ts > 0 && Date.now() - tail.ts <= FRESH_LIMIT_MS;
    if (!isFresh) return false;
    if (tail.deviceInfo && tail.deviceInfo === deviceInfoRef.current) return false;
    return true;
  };

  const pushUndo = () => {
    undoStack.current.push({
      players: clonePlayers(players),
      active,
      boardNr,
      variant,
      round,
      gameStarter,
    });
  };

  const advanceTurn = () => {
    setPendingTurn({});
    const nextActive = (active + 1) % players.length;
    setActive(nextActive);
    if (nextActive === gameStarter) {
      setRound((prev) => prev + 1);
    }
  };

  const restartAfterWin = (winnerIdx: number) => {
    const nextStarter = (gameStarter + 1) % players.length;
    const nextPlayers = players.map((p, idx) =>
      freshPlayer(p.name, !!p.isVirtual, p.wins + (idx === winnerIdx ? 1 : 0))
    );

    undoStack.current = [];
    setPlayers(nextPlayers);
    setActive(nextStarter);
    setGameStarter(nextStarter);
    setRound(1);
    setPendingTurn({});
    setShowWinnerDialog(false);
    setWinnerText('');
    setWinnerRound(null);
    setPendingWinnerIdx(null);
  };

  const finishTurn = (nextPlayers: PlayerState[], playerIdx: number) => {
    setPlayers(nextPlayers);
    setPendingTurn({});

    if (canWin(nextPlayers, playerIdx, variant)) {
      setWinnerText(`${nextPlayers[playerIdx].name} wins!`);
      setWinnerRound(round);
      setPendingWinnerIdx(playerIdx);
      setShowWinnerDialog(true);
      return;
    }

    const nextActive = (playerIdx + 1) % nextPlayers.length;
    setActive(nextActive);
    if (nextActive === gameStarter) {
      setRound((prev) => prev + 1);
    }
  };

  const appendMarks = (sector: CricketSector, marksToAdd: number) => {
    setPendingTurn((prev) => {
      if (!canAppendMarks(prev, sector, marksToAdd)) return prev;
      return { ...prev, [String(sector)]: (prev[String(sector)] || 0) + marksToAdd };
    });
  };

  const onSectorTap = (sector: CricketSector) => {
    ensureKrikettFullscreen();
    if (players[active]?.isVirtual) return;
    if (showWinnerDialog) return;
    appendMarks(sector, 1);
  };

  const onQuickTap = (btn: (typeof QUICK_BUTTONS)[number]) => {
    ensureKrikettFullscreen();
    if (players[active]?.isVirtual) return;
    if (showWinnerDialog) return;

    if (btn === 'DBull') {
      appendMarks('B', 2);
      return;
    }

    const sector = Number(btn.replace('T', '')) as 20 | 19 | 18 | 17 | 16 | 15;
    appendMarks(sector, 3);
  };

  const onClear = () => {
    ensureKrikettFullscreen();
    setPendingTurn({});
  };

  const onEnter = () => {
    ensureKrikettFullscreen();
    if (players[active]?.isVirtual) return;

    pushUndo();

    if (!Object.keys(pendingTurn).length) {
      advanceTurn();
      return;
    }

    const nextPlayers = applyCricketTurn(players, active, pendingTurn, variant);
    finishTurn(nextPlayers, active);
  };

  const onUndo = () => {
  ensureKrikettFullscreen();

  if (virtualTimeoutRef.current) {
    clearTimeout(virtualTimeoutRef.current);
    virtualTimeoutRef.current = null;
  }

  let prev = undoStack.current.pop();
  if (!prev) return;

  // Virtual meccsnÃ©l, ha most Ã©pp Ãºjra a human kÃ¶vetkezne,
  // akkor az utolsÃ³ snapshot gyakran csak a virtual elÅ‘tti Ã¡llapot:
  // vagyis a human mÃ¡r ledobta a sajÃ¡t kÃ¶rÃ©t, a virtual mÃ©g nem.
  // Ilyenkor mÃ©g egyet vissza kell lÃ©pni, hogy a human dobÃ¡sa is
  // visszavonÃ³djon, Ã©s ismÃ©t a human kÃ¶vetkezzen Ã¼res bevitellel.
  const isVirtualMatch = prev.players.some((p) => p.isVirtual);

  if (
    isVirtualMatch &&
    players[active] &&
    !players[active].isVirtual &&
    prev.players[prev.active] &&
    !!prev.players[prev.active].isVirtual
  ) {
    const prevHuman = undoStack.current.pop();
    if (prevHuman) {
      prev = prevHuman;
    }
  }

  const restoredPlayers = clonePlayers(prev.players);

  setPlayers(restoredPlayers);
  setActive(prev.active);
  setBoardNr(prev.boardNr);
  setVariant(prev.variant);
  setRound(prev.round);
  setGameStarter(prev.gameStarter);
  setPendingTurn({});
  setShowWinnerDialog(false);
  setWinnerText('');
  setWinnerRound(null);
  setPendingWinnerIdx(null);

  // Undo utÃ¡n rÃ¶gtÃ¶n menjen fel a visszaÃ¡llÃ­tott Ã¡llapot Firebase-be is.
  void pushToFirebase(restoredPlayers, prev.round, prev.boardNr);
};

  const addHumanPlayer = () => {
    if (draft.vsVirtual) return;
    if (draft.humanNames.length >= 4) return;
    setDraft((prev) => ({ ...prev, humanNames: [...prev.humanNames, ''] }));
    setNameTouched((prev) => [...prev, false].slice(0, 4));
  };


  const buildDraftFromCurrent = (): SetupDraft => {
    const persisted = loadVirtualPrefs();
    const currentHasVirtual = players.some((p) => p.isVirtual);
    const nextVsVirtual = currentHasVirtual || persisted.enabled;
    const currentHumanPlayers = players.filter((p) => !p.isVirtual).map((p) => p.name);

    return {
      humanNames: nextVsVirtual
        ? [currentHumanPlayers[0] || 'PL.1']
        : (currentHumanPlayers.length > 0 ? currentHumanPlayers : ['PL.1', 'PL.2']),
      vsVirtual: nextVsVirtual,
      virtualLevel: players.find((p) => p.isVirtual)?.name?.startsWith('Lv.')
        ? Number((players.find((p) => p.isVirtual)?.name || 'Lv.5').replace('Lv.', '')) || persisted.level
        : persisted.level,
    };
  };

  const replayCurrentMatch = () => {
    const replayDraft = buildDraftFromCurrent();
    setDraft(replayDraft);
    setShowQuickMenu(false);
    setShowSetupDialog(false);
    setShowBoardDialog(false);
    startGame(variant, boardNr != null, boardNr, replayDraft);
  };

  useEffect(() => {
    if (openNewGameRequestKey == null) return;
    if (handledOpenNewGameKeyRef.current === openNewGameRequestKey) return;
    handledOpenNewGameKeyRef.current = openNewGameRequestKey;
    openSetup();
  }, [openNewGameRequestKey]);

  const openSetup = () => {
    ensureKrikettFullscreen();
    setShowQuickMenu(false);
    setDraft(buildDraftFromCurrent());
    setWarnedBusyBoard(null);
    setMenuBoardTmp(boardNr);
    setShowSetupDialog(true);
  };

  const setVsVirtualDraft = (value: boolean) => {
    setDraft((prev) => ({
      ...prev,
      vsVirtual: value,
      humanNames: value
        ? [prev.humanNames[0] || 'PL.1']
        : (prev.humanNames.length >= 2 ? prev.humanNames : [prev.humanNames[0] || 'PL.1', 'PL.2']),
    }));
  };

  const startGame = (selectedVariant: CricketVariant, withBoard: boolean, forcedBoard?: number | null, draftOverride?: SetupDraft) => {
    const sourceDraft = draftOverride ?? draft;
    const rawNames = sourceDraft.vsVirtual
      ? [sourceDraft.humanNames[0] || 'PL.1']
      : sourceDraft.humanNames;

    const trimmedNames = rawNames.map((n) => (n || '').trim());

    const names = sourceDraft.vsVirtual
      ? [trimmedNames[0] || 'PL.1']
      : trimmedNames
          .map((name, idx) => ({ name, idx }))
          .filter((item, idx) => idx < 2 || item.name !== '')
          .map((item, idx) => item.name || `PL.${idx + 1}`)
          .slice(0, 4);

    const finalNames = sourceDraft.vsVirtual ? names : normalizePlayerNames(names);

    const nextPlayers = sourceDraft.vsVirtual
      ? [freshPlayer(finalNames[0]), freshPlayer(`Lv.${sourceDraft.virtualLevel}`, true)]
      : finalNames.map((name) => freshPlayer(name));

    saveVirtualPrefs({ enabled: sourceDraft.vsVirtual, level: sourceDraft.virtualLevel });
    saveNameHistoryFrom(finalNames);
    undoStack.current = [];
    setPlayers(nextPlayers);
    setActive(0);
    setGameStarter(0);
    setRound(1);
    setVariant(selectedVariant);
    setPendingTurn({});
    setBoardNr(withBoard ? (forcedBoard ?? menuBoardTmp) : null);
    setShowSetupDialog(false);
    setShowBoardDialog(false);
    setBoardDialogMode('switch');
    setShowWinnerDialog(false);
    setWinnerText('');
    setWinnerRound(null);
    setPendingWinnerIdx(null);
  };

  const requestStart = (selectedVariant: CricketVariant) => {
    ensureKrikettFullscreen();
    if (!clubId?.trim()) {
      startGame(selectedVariant, false);
      return;
    }
    setPendingStartVariant(selectedVariant);
    setBoardDialogMode('start');
    setShowBoardDialog(true);
    setWarnedBusyBoard(null);
    setMenuBoardTmp(boardNr);
  };

  const handleBoardPick = (n: number) => {
    const busy = shouldDimBoardCircle(n);
    if (busy && warnedBusyBoard !== n) {
      setWarnedBusyBoard(n);
      return;
    }
    setWarnedBusyBoard(null);
    setMenuBoardTmp(n);

    if (boardDialogMode === 'start') {
      startGame(pendingStartVariant, true, n);
    }
  };

  const renderBroadcastIcon = () => {
    const src = require('./broadcast.png');
    const isActive = !!boardId && (locationGranted || qrActivated);
    return (
      <View style={styles.broadcastOuter} pointerEvents="none">
        <View style={[styles.broadcastCircle, isActive ? styles.broadcastCircleOn : styles.broadcastCircleOff]}>
          <Image source={src} style={styles.broadcastIconInside} />
        </View>
        {isActive ? (
          <View style={styles.broadcastBadge}>
            <Text style={styles.broadcastBadgeText}>QR</Text>
          </View>
        ) : null}
      </View>
    );
  };
  const keyHitSlop = { top: 10, bottom: 10, left: 10, right: 10 } as const;
  return (
    <View style={styles.safe}>
      <View style={styles.screen}>
        <View style={styles.topSpacer} />

        <Pressable style={styles.floatingBoardBadgeBtn} onPress={() => { if (boardId) { setQrActivated(true); setShowBroadcastDialog(true); void pushToFirebase(playersRef.current, round, null); } }}>
          {renderBroadcastIcon()}
        </Pressable>

        <Animated.View
          pointerEvents="none"
          style={[
            styles.roundFlashWrap,
            {
              opacity: roundFlashOpacity,
              transform: [{ scale: roundFlashScale }],
            },
          ]}
        >
          <Text style={styles.roundFlashText}>{`Round ${round}`}</Text>
        </Animated.View>

        <View style={styles.tableWrap}>
          {players.map((player, idx) => (
            <View key={player.id} style={[styles.tableRow, idx === active ? styles.tableRowActive : null]}>
              <View style={[styles.cellBase, styles.playerCell, styles.playerCellRow]}>
              <Text
                style={[styles.playerNameText, idx === active ? styles.playerNameActive : null]}
                numberOfLines={1}
              >
                {player.name}
              </Text>

              <Text style={styles.playerWinsText} numberOfLines={1}>
                {player.wins}
              </Text>
            </View>
              <View style={[styles.cellBase, styles.pointsCell]}>
                <Text style={styles.pointsText}>{player.points}</Text>
              </View>

              {SECTORS.map((sector) => (
                <View key={`${player.id}-${String(sector)}`} style={[styles.cellBase, styles.markCell, styles.markCellBoxWrap]}>
                  <CricketMarkBox
                    label={sector === 'B' ? 'B.' : String(sector)}
                    marks={player.marks[sector]}
                    compact
                    hideLabel={isPortrait}
                    short={isPortrait}
                  />
                </View>
              ))}
            </View>
          ))}
        </View>

        <View style={styles.inputArea}>
          {isPortrait ? (
            <>
              <View style={styles.turnInputWrap}>
                <TextInput
                  value={turnLabel}
                  editable={false}
                  caretHidden
                  showSoftInputOnFocus={false}
                  pointerEvents="none"
                  style={styles.turnInput}
                  placeholder="Turn input"
                  placeholderTextColor="rgba(0,0,0,0.35)"
                />
              </View>

              <View style={styles.portraitColumnsWrap}>
                <View style={styles.portraitColumn}>
                  {SECTOR_BUTTONS.map((btn) => (
                    <Pressable
                      key={`sector-${String(btn)}`}
                      hitSlop={keyHitSlop}
                                            onTouchStart={(e: any) => {
                        e?.preventDefault?.();
                        onSectorTap(btn);
                      }}
                      style={({ pressed }) => [styles.keyBtn, styles.portraitColumnBtn, pressed ? styles.keyBtnPressed : null]}
                    >
                      <Text style={styles.keyBtnText}>{btn === 'B' ? 'Bull' : btn}</Text>
                    </Pressable>
                  ))}
                </View>

                <View style={styles.portraitColumn}>
                  {QUICK_BUTTONS.map((btn) => (
                    <Pressable
                      key={`quick-${btn}`}
                      hitSlop={keyHitSlop}
                                          onTouchStart={(e: any) => {
                        e?.preventDefault?.();
                        onQuickTap(btn);
                      }}
                      style={({ pressed }) => [styles.keyBtn, styles.keyBtnQuick, pressed ? styles.keyBtnPressed : null]}
                    >
                      <Text style={styles.keyBtnText}>{btn}</Text>
                    </Pressable>
                  ))}
                </View>

                <View style={styles.portraitColumn}>
                  <Pressable
                    hitSlop={keyHitSlop}
                                      onTouchStart={(e: any) => {
                        e?.preventDefault?.();
                        onEnter();
                      }}
                    style={({ pressed }) => [styles.keyBtn, styles.keyBtnEnter, styles.portraitEnterBtn, pressed ? styles.keyBtnPressed : null]}
                  >

                    <Text style={[styles.keyBtnText, styles.keyBtnTextAction]}>ENTER</Text>
                  </Pressable>
                  
                  
                    <Pressable
                    hitSlop={keyHitSlop}
                                      onTouchStart={(e: any) => {
                        e?.preventDefault?.();
                        onClear();
                      }}
                    style={({ pressed }) => [styles.keyBtn, styles.keyBtnAction, styles.portraitClearBtn, pressed ? styles.keyBtnPressed : null]}
                  >
                    <Text style={[styles.keyBtnText, styles.keyBtnTextAction]}>CLEAR</Text>
                  </Pressable>
                  <Pressable
                      hitSlop={keyHitSlop}
                      onPress={onUndo}
                      style={({ pressed }) => [styles.keyBtn, styles.keyBtnAction, styles.portraitUndoBtn, pressed ? styles.keyBtnPressed : null]}
                    >
                  
                    <Text style={[styles.keyBtnText, styles.keyBtnTextAction]}>UNDO</Text>
                  </Pressable>
                </View>
              </View>
            </>
          ) : (
            <View style={styles.buttonArea}>
              <View style={styles.buttonRow}>
                {SECTOR_BUTTONS.map((btn) => (
                  <Pressable
                      key={`sector-${String(btn)}`}
                      hitSlop={keyHitSlop}
                                            onTouchStart={(e: any) => {
                        e?.preventDefault?.();
                        onSectorTap(btn);
                      }}
                      style={({ pressed }) => [styles.keyBtn, pressed ? styles.keyBtnPressed : null]}
                    >
                    <Text style={styles.keyBtnText}>{btn === 'B' ? 'Bull' : btn}</Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.buttonRow}>
                {QUICK_BUTTONS.map((btn) => (
                  <Pressable
                    key={`quick-${btn}`}
                    hitSlop={keyHitSlop}
                                        onTouchStart={(e: any) => {
                        e?.preventDefault?.();
                        onQuickTap(btn);
                      }}
                    style={({ pressed }) => [styles.keyBtn, styles.keyBtnQuick, pressed ? styles.keyBtnPressed : null]}
                  >
                    <Text style={styles.keyBtnText}>{btn}</Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.landscapeActionRow}>
                <View style={styles.landscapeInputWrap}>
                  <TextInput
                    value={turnLabel}
                    editable={false}
                    caretHidden
                    showSoftInputOnFocus={false}
                    pointerEvents="none"
                    style={[styles.turnInput, styles.turnInputLandscape]}
                    placeholder="Turn input"
                    placeholderTextColor="rgba(0,0,0,0.35)"
                  />
                </View>

                <Pressable
                  hitSlop={keyHitSlop}
                                    onTouchStart={(e: any) => {
                        e?.preventDefault?.();
                        onEnter();
                      }}
                  style={({ pressed }) => [styles.keyBtn, styles.keyBtnEnter, styles.landscapeEnterBtn, pressed ? styles.keyBtnPressed : null]}
                >
                  <Text style={[styles.keyBtnText, styles.keyBtnTextAction]}>ENTER</Text>
                </Pressable>

                  <Pressable
                    hitSlop={keyHitSlop}
                                      onTouchStart={(e: any) => {
                        e?.preventDefault?.();
                        onClear();
                      }}
                    style={({ pressed }) => [styles.keyBtn, styles.keyBtnAction, styles.landscapeClearBtn, pressed ? styles.keyBtnPressed : null]}
                  >
                  <Text style={[styles.keyBtnText, styles.keyBtnTextAction]}>CLEAR</Text>
                </Pressable>

                    <Pressable
                      hitSlop={keyHitSlop}
                      onPress={onUndo}
                      style={({ pressed }) => [styles.keyBtn, styles.keyBtnAction, styles.landscapeUndoBtn, pressed ? styles.keyBtnPressed : null]}
                    >
                    <Text style={[styles.keyBtnText, styles.keyBtnTextAction]}>UNDO</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        <Pressable style={styles.cornerMenu} onPress={() => setShowQuickMenu((v) => !v)}>
          <Text style={styles.cornerText}>â˜°</Text>
        </Pressable>
      </View>


      <Modal visible={showQuickMenu} transparent animationType="fade" onRequestClose={() => setShowQuickMenu(false)}>
        <Pressable style={styles.quickMenuOverlay} onPress={() => setShowQuickMenu(false)}>
          <View style={styles.quickMenuCard}>
            <Pressable style={styles.quickMenuItem} onPress={() => { setShowQuickMenu(false); onOpenScoring?.(); }}>
              <Text style={styles.quickMenuItemText}>new 501</Text>
            </Pressable>
            <Pressable style={styles.quickMenuItem} onPress={() => { setShowQuickMenu(false); openSetup(); }}>
              <Text style={styles.quickMenuItemText}>new Cricket</Text>
            </Pressable>
            <Pressable style={styles.quickMenuItem} onPress={() => { setShowQuickMenu(false); onOpenDisplay?.(); }}>
              <Text style={styles.quickMenuItemText}>Big Display</Text>
            </Pressable>
            <Pressable style={styles.quickMenuItem} onPress={replayCurrentMatch}>
              <Text style={styles.quickMenuItemText}>re-play</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={showSetupDialog} transparent animationType="fade" onRequestClose={() => setShowSetupDialog(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowSetupDialog(false)} />
          <View style={styles.modalCardWide}>
            <Text style={styles.modalTitle}>New cricket game</Text>

            {draft.humanNames.map((name, idx) => (
              <View key={`human-${idx}`} style={[styles.setupFieldWrap, idx > 0 ? { marginTop: 10 } : null]}>
                <TextInput
                  value={name}
                  onChangeText={(v) => {
                    setDraft((prev) => {
                      const next = [...prev.humanNames];
                      next[idx] = v;
                      return { ...prev, humanNames: next };
                    });
                  }}
                  style={styles.modalInput}
                  placeholder={`PL.${idx + 1}`}
                  placeholderTextColor="rgba(0,0,0,0.45)"
                  onFocus={() => {
                    if (!nameTouched[idx]) {
                      setDraft((prev) => {
                        const next = [...prev.humanNames];
                        next[idx] = '';
                        return { ...prev, humanNames: next };
                      });
                      setNameTouched((prev) => {
                        const next = [...prev];
                        next[idx] = true;
                        return next;
                      });
                    }
                  }}
                />
              </View>
            ))}

            {draft.vsVirtual ? (
              <Pressable onPress={() => setShowLevelPicker(true)} style={[styles.modalInputLike, { marginTop: 10 }]}>
                <Text style={styles.modalInputLikeText}>{`Lv.${draft.virtualLevel}`}</Text>
              </Pressable>
            ) : draft.humanNames.length < 4 ? (
              <Pressable onPress={addHumanPlayer} style={[styles.modalBtn, styles.modalBtnGhost, { marginTop: 10 }]}>
                <Text style={styles.modalBtnTextGhost}>Add player</Text>
              </Pressable>
            ) : null}

            <View style={styles.virtualToggleRow}>
              <Switch value={draft.vsVirtual} onValueChange={setVsVirtualDraft} />
              <Text style={styles.switchLabel}>vs Virtual Player</Text>
            </View>

            <View style={styles.modalBtns}>
              <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => requestStart('penalty')}>
                <Text style={styles.modalBtnTextGhost}>Start penalty</Text>
              </Pressable>
              <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={() => requestStart('own')}>
                <Text style={styles.modalBtnTextOk}>Start own score</Text>
              </Pressable>
            </View>

            <Pressable onPress={onExit} hitSlop={8} style={styles.exitInline}><Text style={styles.exitInlineText}>Exit cricket mode</Text></Pressable>
          </View>
        </View>
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
                  <Pressable key={level} onPress={() => {
                    setDraft((prev) => ({ ...prev, virtualLevel: level }));
                    setShowLevelPicker(false);
                  }} style={[styles.levelPickerRow, selected ? styles.levelPickerRowOn : null]}>
                    <Text style={[styles.levelPickerRowText, selected ? styles.levelPickerRowTextOn : null]}>{`Lv.${level}`}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={false && showBoardDialog} transparent animationType="fade" onRequestClose={() => setShowBoardDialog(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowBoardDialog(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            {!!clubId?.trim() ? (
              <>
                <Text style={styles.modalLabel}>Board Nr:</Text>
                <View style={styles.boardPickGrid}>
                  {BOARD_NRS.map((n) => {
                    const selected = menuBoardTmp === n;
                    const dim = shouldDimBoardCircle(n) && !selected;
                    return (
                      <Pressable key={n} onPress={() => handleBoardPick(n)} style={({ pressed }) => [styles.boardPickCircle, selected ? styles.boardPickCircleOn : styles.boardPickCircleOff, dim ? styles.boardPickCircleDim : null, pressed ? { opacity: 0.8 } : null]}>
                        <Text style={[styles.boardPickText, selected ? styles.boardPickTextOn : styles.boardPickTextOff, dim ? styles.boardPickTextDim : null]}>{n}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {warnedBusyBoard != null ? <Text style={styles.busyWarningText}>This board looks busy. Tap it again to continue anyway.</Text> : null}
              </>
            ) : (
              <Text style={styles.modalHintSmall}>No club selected.</Text>
            )}

            {boardDialogMode === 'start' ? (
              <View style={styles.modalBtns}>
                <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => startGame(pendingStartVariant, false)}>
                  <Text style={styles.modalBtnTextGhost}>Start without board</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.modalBtns}>
                <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShowBoardDialog(false)}>
                  <Text style={styles.modalBtnTextGhost}>Cancel</Text>
                </Pressable>
                <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={() => {
                  setBoardNr(menuBoardTmp);
                  setShowBoardDialog(false);
                  setBoardDialogMode('switch');
                }}>
                  <Text style={styles.modalBtnTextOk}>OK</Text>
                </Pressable>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showBroadcastDialog} transparent animationType="fade" onRequestClose={() => setShowBroadcastDialog(false)}>
        <View style={styles.modalOverlay}><View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Broadcast</Text>
          <Text style={styles.modalLabel}>{locationGranted ? 'Nearby devices can see this cricket match.' : 'Location not available. QR/direct access only.'}</Text>
          {boardId ? <Image source={{ uri: buildQrImageUrl(buildBoardShareUrl(boardId)) }} style={styles.qrPreview} /> : null}
          <Text selectable style={styles.modalHintSmall}>{boardId ? buildBoardShareUrl(boardId) : 'Generating...'}</Text>
          <View style={styles.modalBtns}>
            <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShowBroadcastDialog(false)}><Text style={styles.modalBtnTextGhost}>Close</Text></Pressable>
            <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={() => { setShowBroadcastDialog(false); setShowScanDialog(true); }}><Text style={styles.modalBtnTextOk}>Scan</Text></Pressable>
          </View>
        </View></View>
      </Modal>

      <Modal visible={showScanDialog} transparent animationType="fade" onRequestClose={() => setShowScanDialog(false)}>
        <View style={styles.modalOverlay}><View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Open board display</Text>
          <TextInput value={scanInput} onChangeText={setScanInput} style={styles.modalInput} placeholder="Paste QR url or board id" placeholderTextColor="rgba(0,0,0,0.45)" />
          <View style={styles.modalBtns}>
            <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShowScanDialog(false)}><Text style={styles.modalBtnTextGhost}>Cancel</Text></Pressable>
            <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={() => { const parsed = parseBoardIdFromText(scanInput); if (parsed) { addWatchedId(parsed); setShowScanDialog(false); setScanInput(''); onOpenDisplayById?.(parsed); } }}><Text style={styles.modalBtnTextOk}>Open</Text></Pressable>
          </View>
        </View></View>
      </Modal>

      <Modal visible={showWinnerDialog} transparent animationType="fade" onRequestClose={() => setShowWinnerDialog(false)}>
        <View style={styles.modalOverlay}><View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Winner</Text>
          <Text style={styles.modalLabel}>{winnerText}</Text>
          <Text style={styles.modalLabel}>{winnerRound != null ? `Round ${winnerRound}` : ''}</Text>
          <Pressable
            style={[styles.modalBtn, styles.modalBtnOk, { marginTop: 12 }]}
            onPress={() => {
              if (pendingWinnerIdx != null) {
                restartAfterWin(pendingWinnerIdx);
              } else {
                setShowWinnerDialog(false);
              }
            }}
          >
            <Text style={styles.modalBtnTextOk}>OK</Text>
          </Pressable>
        </View></View>
      </Modal>

      
      <Modal visible={showInactiveDialog} transparent animationType="fade" onRequestClose={() => setShowInactiveDialog(false)}>
              <View style={styles.modalOverlay}><View style={styles.modalCard}>
                <Text style={styles.modalTitle}>Disconnected</Text>
      <Text style={styles.modalLabel}>You were disconnected from the board due to inactivity. If you still want to use it, please connect again.</Text>
                <Pressable style={[styles.modalBtn, styles.modalBtnOk, { marginTop: 12 }]} onPress={() => setShowInactiveDialog(false)}><Text style={styles.modalBtnTextOk}>OK</Text></Pressable>
              </View></View>
            </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#ffffff' },
  screen: { flex: 1, backgroundColor: '#ffffff', padding: 8 },
  topSpacer: { height: 10 },

  floatingBoardBadgeBtn: {
  position: 'absolute',
  right: 8,
  top: 8,
  zIndex: 2000,
  elevation: 8,
},

broadcastOuter: {
  width: 56,
  height: 56,
  position: 'relative',
  alignItems: 'center',
  justifyContent: 'center',
},

broadcastCircle: {
  width: 56,
  height: 56,
  borderRadius: 999,
  alignItems: 'center',
  justifyContent: 'center',
  borderWidth: 2,
  borderColor: '#d3d3d3',
  backgroundColor: '#ffffff',
},

broadcastCircleOff: {
  backgroundColor: '#e3e3e3',
},

broadcastCircleOn: {
  backgroundColor: '#d7ebcf',
},

broadcastIconInside: {
  width: 26,
  height: 26,
  resizeMode: 'contain',
  tintColor: 'rgba(0,0,0,0.70)',
},

broadcastBadge: {
  position: 'absolute',
  right: -6,
  bottom: -6,
  width: 24,
  height: 24,
  borderRadius: 999,
  backgroundColor: '#2f6f18',
  alignItems: 'center',
  justifyContent: 'center',
  borderWidth: 2,
  borderColor: '#ffffff',
  zIndex: 20,
  elevation: 20,
},
broadcastBadgeText: {
  color: '#ffffff',
  fontSize: 12,
  fontWeight: '800',
},
  roundFlashWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '38%',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1500,
    elevation: 8,
    pointerEvents: 'none',
  },
  roundFlashText: {
    fontSize: 36,
    fontWeight: '900',
    color: '#2f6f18',
    backgroundColor: 'rgba(255,255,255,0.92)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 16,
    overflow: 'hidden',
  },
  tableWrap: {
  marginTop: 8,
  borderRadius: 12,
  overflow: 'hidden',
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.10)',
  backgroundColor: '#2f2e2d',
},

tableHeaderRow: {
  display: 'none',
},

tableRow: {
  flexDirection: 'row',
  alignItems: 'center',
  minHeight: 50,
  borderBottomWidth: 1,
  borderBottomColor: 'rgba(255,255,255,0.07)',
  backgroundColor: '#5e5c5a',
},

tableRowActive: {
  backgroundColor: '#1E1C1F',
  // borderTopWidth: 1,
  // borderBottomWidth: 1,
  // borderTopColor: '#b38f00',
  // borderBottomColor: '#b38f00',
},

cricketMarkChipShort: {
  paddingVertical: 10,
  paddingHorizontal: 12,
  minWidth: 34,
  minHeight: 14,
},


cricketMarkThirdBase: {
  position: 'absolute',
  top: 0,
  bottom: 0,
},

cricketMarkThird1: {
  left: '0%',
  width: '33.3333%',
},

cricketMarkThird2: {
  left: '33.3333%',
  width: '33.3333%',
},

cricketMarkThird3: {
  left: '66.6666%',
  width: '33.3333%',
},

cricketMarkThirdFill: {
  position: 'absolute',
  top: 0,
  bottom: 0,
  backgroundColor: 'rgba(61,255,47,0.42)',
},

cricketMarkThirdFillMid: {
  position: 'absolute',
  top: 0,
  bottom: 0,
  backgroundColor: 'rgba(61,255,47,0.32)',
},

cricketMarkThirdBaseLight: {
  backgroundColor: 'rgba(255,255,255,0.11)',
},

cricketMarkThirdBaseMid: {
  backgroundColor: 'rgba(255,255,255,0.05)',
},

cricketMarkThirdBaseDark: {
  backgroundColor: 'rgba(255,255,255,0.11)',
},
cellBase: {
  
  justifyContent: 'center',
  paddingVertical: 2,
  paddingHorizontal: 4,
},
playerCell: {
  
  
  flex: 1.1,
},

playerCellRow: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
},

playerNameText: {
  fontSize: 16,
  fontWeight: '800',
  color: '#e6e5e5',
  textAlign: 'left',
  flex: 1,
  flexShrink: 1,
},

playerWinsText: {
  marginLeft: 8,
  fontSize: 16,
  fontWeight: '800',
  color: 'rgba(61,255,47,0.42)',
  textAlign: 'right',
  flexShrink: 0,
},

pointsCell: {
  
  flex: 0.5,
  alignItems: 'center',
},

markCell: {
  flex: 1,
  alignItems: 'center',
  justifyContent: 'center',
},

markCellBoxWrap: {
  paddingVertical: 1,
  paddingHorizontal: 2,
},

playerNameActive: {
  color: '#3DFF2F',
},

pointsText: {
  fontSize: 19,
  fontWeight: '800',
  color: '#b38f00',
},

markText: {
  display: 'none',
},

cricketMarkChip: {
  borderRadius: 8,
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.16)',
  backgroundColor: 'rgba(68, 65, 65, 0.97)',
  overflow: 'hidden',
  justifyContent: 'center',
  alignItems: 'center',
  alignSelf: 'center',
  position: 'relative',
  paddingVertical: 6,
  paddingHorizontal: 8,
  minWidth: 55,
},
cricketMarkChipCompact: {
  paddingVertical: 8,
  paddingHorizontal: 24,
  minWidth: 55,
  borderRadius: 6,
},

cricketMarkChipBg: {
  ...StyleSheet.absoluteFillObject,
  position: 'absolute',
},


cricketMarkChipLabel: {
  color: 'rgba(255,255,255,0.92)',
  fontSize: 18,
  fontWeight: '700',
  textAlign: 'center',
  zIndex: 2,
},  
  headerCell: { minHeight: 64 },
  headerText: { color: 'rgba(0,0,0,0.62)', fontWeight: '900', fontSize: 24 },
  
  inputArea: { flex: 1, marginTop: 10 },
  turnInputWrap: { marginBottom: 8 },
  turnInput: { height: 44, backgroundColor: '#fff', borderWidth: 2, borderColor: 'rgba(0,0,0,0.18)', borderRadius: 10, paddingHorizontal: 12, fontSize: 20, fontWeight: '900', color: 'rgba(0,0,0,0.82)' },
  turnInputLandscape: {
    flex: 1,
  },
  buttonArea: { flex: 1, justifyContent: 'space-between', gap: 8 },
  buttonRow: { flex: 1, flexDirection: 'row', gap: 8 },

  portraitColumnsWrap: { flex: 1, flexDirection: 'row', gap: 8 },
  portraitColumn: { flex: 1, gap: 8 },
  portraitColumnBtn: { flex: 1 },
  portraitEnterBtn: { flex: 3 },
  portraitClearBtn: { flex: 2 },
  portraitUndoBtn: { flex: 2 },

  landscapeActionRow: { flex: 1, flexDirection: 'row', gap: 8 },
  landscapeInputWrap: {
    flex: 2,
    alignSelf: 'stretch',
  },
  landscapeEnterBtn: { flex: 2 },
  landscapeClearBtn: { flex: 1 },
  landscapeUndoBtn: { flex: 2 },

  keyBtn: { flex: 1, borderRadius: 10, backgroundColor: '#f3d49b', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)' },
  keyBtnQuick: { backgroundColor: '#d9c07f' },
  keyBtnAction: { backgroundColor: '#7a5b22' },
  keyBtnEnter: { backgroundColor: '#2f6f18' },
  keyBtnPressed: { opacity: 0.8 },
  keyBtnText: { color: '#b3422a', fontWeight: '900', fontSize: 22 },
  keyBtnTextAction: { color: 'rgba(255,255,255,0.94)', fontSize: 18 },

  quickMenuOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    paddingRight: 12,
    paddingBottom: 82,
  },
  quickMenuCard: {
    minWidth: 168,
    backgroundColor: '#2f6f18',
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  quickMenuItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  quickMenuItemText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  qrPreview: {
    alignSelf: 'center',
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 12,
  },
  cornerMenu: { position: 'absolute', right: 6, bottom: 6, width: 64, height: 64, borderRadius: 999, backgroundColor: '#2f6f18', alignItems: 'center', justifyContent: 'center', zIndex: 999, elevation: 5 },
  cornerText: { color: '#ffffff', fontWeight: '900', fontSize: 22 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  modalCard: { width: '92%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 14, padding: 14 },
  modalCardWide: { width: '92%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 14, padding: 14 },
  modalTitle: { fontWeight: '900', fontSize: 18, marginBottom: 10, color: 'rgba(0,0,0,0.85)' },
  modalLabel: { fontWeight: '800', color: 'rgba(0,0,0,0.6)', marginTop: 6, marginBottom: 4 },
  modalInput: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10, fontWeight: '800', color: 'rgba(0,0,0,0.85)' },
  modalInputLike: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 11, justifyContent: 'center', backgroundColor: '#fff' },
  modalInputLikeText: { fontWeight: '900', color: 'rgba(0,0,0,0.82)' },
  setupFieldWrap: { position: 'relative' },
  virtualToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, marginBottom: 18 },
  switchLabel: { fontWeight: '900', color: 'rgba(0,0,0,0.72)' },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 12 },
  modalBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  modalBtnGhost: { backgroundColor: 'rgba(0,0,0,0.08)' },
  modalBtnOk: { backgroundColor: '#2f6f18' },
  modalBtnTextGhost: { fontWeight: '900', color: 'rgba(0,0,0,0.75)' },
  modalBtnTextOk: { fontWeight: '900', color: '#ffffff' },
  exitInline: { marginTop: 14, alignItems: 'center' },
  exitInlineText: { color: 'rgba(0,0,0,0.55)', fontWeight: '900', textDecorationLine: 'underline' },
  levelPickerCard: { width: '84%', maxWidth: 280, maxHeight: '70%', backgroundColor: '#fff', borderRadius: 14, padding: 14 },
  levelPickerScroll: { maxHeight: 320 },
  levelPickerScrollContent: { gap: 8 },
  levelPickerRow: { paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.06)' },
  levelPickerRowOn: { backgroundColor: 'rgba(47,111,24,0.16)', borderWidth: 1, borderColor: '#2f6f18' },
  levelPickerRowText: { color: 'rgba(0,0,0,0.78)', fontWeight: '900' },
  levelPickerRowTextOn: { color: '#2f6f18' },
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
  busyWarningText: { marginTop: 10, fontWeight: '900', color: '#b3422a' },
});