import { MaterialIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { onValue, ref } from 'firebase/database';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { db } from '../../lib/firebase';
import {
  addWatchedId,
  buildBoardShareUrl,
  buildQrImageUrl,
  getOrCreateBoardId,
  getOrCreateDeviceId,
  parseBoardIdFromText,
  publishBoardRecord,
  requestBrowserLikeLocation,
} from './broadcastShared';

type Props = {
  onExit: () => void;
  clubId: string;
  initialBoardNr?: number | null;
  onOpenScoring?: () => void;
  onOpenDisplay?: () => void;
  onOpenDisplayById?: (id: string) => void;
  openNewGameRequestKey?: number;
  replayRequestKey?: number;
};

type CricketSector = 20 | 19 | 18 | 17 | 16 | 15 | 'B';

type PlayerState = {
  id: string;
  name: string;
  points: number;
  marks: Record<CricketSector, number>;
  wins: number;
};

type SetupDraft = {
  humanNames: [string, string, string, string];
};

type GameSnapshot = {
  players: PlayerState[];
  active: number;
  boardNr: number | null;
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
const BOARD_NRS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const SECTORS: CricketSector[] = [20, 19, 18, 17, 16, 15, 'B'];
const SECTOR_BUTTONS: CricketSector[] = [20, 19, 18, 17, 16, 15, 'B'];
const QUICK_BUTTONS: Array<'T 20' | 'T 19' | 'T 18' | 'T 17' | 'T 16' | 'T 15' | 'DBull'> = [
  'T 20',
  'T 19',
  'T 18',
  'T 17',
  'T 16',
  'T 15',
  'DBull',
];
const FRESH_LIMIT_MS = 2 * 60 * 1000;
const INACTIVITY_MS = 2 * 60 * 1000;
const INACTIVITY_CHECK_MS = 2 * 60 * 1000;

async function ensureDocFullscreen() {
  if (typeof document === 'undefined') return false;
  if (document.fullscreenElement) return true;

  try {
    await (document.documentElement.requestFullscreen?.() ?? Promise.resolve());
    return !!document.fullscreenElement;
  } catch {
    return false;
  }
}

function ensureKrikettFullscreen() {
  if (typeof document === 'undefined') return;
  if (document.fullscreenElement) return;
  void ensureDocFullscreen();
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

function createEmptyMarks(): Record<CricketSector, number> {
  return { 20: 0, 19: 0, 18: 0, 17: 0, 16: 0, 15: 0, B: 0 };
}

function freshPlayer(name: string, wins = 0): PlayerState {
  return {
    id: `${name}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    points: 0,
    marks: createEmptyMarks(),
    wins,
  };
}

function teamIndexForPlayer(playerIdx: number) {
  return playerIdx % 2 === 0 ? 0 : 1;
}

function teammateIndex(playerIdx: number) {
  return playerIdx < 2 ? playerIdx + 2 : playerIdx - 2;
}

function teamTotal(players: PlayerState[], teamIdx: number) {
  return players.reduce((sum, p, idx) => sum + (teamIndexForPlayer(idx) === teamIdx ? p.points : 0), 0);
}

function sectorValue(sector: CricketSector): number {
  return sector === 'B' ? 25 : sector;
}

function teamAllClosed(players: PlayerState[], teamIdx: number) {
  const teamPlayers = players.filter((_, idx) => teamIndexForPlayer(idx) === teamIdx);
  if (teamPlayers.length !== 2) return false;
  return SECTORS.every((sector) => teamPlayers.every((p) => p.marks[sector] >= 3));
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

function canAppendMarks(turnCounts: Record<string, number>, sector: CricketSector, marksToAdd: number) {
  const nextCounts = { ...turnCounts, [String(sector)]: (turnCounts[String(sector)] || 0) + marksToAdd };
  if (sumTurnCounts(nextCounts) > 9) return false;
  const tokens = buildDartTokens(nextCounts);
  return tokens.length <= 3;
}

function applyTeamPenaltyTurn(players: PlayerState[], playerIdx: number, turnCounts: Record<string, number>) {
  const next = clonePlayers(players);
  const player = next[playerIdx];
  const mate = next[teammateIndex(playerIdx)];
  const shooterTeam = teamIndexForPlayer(playerIdx);

  for (const sector of SECTORS) {
    const key = String(sector);
    const hits = turnCounts[key] || 0;
    if (!hits) continue;

    const currentMarks = player.marks[sector];
    const toClose = Math.max(0, Math.min(3 - currentMarks, hits));
    const extras = Math.max(0, hits - toClose);
    player.marks[sector] = Math.min(3, currentMarks + hits);

    if (!extras) continue;

    const teamClosed = player.marks[sector] >= 3 && mate.marks[sector] >= 3;
    if (!teamClosed) continue;

    const value = sectorValue(sector);

    next.forEach((opp, idx) => {
      if (teamIndexForPlayer(idx) !== shooterTeam && opp.marks[sector] < 3) {
        opp.points += extras * value;
      }
    });
  }

  return next;
}

function canWinTeam(players: PlayerState[], playerIdx: number) {
  const teamIdx = teamIndexForPlayer(playerIdx);
  if (!teamAllClosed(players, teamIdx)) return false;

  const ownTotal = teamTotal(players, teamIdx);
  const oppTotal = teamTotal(players, teamIdx === 0 ? 1 : 0);
  return ownTotal < oppTotal;
}

function buildTeamCricketValueString(players: PlayerState[], round: number, deviceInfo: string) {
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

function CricketMarkBox(props: { label: string; marks: number; short?: boolean }) {
  const marks = Math.max(0, Math.min(3, Number(props.marks) || 0));
  const vertical = !!props.short;

  return (
    <View style={[styles.cricketMarkChip, props.short ? styles.cricketMarkChipShort : null]}>
      <View style={styles.cricketMarkChipBg}>
        <View
          style={[
            styles.cricketMarkThirdBase,
            vertical ? styles.cricketMarkThirdBaseVertical : null,
            vertical ? styles.cricketMarkThird1Vertical : styles.cricketMarkThird1,
            styles.cricketMarkThirdBaseLight,
          ]}
        />
        <View
          style={[
            styles.cricketMarkThirdBase,
            vertical ? styles.cricketMarkThirdBaseVertical : null,
            vertical ? styles.cricketMarkThird2Vertical : styles.cricketMarkThird2,
            styles.cricketMarkThirdBaseMid,
          ]}
        />
        <View
          style={[
            styles.cricketMarkThirdBase,
            vertical ? styles.cricketMarkThirdBaseVertical : null,
            vertical ? styles.cricketMarkThird3Vertical : styles.cricketMarkThird3,
            styles.cricketMarkThirdBaseDark,
          ]}
        />

        {marks >= 1 ? (
          <View
            style={[
              vertical ? styles.cricketMarkThirdFillVertical : styles.cricketMarkThirdFill,
              vertical ? styles.cricketMarkThird1Vertical : styles.cricketMarkThird1,
            ]}
          />
        ) : null}

        {marks >= 2 ? (
          <View
            style={[
              vertical ? styles.cricketMarkThirdFillVerticalMid : styles.cricketMarkThirdFillMid,
              vertical ? styles.cricketMarkThird2Vertical : styles.cricketMarkThird2,
            ]}
          />
        ) : null}

        {marks >= 3 ? (
          <View
            style={[
              vertical ? styles.cricketMarkThirdFillVertical : styles.cricketMarkThirdFill,
              vertical ? styles.cricketMarkThird3Vertical : styles.cricketMarkThird3,
            ]}
          />
        ) : null}
      </View>

      <Text style={vertical ? styles.cricketMarkChipLabelVertical : styles.cricketMarkChipLabel} numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  );
}

export default function KrikettTeamsScreen({
  onExit,
  clubId,
  initialBoardNr,
  onOpenScoring,
  onOpenDisplay,
  onOpenDisplayById,
  openNewGameRequestKey,
  replayRequestKey,
}: Props) {
  useDisplayWakeLock(true);

  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isPortrait = height >= width;

  const [playerNameHistory, setPlayerNameHistory] = useState<string[]>(() => loadPlayerNameHistory());
  const [players, setPlayers] = useState<PlayerState[]>(() => [
    freshPlayer('PL.1 - A Team'),
    freshPlayer('PL.1 - B Team'),
    freshPlayer('PL.2 - A Team'),
    freshPlayer('PL.2 - B Team'),
  ]);
  const [active, setActive] = useState(0);
  const [round, setRound] = useState(1);
  const [gameStarter, setGameStarter] = useState(0);
  const [boardNr, setBoardNr] = useState<number | null>(() => initialBoardNr ?? null);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [showBroadcastDialog, setShowBroadcastDialog] = useState(false);
  const [showScanDialog, setShowScanDialog] = useState(false);
  const [scanInput, setScanInput] = useState('');
  const [qrActivated, setQrActivated] = useState(false);
  const [locationCoords, setLocationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locationGranted, setLocationGranted] = useState(false);
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [showBoardDialog, setShowBoardDialog] = useState(false);
  const [showWinnerDialog, setShowWinnerDialog] = useState(false);
  const [winnerText, setWinnerText] = useState('');
  const [winnerRound, setWinnerRound] = useState<number | null>(null);
  const [pendingWinnerTeam, setPendingWinnerTeam] = useState<number | null>(null);
  const [pendingTurn, setPendingTurn] = useState<Record<string, number>>({});
  const [showInactiveDialog, setShowInactiveDialog] = useState(false);
  const [draft, setDraft] = useState<SetupDraft>({
    humanNames: ['PL.1 - A Team', 'PL.1 - B Team', 'PL.2 - A Team', 'PL.2 - B Team'],
  });
  const [showLocationPermissionDialog, setShowLocationPermissionDialog] = useState(false);
  const [showScannerScreen, setShowScannerScreen] = useState(false);
  const [hasScannedQr, setHasScannedQr] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [nameTouched, setNameTouched] = useState<boolean[]>([false, false, false, false]);
  const [menuBoardTmp, setMenuBoardTmp] = useState<number | null>(initialBoardNr ?? null);
  const [warnedBusyBoard, setWarnedBusyBoard] = useState<number | null>(null);
  const [boardTailMap, setBoardTailMap] = useState<Record<number, { deviceInfo: string | null; ts: number }>>({
    1: { deviceInfo: null, ts: 0 }, 2: { deviceInfo: null, ts: 0 }, 3: { deviceInfo: null, ts: 0 }, 4: { deviceInfo: null, ts: 0 },
    5: { deviceInfo: null, ts: 0 }, 6: { deviceInfo: null, ts: 0 }, 7: { deviceInfo: null, ts: 0 }, 8: { deviceInfo: null, ts: 0 },
  });

  const playersRef = useRef(players);
  const undoStack = useRef<GameSnapshot[]>([]);
  const deviceInfoRef = useRef<string>(getOrCreateDeviceId());
  const lastLocalSendRef = useRef<number>(0);
  const handledOpenNewGameKeyRef = useRef<number | null>(null);
  const handledReplayKeyRef = useRef<number | null>(null);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  const turnLabel = useMemo(() => buildTurnLabel(pendingTurn), [pendingTurn]);
  const teamATotal = useMemo(() => teamTotal(players, 0), [players]);
  const teamBTotal = useMemo(() => teamTotal(players, 1), [players]);

  const markLocalFirebaseSend = () => {
    lastLocalSendRef.current = Date.now();
  };

  const saveNameHistoryFrom = useCallback((names: string[]) => {
    const nextHistory = Array.from(
      new Set([...names.filter((v) => v && !/^PL\./i.test(v)), ...playerNameHistory])
    ).slice(0, 20);
    setPlayerNameHistory(nextHistory);
    savePlayerNameHistory(nextHistory);
  }, [playerNameHistory]);

  const resetBoardConnectionState = () => {
    setBoardNr(null);
    setMenuBoardTmp(null);
    setShowBoardDialog(false);
    setWarnedBusyBoard(null);
    setShowInactiveDialog(true);
  };

  const openBoardFromScannedText = useCallback((raw: string) => {
    const parsed = parseBoardIdFromText(raw);
    if (!parsed) return false;

    addWatchedId(parsed);
    setShowScannerScreen(false);
    setShowScanDialog(false);
    setShowBroadcastDialog(false);
    setScanInput('');
    setHasScannedQr(false);
    onOpenDisplayById?.(parsed);
    return true;
  }, [onOpenDisplayById]);

  const requestAppLocation = useCallback(async () => {
    try {
      if (Platform.OS === 'web') {
        const coords = await requestBrowserLikeLocation();
        if (coords) {
          setLocationCoords(coords);
          setLocationGranted(true);
          return true;
        }
        setLocationCoords(null);
        setLocationGranted(false);
        return false;
      }

      const current = await Location.getForegroundPermissionsAsync();
      let granted = current.status === 'granted';

      if (!granted) {
        const asked = await Location.requestForegroundPermissionsAsync();
        granted = asked.status === 'granted';
      }

      if (!granted) {
        setLocationCoords(null);
        setLocationGranted(false);
        return false;
      }

      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown?.coords) {
        setLocationCoords({
          lat: lastKnown.coords.latitude,
          lng: lastKnown.coords.longitude,
        });
        setLocationGranted(true);
        return true;
      }

      const currentPos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      setLocationCoords({
        lat: currentPos.coords.latitude,
        lng: currentPos.coords.longitude,
      });
      setLocationGranted(true);
      return true;
    } catch {
      setLocationCoords(null);
      setLocationGranted(false);
      return false;
    }
  }, []);

  const pushToFirebase = useCallback(async () => {
    if (!boardId) return;

    try {
      await publishBoardRecord({
        boardId,
        kind: 'cricket',
        stats: buildTeamCricketValueString(players, round, deviceInfoRef.current),
        deviceId: deviceInfoRef.current,
        lat: locationGranted ? locationCoords?.lat ?? null : null,
        lng: locationGranted ? locationCoords?.lng ?? null : null,
      });
    } catch {}
  }, [boardId, players, round, locationGranted, locationCoords]);

  useEffect(() => {
    void pushToFirebase();
  }, [players, active, round, boardId, locationGranted, locationCoords, pushToFirebase]);

  useEffect(() => {
    void getOrCreateBoardId(deviceInfoRef.current).then(setBoardId);

    if (Platform.OS === 'web') {
      void requestAppLocation();
      return;
    }

    void Location.getForegroundPermissionsAsync()
      .then(async (perm) => {
        if (perm.status !== 'granted') {
          setLocationCoords(null);
          setLocationGranted(false);
          return;
        }
        await requestAppLocation();
      })
      .catch(() => {
        setLocationCoords(null);
        setLocationGranted(false);
      });
  }, [requestAppLocation]);

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

  const restartAfterWin = (winnerTeamIdx: number) => {
    const nextStarter = (gameStarter + 1) % players.length;
    const nextPlayers = players.map((p, idx) =>
      freshPlayer(p.name, p.wins + (teamIndexForPlayer(idx) === winnerTeamIdx ? 1 : 0))
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
    setPendingWinnerTeam(null);
  };

  const finishTurn = (nextPlayers: PlayerState[], playerIdx: number) => {
    setPlayers(nextPlayers);
    setPendingTurn({});

    if (canWinTeam(nextPlayers, playerIdx)) {
      const winningTeam = teamIndexForPlayer(playerIdx);
      setWinnerText(`${winningTeam === 0 ? 'A Team' : 'B Team'} wins!`);
      setWinnerRound(round);
      setPendingWinnerTeam(winningTeam);
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
    if (showWinnerDialog) return;
    appendMarks(sector, 1);
  };

  const onQuickTap = (btn: (typeof QUICK_BUTTONS)[number]) => {
    ensureKrikettFullscreen();
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
    pushUndo();

    if (!Object.keys(pendingTurn).length) {
      advanceTurn();
      return;
    }

    const nextPlayers = applyTeamPenaltyTurn(players, active, pendingTurn);
    finishTurn(nextPlayers, active);
  };

  const onUndo = () => {
    ensureKrikettFullscreen();

    const prev = undoStack.current.pop();
    if (!prev) return;

    const restoredPlayers = clonePlayers(prev.players);

    setPlayers(restoredPlayers);
    setActive(prev.active);
    setBoardNr(prev.boardNr);
    setRound(prev.round);
    setGameStarter(prev.gameStarter);
    setPendingTurn({});
    setShowWinnerDialog(false);
    setWinnerText('');
    setWinnerRound(null);
    setPendingWinnerTeam(null);

    void pushToFirebase();
  };

  const onSectorTapRef = useRef(onSectorTap);
  const onEnterRef = useRef(onEnter);
  const onClearRef = useRef(onClear);
  const onUndoRef = useRef(onUndo);

  useEffect(() => {
    onSectorTapRef.current = onSectorTap;
    onEnterRef.current = onEnter;
    onClearRef.current = onClear;
    onUndoRef.current = onUndo;
  }, [onSectorTap, onEnter, onClear, onUndo]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleKeyDown = (e: any) => {
      const key = String(e?.key || '');

      if (
        showWinnerDialog ||
        showSetupDialog ||
        showBoardDialog ||
        showBroadcastDialog ||
        showScanDialog ||
        showLocationPermissionDialog ||
        showScannerScreen ||
        showInactiveDialog
      ) {
        return;
      }

      if (key === 'Enter') {
        e.preventDefault?.();
        onEnterRef.current();
        return;
      }

      if (key === 'Delete') {
        e.preventDefault?.();
        onClearRef.current();
        return;
      }

      if (key === 'Backspace') {
        e.preventDefault?.();
        onUndoRef.current();
        return;
      }

      if (key === 'b' || key === 'B') {
        e.preventDefault?.();
        onSectorTapRef.current('B');
        return;
      }

      switch (key) {
        case '5':
          e.preventDefault?.();
          onSectorTapRef.current(15);
          break;
        case '6':
          e.preventDefault?.();
          onSectorTapRef.current(16);
          break;
        case '7':
          e.preventDefault?.();
          onSectorTapRef.current(17);
          break;
        case '8':
          e.preventDefault?.();
          onSectorTapRef.current(18);
          break;
        case '9':
          e.preventDefault?.();
          onSectorTapRef.current(19);
          break;
        case '2':
          e.preventDefault?.();
          onSectorTapRef.current(20);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    showWinnerDialog,
    showSetupDialog,
    showBoardDialog,
    showBroadcastDialog,
    showScanDialog,
    showLocationPermissionDialog,
    showScannerScreen,
    showInactiveDialog,
  ]);

  const buildDraftFromCurrent = (): SetupDraft => ({
    humanNames: [
      players[0]?.name || 'PL.1 - A Team',
      players[1]?.name || 'PL.1 - B Team',
      players[2]?.name || 'PL.2 - A Team',
      players[3]?.name || 'PL.2 - B Team',
    ],
  });

  const replayCurrentMatch = () => {
    const replayDraft = buildDraftFromCurrent();
    setDraft(replayDraft);
    setShowSetupDialog(false);
    setWarnedBusyBoard(null);
    setMenuBoardTmp(null);
    startGameFromSetup(boardNr != null, boardNr, replayDraft);
  };

  useEffect(() => {
    if (openNewGameRequestKey == null) return;
    if (handledOpenNewGameKeyRef.current === openNewGameRequestKey) return;
    handledOpenNewGameKeyRef.current = openNewGameRequestKey;
    openMenu();
  }, [openNewGameRequestKey]);

  useEffect(() => {
    if (replayRequestKey == null) return;
    if (handledReplayKeyRef.current === replayRequestKey) return;
    handledReplayKeyRef.current = replayRequestKey;
    replayCurrentMatch();
  }, [replayRequestKey]);

  const openMenu = () => {
    ensureKrikettFullscreen();
    setDraft(buildDraftFromCurrent());
    setNameTouched([false, false, false, false]);
    setMenuBoardTmp(null);
    setWarnedBusyBoard(null);
    setShowSetupDialog(true);
  };

  const startGameFromSetup = (withBoard: boolean, forcedBoard?: number | null, draftOverride?: SetupDraft) => {
    const sourceDraft = draftOverride ?? draft;
    const selectedBoard = withBoard ? (forcedBoard ?? menuBoardTmp) : null;

    const fallbacks = ['PL.1 - A Team', 'PL.1 - B Team', 'PL.2 - A Team', 'PL.2 - B Team'];
    const nextNames = sourceDraft.humanNames.map((name, idx) => (name || fallbacks[idx]).trim() || fallbacks[idx]);

    saveNameHistoryFrom(nextNames);

    const nextPlayers: PlayerState[] = nextNames.map((name) => freshPlayer(name));
    playersRef.current = nextPlayers;
    setPlayers(nextPlayers);
    setActive(0);
    setGameStarter(0);
    setRound(1);
    setPendingTurn({});
    undoStack.current = [];
    setBoardNr(selectedBoard);
    setMenuBoardTmp(selectedBoard);
    setShowSetupDialog(false);
    setWarnedBusyBoard(null);
    setShowWinnerDialog(false);
    setWinnerText('');
    setWinnerRound(null);
    setPendingWinnerTeam(null);
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
    return (
      <View pointerEvents="none">
        <View style={styles.broadcastCircle}>
          <Image source={src} style={styles.broadcastIconInside} />
        </View>
      </View>
    );
  };

  const rowBgForIndex = (idx: number) => (idx === 0 || idx === 2 ? styles.playerRowTeamA : styles.playerRowTeamB);

  const landscapeTable = (
    <View style={styles.tableWrap}>
      <View style={styles.tableHeaderRow}>
        <View style={[styles.playerCell, styles.playerCellHeader]}>
          <Text style={styles.tableHeaderText}>Player</Text>
        </View>
        <View style={styles.pointsCell}>
          <Text style={styles.tableHeaderText}>Pts</Text>
        </View>
        <View style={styles.teamTotalCell}>
          <Text style={styles.tableHeaderText}>Team</Text>
        </View>
        {SECTORS.map((sector) => (
          <View key={`h-${sector}`} style={styles.markCell}>
            <Text style={styles.tableHeaderText}>{sector === 'B' ? 'B' : String(sector)}</Text>
          </View>
        ))}
      </View>

      {players.map((player, idx) => (
        <View key={player.id} style={[styles.playerRow, rowBgForIndex(idx), idx === active ? styles.playerRowActive : null]}>
          <View style={styles.playerCell}>
            <Text style={styles.playerName} numberOfLines={1}>{player.name}</Text>
            {idx === active ? <View style={styles.activeDotOn} /> : <View style={styles.activeDotOff} />}
          </View>

          <View style={styles.pointsCell}>
            <Text style={styles.pointsText}>{player.points}</Text>
          </View>

          <View style={styles.teamTotalCell}>
            <Text style={styles.teamTotalText}>{teamIndexForPlayer(idx) === 0 ? teamATotal : teamBTotal}</Text>
          </View>

          {SECTORS.map((sector) => (
            <View key={`${player.id}-${sector}`} style={styles.markCell}>
              <CricketMarkBox label={sector === 'B' ? 'B' : String(sector)} marks={player.marks[sector]} short />
            </View>
          ))}
        </View>
      ))}
    </View>
  );

  const portraitTable = (
    <View style={styles.tableWrap}>
      <View style={styles.tableHeaderRowPortrait}>
        <View style={[styles.playerCellPortrait, styles.playerCellHeader]}>
          <Text style={styles.tableHeaderText}>Player</Text>
        </View>
        <View style={styles.pointsCellPortrait}>
          <Text style={styles.tableHeaderText}>Pts</Text>
        </View>
        {SECTORS.map((sector) => (
          <View key={`h-${sector}`} style={styles.markCell}>
            <Text style={styles.tableHeaderText}>{sector === 'B' ? 'B' : String(sector)}</Text>
          </View>
        ))}
      </View>

      {players.map((player, idx) => (
        <View key={player.id} style={[styles.playerRowPortrait, rowBgForIndex(idx), idx === active ? styles.playerRowActive : null]}>
          <View style={styles.playerCellPortrait}>
            <Text style={styles.playerNamePortrait} numberOfLines={1}>{player.name}</Text>
          </View>

          <View style={styles.pointsCellPortrait}>
            <Text style={styles.pointsTextPortrait}>{player.points}</Text>
          </View>

          {SECTORS.map((sector) => (
            <View key={`${player.id}-${sector}`} style={styles.markCell}>
              <CricketMarkBox label={sector === 'B' ? 'B' : String(sector)} marks={player.marks[sector]} short />
            </View>
          ))}
        </View>
      ))}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <Pressable onPress={onExit} hitSlop={10}>
            <Text style={styles.topBarAction}>‹ Back</Text>
          </Pressable>

          <Text style={styles.topBarTitle}>Team Cricket</Text>

          <Pressable onPress={openMenu} hitSlop={10}>
            <Text style={styles.topBarAction}>New</Text>
          </Pressable>
        </View>

        <View style={styles.roundWrap}>
          <Text style={styles.roundText}>Round {round}</Text>
        </View>

        <ScrollView contentContainerStyle={[styles.scrollContent, isPortrait ? null : { paddingLeft: insets.left, paddingRight: insets.right }]} keyboardShouldPersistTaps="handled">
          {isPortrait ? portraitTable : landscapeTable}

          {isPortrait ? (
            <View style={styles.teamTotalsPortraitWrap}>
              <Text style={styles.teamTotalsPortraitText}>{teamATotal} - {teamBTotal}</Text>
            </View>
          ) : null}

          <View style={styles.inputRow}>
            <TextInput
              value={turnLabel}
              editable={false}
              showSoftInputOnFocus={false}
              style={styles.turnInput}
              placeholder="Turn"
              placeholderTextColor="rgba(0,0,0,0.35)"
            />
            <Pressable
              onPress={() => {
                if (boardId) {
                  setQrActivated(true);
                  setShowBroadcastDialog(true);
                  void pushToFirebase();
                }
              }}
              hitSlop={10}
              style={styles.broadcastBtn}
            >
              {renderBroadcastIcon()}
            </Pressable>
          </View>

          <View style={styles.keyboardWrap}>
            <View style={styles.sectorGrid}>
              {SECTOR_BUTTONS.map((btn) => (
                <Pressable
                  key={String(btn)}
                  onPress={() => onSectorTap(btn)}
                  style={({ pressed }) => [styles.keyBtn, pressed ? styles.keyBtnPressed : null]}
                >
                  <Text style={styles.keyBtnText}>{btn === 'B' ? 'Bull' : String(btn)}</Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.quickGrid}>
              {QUICK_BUTTONS.map((btn) => (
                <Pressable
                  key={btn}
                  onPress={() => onQuickTap(btn)}
                  style={({ pressed }) => [styles.keyBtn, styles.keyBtnQuick, pressed ? styles.keyBtnPressed : null]}
                >
                  <Text style={styles.keyBtnText}>{btn}</Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.actionRow}>
              <Pressable
                onPress={onClear}
                style={({ pressed }) => [styles.keyBtn, styles.keyBtnAction, pressed ? styles.keyBtnPressed : null]}
              >
                <Text style={[styles.keyBtnText, styles.keyBtnTextAction]}>CLEAR</Text>
              </Pressable>

              <Pressable
                onPress={onUndo}
                style={({ pressed }) => [styles.keyBtn, styles.keyBtnAction, pressed ? styles.keyBtnPressed : null]}
              >
                <Text style={[styles.keyBtnText, styles.keyBtnTextAction]}>UNDO</Text>
              </Pressable>

              <Pressable
                onPress={onEnter}
                style={({ pressed }) => [styles.keyBtn, styles.keyBtnOk, pressed ? styles.keyBtnPressed : null]}
              >
                <Text style={[styles.keyBtnText, styles.keyBtnTextOk]}>ENTER</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </View>

      <Modal visible={showSetupDialog} transparent animationType="fade" onRequestClose={() => setShowSetupDialog(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowSetupDialog(false)} />
          <View style={styles.modalCardWide}>
            <Text style={styles.modalTitle}>New Team Cricket</Text>

            {draft.humanNames.map((name, idx) => {
              const placeholders = ['Pl.1 - A Team', 'Pl.1 - B Team', 'Pl.2 - A Team', 'Pl.2 - B Team'];

              return (
                <View key={`human-${idx}`} style={[styles.setupFieldWrap, idx > 0 ? { marginTop: 10 } : null]}>
                  <TextInput
                    value={name}
                    onChangeText={(v) => {
                      setDraft((prev) => {
                        const next = [...prev.humanNames] as SetupDraft['humanNames'];
                        next[idx] = v;
                        return { ...prev, humanNames: next };
                      });
                    }}
                    style={styles.modalInput}
                    placeholder={placeholders[idx]}
                    placeholderTextColor="rgba(0,0,0,0.45)"
                    onFocus={() => {
                      if (!nameTouched[idx]) {
                        setDraft((prev) => {
                          const next = [...prev.humanNames] as SetupDraft['humanNames'];
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
              );
            })}

            <View style={styles.modalBtns}>
              <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShowBoardDialog(true)}>
                <Text style={styles.modalBtnTextGhost}>Connect board</Text>
              </Pressable>
              <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={() => startGameFromSetup(false)}>
                <Text style={styles.modalBtnTextOk}>Start Team Cricket</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showBoardDialog} transparent animationType="fade" onRequestClose={() => setShowBoardDialog(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowBoardDialog(false)} />
          <View style={styles.modalCardWide}>
            <Text style={styles.modalTitle}>Connect board</Text>
            <Text style={styles.modalLabel}>Pick a board number for Team Cricket.</Text>

            <View style={styles.boardGrid}>
              {BOARD_NRS.map((n) => {
                const dimmed = shouldDimBoardCircle(n);
                return (
                  <Pressable
                    key={n}
                    style={[
                      styles.boardCircle,
                      dimmed ? styles.boardCircleDim : null,
                      menuBoardTmp === n ? styles.boardCircleSelected : null,
                    ]}
                    onPress={() => handleBoardPickInSetup(n)}
                  >
                    <Text style={styles.boardCircleText}>{n}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.modalBtns}>
              <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShowBoardDialog(false)}>
                <Text style={styles.modalBtnTextGhost}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showBroadcastDialog} transparent animationType="fade" onRequestClose={() => setShowBroadcastDialog(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowBroadcastDialog(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Pressable
              style={styles.modalCloseBtn}
              onPress={() => setShowBroadcastDialog(false)}
              hitSlop={10}
            >
              <Text style={styles.modalCloseBtnText}>×</Text>
            </Pressable>

            <Text style={styles.modalLabel}>
              Scan this with another device for display.
            </Text>

            {boardId ? (
              <Image
                source={{ uri: buildQrImageUrl(buildBoardShareUrl(boardId)) }}
                style={styles.qrPreviewLarge}
              />
            ) : null}

            <Text selectable style={styles.modalHintSmall}>
              {boardId ? buildBoardShareUrl(boardId) : 'Generating...'}
            </Text>

            <Text style={styles.orLabel}>OR</Text>

            <View style={styles.modalBtnsSingleCenter}>
              <Pressable
                style={styles.scanScoreboardBtn}
                onPress={async () => {
                  const granted = cameraPermission?.granted || (await requestCameraPermission())?.granted;
                  if (!granted) return;
                  setShowBroadcastDialog(false);
                  setShowScannerScreen(true);
                  setHasScannedQr(false);
                }}
              >
                <MaterialIcons name="qr-code-scanner" size={22} color="rgba(0,0,0,0.78)" />
                <Text style={styles.scanScoreboardBtnText}>Scan another device&apos;s scoreboard</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showLocationPermissionDialog} transparent animationType="fade" onRequestClose={() => setShowLocationPermissionDialog(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Location access</Text>
            <Text style={styles.modalLabel}>
              Allow location access if you want to appear on the big screen when using it inside the club.
            </Text>

            <View style={styles.modalBtns}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setShowLocationPermissionDialog(false)}
              >
                <Text style={styles.modalBtnTextGhost}>Not now</Text>
              </Pressable>

              <Pressable
                style={[styles.modalBtn, styles.modalBtnOk]}
                onPress={async () => {
                  const ok = await requestAppLocation();
                  setShowLocationPermissionDialog(false);
                  if (ok) {
                    setQrActivated(true);
                    setShowBroadcastDialog(true);
                  }
                }}
              >
                <Text style={styles.modalBtnTextOk}>Continue</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showScanDialog} transparent animationType="fade" onRequestClose={() => setShowScanDialog(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowScanDialog(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Open board display</Text>
            <Text style={styles.modalLabel}>
              Paste a QR URL or board ID manually.
            </Text>

            <TextInput
              value={scanInput}
              onChangeText={setScanInput}
              style={styles.modalInput}
              placeholder="Paste QR url or board id"
              placeholderTextColor="rgba(0,0,0,0.45)"
              autoCapitalize="characters"
              autoCorrect={false}
            />

            <View style={styles.modalBtnsSingle}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnOk]}
                onPress={() => {
                  openBoardFromScannedText(scanInput);
                }}
              >
                <Text style={styles.modalBtnTextOk}>Open manually</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={showScannerScreen}
        animationType="slide"
        onRequestClose={() => {
          setShowScannerScreen(false);
          setHasScannedQr(false);
        }}
      >
        <View style={styles.scannerScreen}>
          {cameraPermission?.granted ? (
            <CameraView
              style={styles.scannerCamera}
              barcodeScannerSettings={{
                barcodeTypes: ['qr'],
              }}
              onBarcodeScanned={
                hasScannedQr
                  ? undefined
                  : ({ data }) => {
                      setHasScannedQr(true);
                      const ok = openBoardFromScannedText(String(data || ''));
                      if (!ok) {
                        setShowScannerScreen(false);
                        setShowScanDialog(true);
                        setScanInput(String(data || ''));
                        setHasScannedQr(false);
                      }
                    }
              }
            />
          ) : (
            <View style={styles.scannerFallback}>
              <Text style={styles.modalTitle}>Camera permission needed</Text>
              <Text style={styles.modalLabel}>
                Please allow camera access to scan a QR code.
              </Text>
              <View style={styles.modalBtnsSingle}>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnOk]}
                  onPress={async () => {
                    await requestCameraPermission();
                  }}
                >
                  <Text style={styles.modalBtnTextOk}>Allow camera</Text>
                </Pressable>
              </View>
            </View>
          )}

          <View style={styles.scannerHud}>
            <Text style={styles.scannerTitle}>Scan another device</Text>
            <Text style={styles.scannerHint}>
              Point the camera at the QR code shown on the other device.
            </Text>

            <View style={styles.scannerFrame} />

            <View style={styles.scannerBottomActions}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnGhost, styles.scannerBottomBtn]}
                onPress={() => {
                  setShowScannerScreen(false);
                  setHasScannedQr(false);
                  setShowScanDialog(true);
                }}
              >
                <Text style={styles.modalBtnTextGhost}>Enter manually</Text>
              </Pressable>

              <Pressable
                style={[styles.modalBtn, styles.modalBtnOk, styles.scannerBottomBtn]}
                onPress={() => {
                  setShowScannerScreen(false);
                  setHasScannedQr(false);
                }}
              >
                <Text style={styles.modalBtnTextOk}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showWinnerDialog} transparent animationType="fade" onRequestClose={() => setShowWinnerDialog(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Winner</Text>
            <Text style={styles.modalLabel}>{winnerText}</Text>
            <Text style={styles.modalLabel}>{winnerRound != null ? `Round ${winnerRound}` : ''}</Text>

            <View style={styles.modalBtns}>
              <Pressable
                style={[styles.modalBtnStandalone, styles.modalBtnGhost]}
                onPress={onUndo}
              >
                <Text style={styles.modalBtnTextGhostStrong}>UNDO</Text>
              </Pressable>

              <Pressable
                style={[styles.modalBtnStandalone, styles.modalBtnOkStrong]}
                onPress={() => {
                  if (pendingWinnerTeam != null) {
                    restartAfterWin(pendingWinnerTeam);
                  } else {
                    setShowWinnerDialog(false);
                  }
                }}
              >
                <Text style={styles.modalBtnTextOkStrong}>OK</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showInactiveDialog} transparent animationType="fade" onRequestClose={() => setShowInactiveDialog(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Disconnected</Text>
            <Text style={styles.modalLabel}>You were disconnected from the board due to inactivity. If you still want to use it, please connect again.</Text>
            <Pressable style={[styles.modalBtn, styles.modalBtnOk, { marginTop: 12 }]} onPress={() => setShowInactiveDialog(false)}>
              <Text style={styles.modalBtnTextOk}>OK</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#ffffff' },
  screen: { flex: 1, backgroundColor: '#ffffff' },
  scrollContent: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 24 },
  topBar: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topBarAction: { fontSize: 16, fontWeight: '700', color: 'rgba(0,0,0,0.72)' },
  topBarTitle: { fontSize: 20, fontWeight: '800', color: 'rgba(0,0,0,0.88)' },
  roundWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 6,
  },
  roundText: { fontSize: 16, fontWeight: '800', color: '#2f6f18' },

  tableWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    backgroundColor: '#fff',
  },
  tableHeaderRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: 'rgba(0,0,0,0.08)',
    minHeight: 42,
  },
  tableHeaderRowPortrait: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: 'rgba(0,0,0,0.08)',
    minHeight: 42,
  },
  tableHeaderText: {
    fontSize: 13,
    fontWeight: '800',
    color: 'rgba(0,0,0,0.72)',
    textAlign: 'center',
  },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 62,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.06)',
  },
  playerRowPortrait: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 56,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.06)',
  },
  playerRowTeamA: { backgroundColor: 'rgba(61,255,47,0.06)' },
  playerRowTeamB: { backgroundColor: 'rgba(0,0,0,0.025)' },
  playerRowActive: { borderLeftWidth: 4, borderLeftColor: '#2f6f18' },

  playerCell: {
    width: 180,
    minWidth: 180,
    maxWidth: 180,
    paddingHorizontal: 8,
    alignItems: 'flex-start',
    justifyContent: 'center',
    flexDirection: 'row',
    columnGap: 6,
  },
  playerCellHeader: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerCellPortrait: {
    width: 112,
    minWidth: 112,
    maxWidth: 112,
    paddingHorizontal: 8,
    justifyContent: 'center',
  },
  playerName: { fontSize: 16, fontWeight: '800', color: 'rgba(0,0,0,0.84)' },
  playerNamePortrait: { fontSize: 13, fontWeight: '800', color: 'rgba(0,0,0,0.84)' },

  pointsCell: {
    width: 64,
    minWidth: 64,
    maxWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pointsCellPortrait: {
    width: 48,
    minWidth: 48,
    maxWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamTotalCell: {
    width: 68,
    minWidth: 68,
    maxWidth: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pointsText: { fontSize: 20, fontWeight: '900', color: '#b38f00' },
  pointsTextPortrait: { fontSize: 17, fontWeight: '900', color: '#b38f00' },
  teamTotalText: { fontSize: 18, fontWeight: '900', color: '#2f6f18' },

  markCell: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 1,
    paddingVertical: 2,
  },

  teamTotalsPortraitWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  teamTotalsPortraitText: {
    fontSize: 24,
    fontWeight: '900',
    color: '#2f6f18',
  },

  inputRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 10,
  },
  turnInput: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.1)',
    backgroundColor: 'rgba(0,0,0,0.035)',
    color: 'rgba(0,0,0,0.8)',
    paddingHorizontal: 14,
    fontSize: 18,
    fontWeight: '700',
  },
  broadcastBtn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  broadcastCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#d3d3d3',
    backgroundColor: '#ffffff',
  },
  broadcastIconInside: {
    width: 24,
    height: 24,
    resizeMode: 'contain',
    tintColor: 'rgba(0,0,0,0.70)',
  },

  keyboardWrap: {
    marginTop: 12,
    rowGap: 8,
  },
  sectorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  keyBtn: {
    minWidth: 72,
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: '#f2f2f2',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  keyBtnQuick: { backgroundColor: 'rgba(179,143,0,0.12)' },
  keyBtnAction: { backgroundColor: 'rgba(0,0,0,0.08)' },
  keyBtnOk: { backgroundColor: '#2f6f18' },
  keyBtnPressed: { opacity: 0.72 },
  keyBtnText: { fontSize: 16, fontWeight: '800', color: 'rgba(0,0,0,0.82)' },
  keyBtnTextAction: { color: 'rgba(0,0,0,0.82)' },
  keyBtnTextOk: { color: '#ffffff' },

  activeDotOn: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#2f6f18',
    marginTop: 4,
  },
  activeDotOff: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(0,0,0,0.15)',
    marginTop: 4,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 16,
    backgroundColor: '#fff',
    padding: 16,
  },
  modalCardWide: {
    width: '100%',
    maxWidth: 520,
    borderRadius: 16,
    backgroundColor: '#fff',
    padding: 16,
  },
  modalTitle: { fontSize: 20, fontWeight: '800', color: 'rgba(0,0,0,0.85)' },
  modalLabel: { marginTop: 8, fontSize: 15, color: 'rgba(0,0,0,0.72)' },
  modalInput: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    backgroundColor: 'rgba(0,0,0,0.03)',
    paddingHorizontal: 12,
    color: 'rgba(0,0,0,0.82)',
    fontSize: 15,
  },
  setupFieldWrap: {},
  modalBtns: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  modalBtnsSingle: {
    marginTop: 14,
  },
  modalBtnsSingleCenter: {
    marginTop: 14,
    alignItems: 'center',
  },
  modalBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnStandalone: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  modalBtnGhost: { backgroundColor: 'rgba(0,0,0,0.08)' },
  modalBtnOk: { backgroundColor: '#2f6f18' },
  modalBtnOkStrong: { backgroundColor: '#2f6f18' },
  modalBtnTextGhost: { fontWeight: '700', color: 'rgba(0,0,0,0.8)', fontSize: 15 },
  modalBtnTextGhostStrong: { fontWeight: '700', color: 'rgba(0,0,0,0.88)', fontSize: 16 },
  modalBtnTextOk: { fontWeight: '700', color: '#ffffff', fontSize: 15 },
  modalBtnTextOkStrong: { fontWeight: '700', color: '#ffffff', fontSize: 16 },

  boardGrid: {
    marginTop: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  boardCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  boardCircleDim: { opacity: 0.5 },
  boardCircleSelected: { backgroundColor: 'rgba(61,255,47,0.3)' },
  boardCircleText: { fontSize: 17, fontWeight: '800', color: 'rgba(0,0,0,0.82)' },

  modalCloseBtn: {
    position: 'absolute',
    right: 12,
    top: 8,
    zIndex: 2,
    padding: 4,
  },
  modalCloseBtnText: {
    fontSize: 26,
    lineHeight: 26,
    color: 'rgba(0,0,0,0.58)',
  },
  qrPreviewLarge: {
    width: 220,
    height: 220,
    alignSelf: 'center',
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: '#fff',
  },
  modalHintSmall: {
    marginTop: 12,
    fontSize: 13,
    color: 'rgba(0,0,0,0.55)',
    textAlign: 'center',
  },
  orLabel: {
    marginTop: 14,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '700',
    color: 'rgba(0,0,0,0.45)',
  },
  scanScoreboardBtn: {
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: '#f1f1f1',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  scanScoreboardBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: 'rgba(0,0,0,0.78)',
  },

  scannerScreen: {
    flex: 1,
    backgroundColor: '#000',
  },
  scannerCamera: {
    flex: 1,
  },
  scannerFallback: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  scannerHud: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    padding: 20,
    justifyContent: 'space-between',
  },
  scannerTitle: {
    marginTop: 36,
    textAlign: 'center',
    fontSize: 24,
    fontWeight: '800',
    color: '#fff',
  },
  scannerHint: {
    marginTop: 8,
    textAlign: 'center',
    fontSize: 15,
    color: 'rgba(255,255,255,0.82)',
  },
  scannerFrame: {
    alignSelf: 'center',
    width: 220,
    height: 220,
    borderRadius: 18,
    borderWidth: 3,
    borderColor: '#fff',
  },
  scannerBottomActions: {
    flexDirection: 'row',
    gap: 10,
  },
  scannerBottomBtn: {
    flex: 1,
  },

  cricketMarkChip: {
    minWidth: 34,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  cricketMarkChipShort: {
    minWidth: 28,
    minHeight: 46,
  },
  cricketMarkChipBg: {
    position: 'absolute',
    left: 2,
    right: 2,
    top: 2,
    bottom: 2,
    borderRadius: 8,
    overflow: 'hidden',
  },
  cricketMarkChipLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: 'rgba(0,0,0,0.72)',
  },
  cricketMarkChipLabelVertical: {
    fontSize: 12,
    fontWeight: '800',
    color: 'rgba(0,0,0,0.72)',
  },
  cricketMarkThirdBase: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '33.3333%',
  },
  cricketMarkThird1: { left: 0 },
  cricketMarkThird2: { left: '33.3333%' },
  cricketMarkThird3: { left: '66.6666%' },
  cricketMarkThirdBaseVertical: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: '33.3333%',
    width: '100%',
  },
  cricketMarkThird1Vertical: { top: 0 },
  cricketMarkThird2Vertical: { top: '33.3333%' },
  cricketMarkThird3Vertical: { top: '66.6666%' },
  cricketMarkThirdBaseLight: { backgroundColor: 'rgba(0,0,0,0.05)' },
  cricketMarkThirdBaseMid: { backgroundColor: 'rgba(0,0,0,0.10)' },
  cricketMarkThirdBaseDark: { backgroundColor: 'rgba(0,0,0,0.15)' },
  cricketMarkThirdFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(61,255,47,0.34)',
  },
  cricketMarkThirdFillMid: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(179,143,0,0.34)',
  },
  cricketMarkThirdFillVertical: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: 'rgba(61,255,47,0.34)',
  },
  cricketMarkThirdFillVerticalMid: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: 'rgba(179,143,0,0.34)',
  },
});
