import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

// ✅ Firebase RTDB
import { onValue, ref, set } from "firebase/database";
import { db } from "../../lib/firebase";

type Props = {
  onExit: () => void;
  clubId: string;
  initialBoardNr?: number | null;
};

type PlayerStats = {
  name: string;

  // game score:
  score: number; // current remaining score in current leg
  legs: number; // totals for averages (game-level)

  dartsThrownTotal: number; // total darts thrown in the match
  pointsScoredTotal: number; // only VALID scored points (no bust)

  // per-leg tracking for leg avg / leg throws
  legDartsThrown: number;
  legPointsScored: number;

  // counters
  c100: number;
  c140: number;
  c180: number;

  // win stats
  wonLegs: number;
  wonLegDartsTotal: number; // sum of darts used in won legs
  bestLegDarts: number | null; // min darts for a won leg
  highOut: number; // max checkout (last scored amount on a winning leg)
};

const START_SCORE = 501;
const MAX_CHECKOUT = 170;

// “bogey” (nem kiszállható) maradékok
const BOGEY_OUTS = new Set([169, 168, 166, 165, 163, 162, 159]);

function isCheckoutPossible(remaining: number) {
  return remaining > 0 && remaining <= MAX_CHECKOUT && !BOGEY_OUTS.has(remaining);
}

function getCheckoutDartOptions(remaining: number): Array<1 | 2 | 3> {
  // 99+ esetén csak 3, kivéve 100/104/107/110 (+101 nálad így volt): ott 2 vagy 3
  if (remaining >= 99) {
    if ([100, 101, 104, 107, 110].includes(remaining)) return [2, 3];
    return [3];
  }
  // 99 alatt: alapból 1/2/3,
  // de 41+ esetén az 1-es ne legyen, kivéve 50.
  if (remaining >= 41 && remaining !== 50) return [2, 3];
  return [1, 2, 3];
}

// portrait requested layout
const QUICK_PORTRAIT_ROWS: Array<
  Array<{ label: string; kind?: "num" | "action" | "quick"; value?: number }>
> = [
  [{ label: "1" }, { label: "2" }, { label: "3" }],
  [{ label: "4" }, { label: "5" }, { label: "6" }],
  [{ label: "7" }, { label: "8" }, { label: "9" }],
  [{ label: "OK", kind: "action" }, { label: "0" }, { label: "DEL", kind: "action" }],
  [
    { label: "LEFT", kind: "action" },
    { label: "60", kind: "quick", value: 60 },
    { label: "UNDO", kind: "action" },
  ],
  [
    { label: "121", kind: "quick", value: 121 },
    { label: "125", kind: "quick", value: 125 },
    { label: "140", kind: "quick", value: 140 },
  ],
  [
    { label: "81", kind: "quick", value: 81 },
    { label: "85", kind: "quick", value: 85 },
    { label: "100", kind: "quick", value: 100 },
  ],
  [
    { label: "26", kind: "quick", value: 26 },
    { label: "41", kind: "quick", value: 41 },
    { label: "45", kind: "quick", value: 45 },
  ],
];

const clampToDigits = (s: string) => s.replace(/[^\d]/g, "");
const toInt = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

// ✅ Android-szerű: max 2 tizedes, de ha a 2. nulla, legyen 1 tizedes (32.0)
function format2AndroidLike(n: number) {
  const s2 = n.toFixed(2);
  if (s2.endsWith("00")) return n.toFixed(1); // 32.00 -> 32.0
  if (s2.endsWith("0")) return n.toFixed(1); // 29.70 -> 29.7
  return s2; // 29.67 -> 29.67
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

// ================== ONLINE THROWS (very basic) ==================
// Two fields in RTDB per board:
// throws/<clubId>/<boardNr>/L and /R
// Value: { v, ts, by, dUsed? }
// dUsed only for checkout confirm
type ThrowMsg = {
  v: number;
  ts: number;
  by: string;
  dUsed?: 1 | 2 | 3;
};

function makeClientId() {
  // short random id (no crypto required)
  return Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36).slice(-4);
}

// ✅ score string tail parser: NEW format -> "..._<deviceInfo>_<timestamp>"
// Backward compat: if the string is still old (no deviceInfo), deviceInfo=null and timestamp is still last.
function parseScoreTail(raw: string | null): { deviceInfo: string | null; ts: number } {
  if (!raw) return { deviceInfo: null, ts: 0 };
  const parts = raw.trim().split("_");
  if (parts.length < 2) return { deviceInfo: null, ts: 0 };

  // last is timestamp (Android reads last element), keep it last!
  const tsMaybe = Number(parts[parts.length - 1]);
  const ts = Number.isFinite(tsMaybe) ? Math.trunc(tsMaybe) : 0;

  // deviceInfo is ONLY valid in the new format (we add 1 extra field before ts)
  // Old format has 23 fields; new has 24 fields. We accept ">= 24" as new.
  const deviceInfo = parts.length >= 24 ? (parts[parts.length - 2] || null) : null;

  return { deviceInfo, ts };
}

export default function ScoringScreen({ onExit, clubId, initialBoardNr }: Props) {
  const { width, height } = useWindowDimensions();
  const isPortrait = height >= width;

  const [players, setPlayers] = useState<[PlayerStats, PlayerStats]>(() => [
    freshPlayer("PL.1"),
    freshPlayer("PL.2"),
  ]);

  const [active, setActive] = useState<0 | 1>(0);
  const [input, setInput] = useState<string>("");

  const [legStarter, setLegStarter] = useState<0 | 1>(0);
  const legStarterRef = useRef<0 | 1>(0);
  useEffect(() => {
    legStarterRef.current = legStarter;
  }, [legStarter]);

  const [lastThrow, setLastThrow] = useState<[number, number]>([0, 0]);

  const INACTIVITY_MS = 3 * 60 * 1000; // 3 perc
  const INACTIVITY_CHECK_MS = 3 * 60 * 1000; // 3 percenként ellenőriz

  const [showInactiveDialog, setShowInactiveDialog] = useState(false);

  // utolsó lokális Firebase-írás időpontja (score push vagy throw)
  const lastLocalSendRef = useRef<number>(0);
  const markLocalFirebaseSend = () => {
    lastLocalSendRef.current = Date.now();
  };

  // undo stack only within current leg
  const undoStack = useRef<
    Array<{
      players: [PlayerStats, PlayerStats];
      active: 0 | 1;
      lastThrow: [number, number];
    }>
  >([]);

  const [hasLegStarted, setHasLegStarted] = useState(false);

  // dialogs
  const [showMenuDialog, setShowMenuDialog] = useState(false); // hamburger
  const [showNamesDialog, setShowNamesDialog] = useState(false); // top-name click
  const [showCheckout, setShowCheckout] = useState(false);
  const [pendingCheckout, setPendingCheckout] = useState<null | { player: 0 | 1; checkoutValue: number }>(null);

  const [boardNr, setBoardNr] = useState<number | null>(() => initialBoardNr ?? null);

  useEffect(() => {
    setBoardNr(initialBoardNr ?? null);
  }, [initialBoardNr]);

  useEffect(() => {
    // ha nincs board, nincs mit figyelni + ne mutassunk üzenetet
    if (boardNr == null) {
      lastLocalSendRef.current = 0;
      return;
    }

    // amikor boardra lépünk / boardot választunk: indul az óra
    markLocalFirebaseSend();

    const id = setInterval(() => {
      if (boardNr == null) return;

      const last = lastLocalSendRef.current || 0;
      if (!last) return;

      const now = Date.now();
      const idle = now - last;

      if (idle > INACTIVITY_MS) {
        // ✅ lecsatlakoztatás boardról + online reset
        setBoardNr(null);

        setMyRole(null);
        lastSeenLRef.current = 0;
        lastSeenRRef.current = 0;
        subscribedAtRef.current = Date.now();

        setShowBoardDialog(false);
        setShowInactiveDialog(true);
      }
    }, INACTIVITY_CHECK_MS);

    return () => clearInterval(id);
  }, [boardNr]);

  const [showBoardDialog, setShowBoardDialog] = useState(false);
  const boardBeforeDialogRef = useRef<number | null>(null);

  // ✅ menu (new game) dialog: itt mindig üresen indul a board picker, és Cancelre visszaáll a régi
  const [menuBoardTmp, setMenuBoardTmp] = useState<number | null>(null);
  const boardBeforeMenuRef = useRef<number | null>(null);

  // temp dialog values
  const [tmpName1, setTmpName1] = useState(players[0].name);
  const [tmpName2, setTmpName2] = useState(players[1].name);

  // name dialogs helpers
  const [name1Touched, setName1Touched] = useState(false);
  const [name2Touched, setName2Touched] = useState(false);

  // ================== ONLINE STATE ==================
  const clientIdRef = useRef<string>(makeClientId());
  // ✅ ez lesz a "deviceInfo", amit a score stringben elküldünk
  const deviceInfoRef = useRef<string>(clientIdRef.current);

  const lastSeenLRef = useRef<number>(0);
  const lastSeenRRef = useRef<number>(0);
  const subscribedAtRef = useRef<number>(0);

  const playersRef = useRef(players);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  const lastThrowRef = useRef(lastThrow);
  useEffect(() => {
    lastThrowRef.current = lastThrow;
  }, [lastThrow]);

  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const hasLegStartedRef = useRef(hasLegStarted);
  useEffect(() => {
    hasLegStartedRef.current = hasLegStarted;
  }, [hasLegStarted]);

  // myRole null => unknown (waiting / classic)
  // once role is discovered => online mode
  const [myRole, setMyRole] = useState<null | "L" | "R">(null);
  const [onlineDisabled, setOnlineDisabled] = useState(false);
  const onlineDisabledRef = useRef(false);
  useEffect(() => {
    onlineDisabledRef.current = onlineDisabled;
  }, [onlineDisabled]);

  // ✅ online detected dialog (only once per board, and only on "online becomes true" moment)
  const [showOnlineDetectedDialog, setShowOnlineDetectedDialog] = useState(false);
  const onlineDialogShownForBoardRef = useRef<string | null>(null);
  const prevOnlineRef = useRef(false);

  const myPlayerIdx: 0 | 1 | null = useMemo(() => {
    if (myRole === "L") return 0;
    if (myRole === "R") return 1;
    return null;
  }, [myRole]);

  const isOnline = myRole != null && !onlineDisabled;
  const isMyTurn = useMemo(() => {
    if (!isOnline) return true;
    if (myPlayerIdx == null) return true;
    return active === myPlayerIdx;
  }, [isOnline, myPlayerIdx, active]);

  const pushUndo = () => {
    const cloned: [PlayerStats, PlayerStats] = [{ ...playersRef.current[0] }, { ...playersRef.current[1] }];
    undoStack.current.push({
      players: cloned,
      active: activeRef.current,
      lastThrow: [...lastThrowRef.current] as [number, number],
    });
  };

  const clearUndoForNewLeg = () => {
    undoStack.current = [];
    setHasLegStarted(false);
  };

  const safeSetInputWith180Limit = (next: string) => {
    if (!isMyTurn) return;

    const digits = clampToDigits(next).slice(0, 3);
    if (!digits) {
      setInput("");
      return;
    }

    const n = toInt(digits);
    if (n > 180) {
      const trimmed = digits.slice(0, -1);
      const t = trimmed ? toInt(trimmed) : 0;
      setInput(trimmed && t <= 180 ? trimmed : "");
      return;
    }
    setInput(digits);
  };

  const onDigit = (d: number) => {
    if (!isMyTurn) return;
    safeSetInputWith180Limit(`${input}${d}`);
  };

  const onDel = () => {
    if (!isMyTurn) return;
    if (!input) return;
    setInput(input.slice(0, -1));
  };

  // ======= AVERAGES (android stringhez) =======
  const avg = (p: PlayerStats) => (p.dartsThrownTotal > 0 ? p.pointsScoredTotal / p.dartsThrownTotal : 0);
  const avgX3 = (p: PlayerStats) => avg(p) * 3;
  const legAvg = (p: PlayerStats) => (p.legDartsThrown > 0 ? p.legPointsScored / p.legDartsThrown : 0);
  const wonAvg = (p: PlayerStats) => (p.wonLegDartsTotal > 0 ? (p.wonLegs * START_SCORE) / p.wonLegDartsTotal : 0);

  // ======= FIREBASE PUSH (android struktúra) =======
  // ✅ ÚJ: timestamp előtt küldünk még 1 elemet: deviceInfo
  const buildAndroidValueString = () => {
    const p1 = players[0];
    const p2 = players[1];
    const ts = Date.now();
    const deviceInfo = deviceInfoRef.current;

    return [
      p1.name,
      p2.name,
      String(p1.score),
      String(p2.score),
      String(lastThrow[0] || 0),
      String(lastThrow[1] || 0),
      String(p1.legDartsThrown), // throws = current leg darts
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
      String(deviceInfo), // ✅ last-1
      String(ts), // ✅ last (Android: parts[parts.length - 1])
    ].join("_");
  };

  const pushToFirebase = async () => {
    if (boardNr == null) return;
    // ✅ aktivitás: próbálunk frissíteni score-t
    markLocalFirebaseSend();
    try {
      const value = buildAndroidValueString();
      const path = `score/${clubId}/${boardNr}`;
      await set(ref(db, path), value);
    } catch {
      // silent
    }
  };

  useEffect(() => {
    void pushToFirebase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, lastThrow, boardNr]);

  // ======= ONLINE: write throws =======
  const writeThrow = async (side: "L" | "R", msg: ThrowMsg) => {
    if (boardNr == null) return;
    // ✅ aktivitás: próbálunk throw-t küldeni
    markLocalFirebaseSend();

    try {
      const path = `throws/${clubId}/${boardNr}/${side}`;
      await set(ref(db, path), msg);
    } catch {
      // silent
    }
  };

  const playerIdxToSide = (pIdx: 0 | 1): "L" | "R" => (pIdx === 0 ? "L" : "R");

  // ================== APPLY SCORING CORE (can be used for remote) ==================
  const applyScoringAs = (
    pIdx: 0 | 1,
    opts: { kind: "score" | "left" | "check"; value?: number; allowZero?: boolean },
    source: "local" | "remote",
    remoteCheckoutDartsUsed?: 1 | 2 | 3
  ) => {
    const curPlayers = playersRef.current;
    const curLastThrow = lastThrowRef.current;

    const p = curPlayers[pIdx];
    const oppIdx: 0 | 1 = pIdx === 0 ? 1 : 0;

    let throwValue = 0;

    if (opts.kind === "check") {
      if (!isCheckoutPossible(p.score)) return { applied: false as const };
      throwValue = p.score;
    } else if (opts.kind === "score") {
      throwValue = opts.value ?? 0;
      if (throwValue > 180) return { applied: false as const };
    } else {
      const left = opts.value ?? 0;
      if (left === 0 && !isCheckoutPossible(p.score)) return { applied: false as const };

      throwValue = p.score - left;
      if (throwValue > 180) return { applied: false as const };
      if (throwValue < 0) throwValue = 0;
    }

    const allowZero = opts.kind === "score" && throwValue === 0 && opts.allowZero === true;

    if (opts.kind !== "check" && throwValue <= 0 && !allowZero) {
      if (source === "local") setInput("");
      return { applied: false as const };
    }

    if (!hasLegStartedRef.current) {
      setHasLegStarted(true);
      setLegStarter(activeRef.current); // aki épp kezdte a leget
    }

    if (source === "local") pushUndo();

    const prevScore = p.score;
    const tentative = prevScore - throwValue;
    const wasBust = tentative < 0 || tentative === 1;
    const isCheckout = !wasBust && tentative === 0;

    const nextLastThrow: [number, number] = [...curLastThrow] as [number, number];
    nextLastThrow[pIdx] = throwValue;

    // Bust
    if (wasBust) {
      const nextPlayers: [PlayerStats, PlayerStats] = [{ ...curPlayers[0] }, { ...curPlayers[1] }];
      const np = { ...nextPlayers[pIdx] };

      np.dartsThrownTotal += 3;
      np.legDartsThrown += 3;

      nextPlayers[pIdx] = np;

      // ✅ keep refs in sync immediately (fix remote fast updates)
      playersRef.current = nextPlayers;
      lastThrowRef.current = nextLastThrow;

      setPlayers(nextPlayers);
      setLastThrow(nextLastThrow);

      if (source === "local") setInput("");
      setActive(oppIdx);

      return { applied: true as const, throwValue, isCheckout: false as const, wasBust: true as const };
    }

    // Checkout trigger
    if (isCheckout) {
      // last throw should still show immediately
      lastThrowRef.current = nextLastThrow;
      setLastThrow(nextLastThrow);

      if (source === "local") {
        setPendingCheckout({ player: pIdx, checkoutValue: throwValue });
        setShowCheckout(true);
        setInput("");
        return { applied: true as const, throwValue, isCheckout: true as const, wasBust: false as const };
      }

      if (!remoteCheckoutDartsUsed) {
        return { applied: false as const };
      }

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
      np.bestLegDarts = np.bestLegDarts == null ? np.legDartsThrown : Math.min(np.bestLegDarts, np.bestLegDarts);
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

      // ✅ keep refs in sync immediately (fix remote fast updates)
      playersRef.current = nextPlayers;
      lastThrowRef.current = [0, 0];

      setPlayers(nextPlayers);
      setPendingCheckout(null);
      setShowCheckout(false);
      clearUndoForNewLeg();
      setLastThrow([0, 0]);

      const nextLegStarter: 0 | 1 = legStarterRef.current === 0 ? 1 : 0;
      setLegStarter(nextLegStarter);
      setActive(nextLegStarter);

      return { applied: true as const, throwValue, isCheckout: true as const, wasBust: false as const };
    }

    // Normal non-checkout
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

    // ✅ keep refs in sync immediately (fix remote fast updates)
    playersRef.current = nextPlayers;
    lastThrowRef.current = nextLastThrow;

    setPlayers(nextPlayers);
    setLastThrow(nextLastThrow);

    if (source === "local") setInput("");
    setActive(oppIdx);

    return { applied: true as const, throwValue, isCheckout: false as const, wasBust: false as const };
  };

  const applyScoring = (opts: { kind: "score" | "left" | "check"; value?: number; allowZero?: boolean }) => {
    if (!isMyTurn) return;

    const pIdx = active;

    // Online mode: only allow your own side
    if (isOnline && myPlayerIdx != null && pIdx !== myPlayerIdx) return;

    const res = applyScoringAs(pIdx, opts, "local");

    // write non-checkout
    if (res.applied && !res.isCheckout && boardNr != null) {
      const side = playerIdxToSide(pIdx);
      void writeThrow(side, { v: res.throwValue, ts: Date.now(), by: clientIdRef.current });
    }
  };

  // ======= CHECKOUT CONFIRM (local) =======
  const confirmCheckout = (dartsUsed: 1 | 2 | 3) => {
    if (!isMyTurn) return;

    const curPlayers = playersRef.current;
    const pending = pendingCheckout;

    if (!pending) {
      setShowCheckout(false);
      return;
    }

    const pIdx = pending.player;
    const oppIdx: 0 | 1 = pIdx === 0 ? 1 : 0;
    const throwValue = pending.checkoutValue;

    // In online mode, only allow if it's my player
    if (isOnline && myPlayerIdx != null && pIdx !== myPlayerIdx) {
      setShowCheckout(false);
      return;
    }

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
    np.bestLegDarts = np.bestLegDarts == null ? np.legDartsThrown : Math.min(np.bestLegDarts, np.bestLegDarts);
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
    setLegStarter(nextLegStarter);
    setActive(nextLegStarter);

    // ✅ keep refs in sync immediately
    playersRef.current = nextPlayers;
    lastThrowRef.current = [0, 0];

    setPlayers(nextPlayers);
    setPendingCheckout(null);
    setShowCheckout(false);
    setInput("");
    clearUndoForNewLeg();
    setLastThrow([0, 0]);

    // ✅ write checkout throw with dartsUsed
    if (boardNr != null) {
      const side = playerIdxToSide(pIdx);
      void writeThrow(side, { v: throwValue, ts: Date.now(), by: clientIdRef.current, dUsed: dartsUsed });
    }
  };

  const onOk = () => {
    if (input === "") return; // ✅ hint/üres: ne csináljon semmit
    const v = toInt(input);
    applyScoring({ kind: "score", value: v, allowZero: input === "0" });
  };
  const onLeft = () => applyScoring({ kind: "left", value: toInt(input || "0") });
  const onQuick = (v: number) => applyScoring({ kind: "score", value: v });

  const onUndo = () => {
    if (!isMyTurn) return;
    // Online mode: ignore undo (v1)
    if (isOnline) return;

    const prev = undoStack.current.pop();
    if (!prev) return;

    playersRef.current = prev.players;
    lastThrowRef.current = prev.lastThrow;

    setPlayers(prev.players);
    setActive(prev.active);
    setLastThrow(prev.lastThrow);
    setInput("");

    if (undoStack.current.length === 0) setHasLegStarted(false);
  };

  // ✅ ONLINE detected dialog: only when online becomes true (false -> true), and once per board
  useEffect(() => {
    const onlineNow = myRole != null && !onlineDisabledRef.current;

    if (boardNr == null) {
      prevOnlineRef.current = onlineNow;
      return;
    }

    // ha user letiltotta az online-t, semmit ne mutassunk
    if (onlineDisabledRef.current) {
      prevOnlineRef.current = onlineNow;
      return;
    }

    const key = `${clubId}:${boardNr}`;

    if (onlineNow && !prevOnlineRef.current && onlineDialogShownForBoardRef.current !== key) {
      onlineDialogShownForBoardRef.current = key;
      setShowOnlineDetectedDialog(true);
    }

    prevOnlineRef.current = onlineNow;
  }, [myRole, boardNr, clubId, onlineDisabled]);

  // ================== ONLINE: subscribe to remote throws ==================
  useEffect(() => {
    // reset online when board changes / deselect
    setMyRole(null);
    lastSeenLRef.current = 0;
    lastSeenRRef.current = 0;

    if (boardNr == null) return;

    // ✅ NO ONLINE: ne is subscriboljunk
    if (onlineDisabled) return;

    subscribedAtRef.current = Date.now();

    const lRef = ref(db, `throws/${clubId}/${boardNr}/L`);
    const rRef = ref(db, `throws/${clubId}/${boardNr}/R`);

    const unsubL = onValue(lRef, (snap) => {
      // ✅ hard gate (ha közben lett NO ONLINE)
      if (onlineDisabledRef.current) return;

      const v = snap.val() as ThrowMsg | null;
      if (!v || typeof v !== "object") return;
      if (v.by === clientIdRef.current) return;
      if (!v.ts || v.ts <= lastSeenLRef.current) return;
      if (v.ts <= subscribedAtRef.current) return;

      lastSeenLRef.current = v.ts;

      setMyRole((prev) => (onlineDisabledRef.current ? null : prev ?? "R"));

      if (typeof v.v === "number" && v.v >= 0) {
        const isCheckoutMsg = typeof v.dUsed === "number";
        if (isCheckoutMsg) {
          applyScoringAs(0, { kind: "score", value: v.v, allowZero: v.v === 0 }, "remote", v.dUsed);
        } else {
          applyScoringAs(0, { kind: "score", value: v.v, allowZero: v.v === 0 }, "remote");
        }
      }
    });

    const unsubR = onValue(rRef, (snap) => {
      if (onlineDisabledRef.current) return;

      const v = snap.val() as ThrowMsg | null;
      if (!v || typeof v !== "object") return;
      if (v.by === clientIdRef.current) return;
      if (!v.ts || v.ts <= lastSeenRRef.current) return;
      if (v.ts <= subscribedAtRef.current) return;

      lastSeenRRef.current = v.ts;

      setMyRole((prev) => (onlineDisabledRef.current ? null : prev ?? "L"));

      if (typeof v.v === "number" && v.v >= 0) {
        const isCheckoutMsg = typeof v.dUsed === "number";
        if (isCheckoutMsg) {
          applyScoringAs(1, { kind: "score", value: v.v, allowZero: v.v === 0 }, "remote", v.dUsed);
        } else {
          applyScoringAs(1, { kind: "score", value: v.v, allowZero: v.v === 0 }, "remote");
        }
      }
    });

    return () => {
      unsubL();
      unsubR();
    };
  }, [boardNr, clubId, onlineDisabled]);

  // ================== BOARD "DIM" LOGIC (score tail deviceInfo) ==================
  // Ha a boardon utoljára elküldött stats stringben a (last-1) deviceInfo NEM a miénk,
  // akkor halványítsuk a karikát, de legyen kattintható.
  const FRESH_LIMIT_MS = 2 * 60 * 1000;

const [boardTailMap, setBoardTailMap] = useState<Record<number, { deviceInfo: string | null; ts: number }>>({
  1: { deviceInfo: null, ts: 0 },
  2: { deviceInfo: null, ts: 0 },
  3: { deviceInfo: null, ts: 0 },
  4: { deviceInfo: null, ts: 0 },
  5: { deviceInfo: null, ts: 0 },
  6: { deviceInfo: null, ts: 0 },
  7: { deviceInfo: null, ts: 0 },
  8: { deviceInfo: null, ts: 0 },
});

  useEffect(() => {
    // csak akkor figyeljük, amikor valamelyik board picker nyitva van
    if (!showBoardDialog && !showMenuDialog) return;

    const boardNrs = [1, 2, 3, 4, 5, 6, 7, 8];
    const unsubs: Array<() => void> = [];

    for (const n of boardNrs) {
      const r = ref(db, `score/${clubId}/${n}`);
      const unsub = onValue(r, (snap) => {
        const raw = snap.val() == null ? null : String(snap.val());
        const tail = parseScoreTail(raw);
          setBoardTailMap((prev) => ({ ...prev, [n]: tail }));
      });
      unsubs.push(unsub);
    }

    return () => unsubs.forEach((u) => u());
  }, [showBoardDialog, showMenuDialog, clubId]);

  const shouldDimBoardCircle = (n: number) => {
    const tail = boardTailMap[n];
    if (!tail) return false;

    const theirs = tail.deviceInfo;
    if (!theirs) return false; // régi format => ne dim

    const isFresh = tail.ts > 0 && Date.now() - tail.ts <= FRESH_LIMIT_MS;
    if (!isFresh) return false; // ✅ ha már nem friss, ne dim

    return theirs !== deviceInfoRef.current;
  };

  const [showOnlineInfo, setShowOnlineInfo] = useState(false);

  // dialogs open helpers
  const openMenu = () => {
    boardBeforeMenuRef.current = boardNr;
    setMenuBoardTmp(null);

    setTmpName1(playersRef.current[0].name);
    setTmpName2(playersRef.current[1].name);
    setName1Touched(false);
    setName2Touched(false);

    setShowOnlineInfo(false);
    setShowMenuDialog(true);
  };

  const openNames = () => {
    setTmpName1(playersRef.current[0].name);
    setTmpName2(playersRef.current[1].name);
    setName1Touched(false);
    setName2Touched(false);
    setShowNamesDialog(true);
  };

  const swapNamesInDialog = () => {
    setTmpName1(tmpName2);
    setTmpName2(tmpName1);
  };

  const confirmNamesOnly = () => {
    const n1 = (tmpName1 || "PL.1").trim() || "PL.1";
    const n2 = (tmpName2 || "PL.2").trim() || "PL.2";

    const cur = playersRef.current;
    const next: [PlayerStats, PlayerStats] = [{ ...cur[0], name: n1 }, { ...cur[1], name: n2 }];

    playersRef.current = next;
    setPlayers(next);
    setShowNamesDialog(false);
  };

  const newGameFromMenu = () => {
    const n1 = (tmpName1 || "PL.1").trim() || "PL.1";
    const n2 = (tmpName2 || "PL.2").trim() || "PL.2";

    const next: [PlayerStats, PlayerStats] = [freshPlayer(n1), freshPlayer(n2)];

    playersRef.current = next;
    lastThrowRef.current = [0, 0];

    setPlayers(next);
    setActive(0);
    setLegStarter(0);
    setInput("");
    setLastThrow([0, 0]);

    undoStack.current = [];
    setHasLegStarted(false);

    // ✅ board: csak akkor legyen beállítva, ha most választottak (különben null)
    setBoardNr(menuBoardTmp ?? null);
    setMenuBoardTmp(null);

    // ✅ online warning reset + online mód reset (újra tudjon felugrani)
    onlineDialogShownForBoardRef.current = null;
    prevOnlineRef.current = false;
    setShowOnlineDetectedDialog(false);

    setMyRole(null);
    lastSeenLRef.current = 0;
    lastSeenRRef.current = 0;
    subscribedAtRef.current = Date.now();

    setShowMenuDialog(false);
  };

  // ✅ broadcast / board (icon click dialog)
  const openBoard = () => {
    boardBeforeDialogRef.current = boardNr; // snapshot
    setShowBoardDialog(true);
  };

  const cancelBoardDialog = () => {
    setBoardNr(boardBeforeDialogRef.current ?? null);
    setShowBoardDialog(false);
  };

  const confirmBoard = () => {
    setShowBoardDialog(false);
  };

  const renderBroadcastIcon = () => {
    const src = require("./screen.png");
    return (
      <View style={styles.broadcastIconWrap} pointerEvents="none">
        <Image
          source={src}
          style={[
            styles.broadcastIcon,
            boardNr == null ? styles.broadcastIconIdle : styles.broadcastIconActive,
          ]}
        />
        {boardNr != null ? <Text style={styles.broadcastBoardNr}>{boardNr}</Text> : null}
      </View>
    );
  };

  const statsChips = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.statsBarInner}
    >
      <View style={styles.statsEdgeSpacer} />
      <StatChip label="Throws" v1={players[0].legDartsThrown} v2={players[1].legDartsThrown} />
      <StatChip label="Avg." v1={format2AndroidLike(avg(players[0]))} v2={format2AndroidLike(avg(players[1]))} />
      <StatChip
        label="Avg.x3"
        v1={format2AndroidLike(avgX3(players[0]))}
        v2={format2AndroidLike(avgX3(players[1]))}
      />
      <StatChip
        label="Leg Avg."
        v1={format2AndroidLike(legAvg(players[0]))}
        v2={format2AndroidLike(legAvg(players[1]))}
      />
      <StatChip label="100+" v1={players[0].c100} v2={players[1].c100} />
      <StatChip label="140+" v1={players[0].c140} v2={players[1].c140} />
      <StatChip label="180+" v1={players[0].c180} v2={players[1].c180} />
      <StatChip label="Won Avg." v1={format2AndroidLike(wonAvg(players[0]))} v2={format2AndroidLike(wonAvg(players[1]))} />
      <StatChip label="Best" v1={players[0].bestLegDarts ?? 0} v2={players[1].bestLegDarts ?? 0} />
      <StatChip label="H.Out" v1={players[0].highOut} v2={players[1].highOut} />
      <View style={styles.statsEdgeSpacer} />
    </ScrollView>
  );

  const showOnlineBadgeLeft = isOnline && myPlayerIdx != null && myPlayerIdx !== 0;
  const showOnlineBadgeRight = isOnline && myPlayerIdx != null && myPlayerIdx !== 1;

  const TopHeader = (
    <View style={styles.topHeader}>
      <View style={styles.topNamesRow}>
        <Pressable onPress={openNames} hitSlop={10}>
          <View style={styles.nameWithDotRight}>
            <Text style={styles.nameSmall} numberOfLines={1}>
              {players[0].name}
            </Text>

            {showOnlineBadgeLeft ? (
              <View style={styles.onlineBadge}>
                <Text style={styles.onlineBadgeText}>online</Text>
              </View>
            ) : null}

            <View style={[styles.activeDot, active === 0 ? styles.activeDotOn : styles.activeDotOff]} />
          </View>
        </Pressable>

        <Text style={styles.legsMid} numberOfLines={1}>
          {players[0].legs} - {players[1].legs}
        </Text>

        <Pressable onPress={openNames} hitSlop={10}>
          <View style={styles.nameWithDotLeft}>
            <View style={[styles.activeDot, active === 1 ? styles.activeDotOn : styles.activeDotOff]} />

            {showOnlineBadgeRight ? (
              <View style={styles.onlineBadge}>
                <Text style={styles.onlineBadgeText}>online</Text>
              </View>
            ) : null}

            <Text style={styles.nameSmall} numberOfLines={1}>
              {players[1].name}
            </Text>
          </View>
        </Pressable>
      </View>

      {!isPortrait ? (
        <View style={styles.scoreRowLandscape}>
          <View style={styles.scoreSideLandscape}>
            <Text style={styles.lastMiniLeft} numberOfLines={1}>
              {lastThrow[0] || 0}
            </Text>
            <Text style={styles.scoreBigLeft} numberOfLines={1}>
              {players[0].score}
            </Text>
            <DualInput
              side="left"
              visible={active === 0 && isMyTurn}
              value={active === 0 ? input : ""}
              onChangeText={safeSetInputWith180Limit}
            />
          </View>

          <Pressable onPress={openBoard} hitSlop={10} style={styles.broadcastMid}>
            {renderBroadcastIcon()}
          </Pressable>

          <View style={[styles.scoreSideLandscape, styles.scoreSideLandscapeRight]}>
            <DualInput
              side="right"
              visible={active === 1 && isMyTurn}
              value={active === 1 ? input : ""}
              onChangeText={safeSetInputWith180Limit}
            />
            <Text style={styles.scoreBigRight} numberOfLines={1}>
              {players[1].score}
            </Text>
            <Text style={styles.lastMiniRight} numberOfLines={1}>
              {lastThrow[1] || 0}
            </Text>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.scoreRowPortrait}>
            <Text style={styles.scoreBigLeft} numberOfLines={1}>
              {players[0].score}
            </Text>
            <Text style={styles.scoreBigRight} numberOfLines={1}>
              {players[1].score}
            </Text>
          </View>

          <View style={styles.lastRowPortrait}>
            <Text style={styles.lastMiniLeft} numberOfLines={1}>
              {lastThrow[0] || 0}
            </Text>
            <Text style={styles.lastMiniRight} numberOfLines={1}>
              {lastThrow[1] || 0}
            </Text>
          </View>

          <View style={styles.inputsRowPortrait}>
            <DualInput
              side="left"
              visible={active === 0 && isMyTurn}
              value={active === 0 ? input : ""}
              onChangeText={safeSetInputWith180Limit}
            />

            <Pressable onPress={openBoard} hitSlop={10} style={styles.broadcastMidPortrait}>
              {renderBroadcastIcon()}
            </Pressable>

            <DualInput
              side="right"
              visible={active === 1 && isMyTurn}
              value={active === 1 ? input : ""}
              onChangeText={safeSetInputWith180Limit}
            />
          </View>
        </>
      )}
    </View>
  );

  const Keyboard = isPortrait ? (
    <View style={styles.keyboard}>
      {QUICK_PORTRAIT_ROWS.map((row, idx) => (
        <View key={idx} style={styles.kRowFlex}>
          {row.map((k) => {
            const kind = k.kind ?? "num";
            const label = k.label;

            const onPress = () => {
              if (!isMyTurn) return;

              if (label === "DEL") return onDel();
              if (label === "UNDO") return onUndo();
              if (label === "OK") return onOk();
              if (label === "LEFT") return onLeft();
              if (kind === "quick") return onQuick(k.value ?? toInt(label));
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
        <KeyFlex label="1" onPress={() => (isMyTurn ? onDigit(1) : null)} />
        <KeyFlex label="2" onPress={() => (isMyTurn ? onDigit(2) : null)} />
        <KeyFlex label="3" onPress={() => (isMyTurn ? onDigit(3) : null)} />
        <KeyFlex label="DEL" kind="action" onPress={() => (isMyTurn ? onDel() : null)} />
        <KeyFlex label="UNDO" kind="action" onPress={() => (isMyTurn ? onUndo() : null)} />
        <KeyFlex label="121" kind="quick" onPress={() => (isMyTurn ? onQuick(121) : null)} />
        <KeyFlex label="125" kind="quick" onPress={() => (isMyTurn ? onQuick(125) : null)} />
        <KeyFlex label="140" kind="quick" onPress={() => (isMyTurn ? onQuick(140) : null)} />
      </View>

      <View style={styles.kRowFlex}>
        <KeyFlex label="4" onPress={() => (isMyTurn ? onDigit(4) : null)} />
        <KeyFlex label="5" onPress={() => (isMyTurn ? onDigit(5) : null)} />
        <KeyFlex label="6" onPress={() => (isMyTurn ? onDigit(6) : null)} />
        <KeyFlex label="0" onPress={() => (isMyTurn ? onDigit(0) : null)} />
        <KeyFlex label="60" kind="quick" onPress={() => (isMyTurn ? onQuick(60) : null)} />
        <KeyFlex label="81" kind="quick" onPress={() => (isMyTurn ? onQuick(81) : null)} />
        <KeyFlex label="85" kind="quick" onPress={() => (isMyTurn ? onQuick(85) : null)} />
        <KeyFlex label="100" kind="quick" onPress={() => (isMyTurn ? onQuick(100) : null)} />
      </View>

      <View style={styles.kRowFlex}>
        <KeyFlex label="7" onPress={() => (isMyTurn ? onDigit(7) : null)} />
        <KeyFlex label="8" onPress={() => (isMyTurn ? onDigit(8) : null)} />
        <KeyFlex label="9" onPress={() => (isMyTurn ? onDigit(9) : null)} />
        <KeyFlex label="OK" kind="action" onPress={() => (isMyTurn ? onOk() : null)} />
        <KeyFlex label="LEFT" kind="action" onPress={() => (isMyTurn ? onLeft() : null)} />
        <KeyFlex label="26" kind="quick" onPress={() => (isMyTurn ? onQuick(26) : null)} />
        <KeyFlex label="41" kind="quick" onPress={() => (isMyTurn ? onQuick(41) : null)} />
        <KeyFlex label="45" kind="quick" onPress={() => (isMyTurn ? onQuick(45) : null)} />
      </View>
    </View>
  );

  return (
    <View style={styles.safe}>
      <View style={styles.screen}>
        {TopHeader}

        <View style={styles.keyboardArea}>{Keyboard}</View>

        <View style={styles.statsBar}>{statsChips}</View>

        <Pressable style={styles.cornerCheck} onPress={() => (isMyTurn ? applyScoring({ kind: "check" }) : null)}>
          <Text style={styles.cornerCheckText}>check</Text>
        </Pressable>

        {/* ✅ hamburger menu */}
        <Pressable style={styles.cornerMenu} onPress={openMenu}>
          <Text style={styles.cornerText}>☰</Text>
        </Pressable>
      </View>

      {/* BOARD dialog (broadcast icon click) */}
      <Modal
        visible={showBoardDialog}
        transparent
        animationType="fade"
        onRequestClose={() => setShowBoardDialog(false)}
      >
        <View style={styles.modalOverlay} accessible={false} focusable>
          <View style={styles.modalCard}>
            <Text style={styles.modalLabel}>Board Nr</Text>

            <View style={styles.boardPickGrid}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
                const selected = boardNr === n;
                const dim = shouldDimBoardCircle(n) && !selected;

                return (
                  <Pressable
                    key={n}
                    onPress={() => setBoardNr(selected ? null : n)}
                    style={({ pressed }) => [
                      styles.boardPickCircle,
                      selected ? styles.boardPickCircleOn : styles.boardPickCircleOff,
                      dim ? styles.boardPickCircleDim : null,
                      pressed ? { opacity: 0.8 } : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.boardPickText,
                        selected ? styles.boardPickTextOn : styles.boardPickTextOff,
                        dim ? styles.boardPickTextDim : null,
                      ]}
                    >
                      {n}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.modalBtns}>
              <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={cancelBoardDialog}>
                <Text style={styles.modalBtnTextGhost}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={confirmBoard}>
                <Text style={styles.modalBtnTextOk}>OK</Text>
              </Pressable>
            </View>

            <Text style={styles.modalHintSmall}>
              Club: {clubId} • Current: {boardNr ?? "-"}
            </Text>
          </View>
        </View>
      </Modal>

      {/* MENU dialog (hamburger): cancel + new game + exit scoring mode */}
      <Modal
        visible={showMenuDialog}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMenuDialog(false)}
      >
        <View style={styles.modalOverlay} accessible={false} focusable>
          <View style={styles.modalCard}>
            <View style={styles.namesBlock}>
              <TextInput
                autoFocus={false}
                value={tmpName1}
                onChangeText={setTmpName1}
                style={styles.modalInput}
                placeholder="Player 1"
                placeholderTextColor="rgba(0,0,0,0.45)"
                onFocus={() => {
                  if (!name1Touched) {
                    setTmpName1("");
                    setName1Touched(true);
                  }
                }}
              />
              <View style={styles.namesGap} />
              <TextInput
                autoFocus={false}
                value={tmpName2}
                onChangeText={setTmpName2}
                style={styles.modalInput}
                placeholder="Player 2"
                placeholderTextColor="rgba(0,0,0,0.45)"
                onFocus={() => {
                  if (!name2Touched) {
                    setTmpName2("");
                    setName2Touched(true);
                  }
                }}
              />
              <Pressable onPress={swapNamesInDialog} hitSlop={10} style={styles.swapBtnBetween}>
                <Text style={styles.swapBtnText}>⇄</Text>
              </Pressable>
            </View>

            {/* ✅ board picker in menu: mindig üresen indul (menuBoardTmp), Cancelre visszaáll a régi */}
            <View style={styles.menuBoardPickerWrap}>
              <View style={styles.boardPickGrid}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
                  const selected = menuBoardTmp === n;
                  const dim = shouldDimBoardCircle(n) && !selected;

                  return (
                    <Pressable
                      key={n}
                      onPress={() => setMenuBoardTmp(selected ? null : n)}
                      style={({ pressed }) => [
                        styles.boardPickCircle,
                        selected ? styles.boardPickCircleOn : styles.boardPickCircleOff,
                        dim ? styles.boardPickCircleDim : null,
                        pressed ? { opacity: 0.8 } : null,
                      ]}
                    >
                      <Text
                        style={[
                          styles.boardPickText,
                          selected ? styles.boardPickTextOn : styles.boardPickTextOff,
                          dim ? styles.boardPickTextDim : null,
                        ]}
                      >
                        {n}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {showOnlineInfo ? (
              <Text style={styles.onlineInfoText}>
                Az ONLINE meccshez nem kell mást tennetek, csak ugyanazt a pályát kiválasztanotok mindketten és NEW GAME.
              </Text>
            ) : null}

            <View style={styles.modalBtns}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => {
                  setBoardNr(boardBeforeMenuRef.current ?? null);
                  setMenuBoardTmp(null);
                  setShowMenuDialog(false);
                }}
              >
                <Text style={styles.modalBtnTextGhost}>Cancel</Text>
              </Pressable>

              <Pressable
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setShowOnlineInfo((v) => !v)}
              >
                <Text style={styles.modalBtnTextGhost}>ONLINE</Text>
              </Pressable>

              <Pressable style={[styles.modalBtn, styles.modalBtnOk]} onPress={newGameFromMenu}>
                <Text style={styles.modalBtnTextOk}>New game</Text>
              </Pressable>
            </View>

            <Pressable onPress={onExit} hitSlop={8} style={styles.exitInline}>
              <Text style={styles.exitInlineText}>Exit scoring mode</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* NAMES dialog (top names click): only rename + swap + cancel/ok */}
      <Modal
        visible={showNamesDialog}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNamesDialog(false)}
      >
        <View style={styles.modalOverlay} accessible={false} focusable>
          <View style={styles.modalCard}>
            <View style={styles.namesBlock}>
              <TextInput
                autoFocus={false}
                value={tmpName1}
                onChangeText={setTmpName1}
                style={styles.modalInput}
                placeholder="Player 1"
                placeholderTextColor="rgba(0,0,0,0.45)"
                onFocus={() => {
                  if (!name1Touched) {
                    setTmpName1("");
                    setName1Touched(true);
                  }
                }}
              />
              <View style={styles.namesGap} />
              <TextInput
                autoFocus={false}
                value={tmpName2}
                onChangeText={setTmpName2}
                style={styles.modalInput}
                placeholder="Player 2"
                placeholderTextColor="rgba(0,0,0,0.45)"
                onFocus={() => {
                  if (!name2Touched) {
                    setTmpName2("");
                    setName2Touched(true);
                  }
                }}
              />
              <Pressable onPress={swapNamesInDialog} hitSlop={10} style={styles.swapBtnBetween}>
                <Text style={styles.swapBtnText}>⇄</Text>
              </Pressable>
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

      {/* CHECKOUT dialog */}
      <Modal
        visible={showCheckout}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCheckout(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Checkout</Text>
            <Text style={styles.modalLabel}>Hányadik nyílra sikerült?</Text>

            <View style={styles.checkoutRow}>
              {getCheckoutDartOptions(pendingCheckout?.checkoutValue ?? 0).map((n) => (
                <Pressable
                  key={n}
                  style={[styles.checkoutBtn, styles.modalBtnOk]}
                  onPress={() => confirmCheckout(n)}
                >
                  <Text style={styles.checkoutText}>{n}</Text>
                </Pressable>
              ))}
            </View>

            <Pressable style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShowCheckout(false)}>
              <Text style={styles.modalBtnTextGhost}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ✅ ONLINE DETECTED dialog (one-time) */}
      <Modal
        visible={showOnlineDetectedDialog}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOnlineDetectedDialog(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Online mód</Text>

            <Text style={styles.modalLabel}>
              Úgy tűnik még egy klubtársad játszik ezen a táblán. Online módban vagytok.
              Ha nem szándékos, akkor válassz másik pályát!
            </Text>

            <View style={[styles.modalBtns, { marginTop: 12 }]}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => {
                  setOnlineDisabled(true);

                  // ✅ azonnal álljunk vissza offline módba UI+logika szinten
                  setShowOnlineDetectedDialog(false);
                  setMyRole(null);
                  prevOnlineRef.current = false;

                  // ✅ online state reset
                  lastSeenLRef.current = 0;
                  lastSeenRRef.current = 0;
                  subscribedAtRef.current = Date.now();

                  // ✅ ne jöhessen fel újra ebben a sessionben
                  if (boardNr != null) {
                    onlineDialogShownForBoardRef.current = `disabled:${clubId}:${boardNr}`;
                  } else {
                    onlineDialogShownForBoardRef.current = `disabled:${clubId}:-`;
                  }
                }}
              >
                <Text style={styles.modalBtnTextGhost}>NO ONLINE</Text>
              </Pressable>

              <Pressable
                style={[styles.modalBtn, styles.modalBtnOk]}
                onPress={() => setShowOnlineDetectedDialog(false)}
              >
                <Text style={styles.modalBtnTextOk}>OK</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showInactiveDialog}
        transparent
        animationType="fade"
        onRequestClose={() => setShowInactiveDialog(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Lecsatlakoztatva</Text>

            <Text style={styles.modalLabel}>
              Inaktivitás miatt lecsatlakoztattunk a boardról. Ha mégis használni szeretnéd,
              akkor csatlakozz újra.
            </Text>

            <Pressable
              style={[styles.modalBtn, styles.modalBtnOk, { marginTop: 12 }]}
              onPress={() => setShowInactiveDialog(false)}
            >
              <Text style={styles.modalBtnTextOk}>OK</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function DualInput(props: {
  side: "left" | "right";
  visible: boolean;
  value: string;
  onChangeText: (t: string) => void;
}) {
  const alignStyle = props.side === "left" ? styles.inputLeft : styles.inputRight;

  return (
    <View style={[styles.inputBoxWrap, alignStyle]}>
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
  return (
    <View style={styles.statChip}>
      <Text style={styles.statChipText}>
        {String(props.v1)} <Text style={styles.statChipLabel}>{props.label}</Text> {String(props.v2)}
      </Text>
    </View>
  );
}

function KeyFlex(props: { label: string; onPress: () => void; kind?: "num" | "action" | "quick" }) {
  const kind = props.kind ?? "num";
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.keyFlex,
        kind === "action" ? styles.keyAction : null,
        kind === "quick" ? styles.keyQuick : null,
        pressed ? { opacity: 0.78 } : null,
      ]}
    >
      <Text style={[styles.keyText, kind !== "num" ? styles.keyTextAction : null]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#ffffff" },
  screen: { flex: 1, backgroundColor: "#ffffff" },

  topHeader: { paddingTop: 4, paddingHorizontal: 8, paddingBottom: 4 },
  topNamesRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  nameSmall: { color: "rgba(0,0,0,0.65)", fontWeight: "900", fontSize: 16, maxWidth: 140 },
  legsMid: { color: "rgba(0,0,0,0.55)", fontWeight: "900", fontSize: 22 },

  nameWithDotRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  nameWithDotLeft: { flexDirection: "row", alignItems: "center", gap: 8 },

  activeDot: { width: 10, height: 10, borderRadius: 999 },
  activeDotOn: { backgroundColor: "#2f6f18" },
  activeDotOff: { backgroundColor: "transparent" },

  onlineBadge: {
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.20)",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "rgba(0,0,0,0.04)",
  },
  onlineBadgeText: {
    fontSize: 10,
    fontWeight: "900",
    color: "rgba(0,0,0,0.55)",
    textTransform: "uppercase",
  },

  // SCORES
  scoreRowLandscape: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },
  scoreSideLandscape: { flexDirection: "row", alignItems: "center", flex: 1, gap: 8 },
  scoreSideLandscapeRight: { justifyContent: "flex-end" },

  scoreRowPortrait: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },
  inputsRowPortrait: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    marginTop: 4,
    marginBottom: 2,
    justifyContent: "space-between",
  },
  lastRowPortrait: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },

  scoreBigLeft: { color: "#2f6f18", fontWeight: "900", fontSize: 54, letterSpacing: 1 },
  scoreBigRight: { color: "#2f6f18", fontWeight: "900", fontSize: 54, letterSpacing: 1 },

  lastMiniLeft: {
    color: "rgba(0,0,0,0.45)",
    fontWeight: "900",
    fontSize: 28,
    width: 60,
    textAlign: "left",
  },
  lastMiniRight: {
    color: "rgba(0,0,0,0.45)",
    fontWeight: "900",
    fontSize: 28,
    width: 60,
    textAlign: "right",
  },

  // ✅ broadcast
  broadcastMid: { paddingHorizontal: 8 },
  broadcastMidPortrait: { width: 60, alignItems: "center", justifyContent: "center" },
  broadcastIconWrap: {
    width: 48,
    height: 48,
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  broadcastIcon: { width: 28, height: 28, resizeMode: "contain" },
  broadcastIconIdle: { tintColor: "rgba(0,0,0,0.55)" },
  broadcastIconActive: { tintColor: "#2f6f18" },
  broadcastBoardNr: {
    position: "absolute",
    top: 10,
    left: 0,
    right: 0,
    bottom: 0,
    textAlign: "center",
    textAlignVertical: "center",
    fontSize: 14,
    fontWeight: "bold",
    color: "red",
    zIndex: 10,
    elevation: 10,
  },

  // INPUTS
  inputBoxWrap: { width: 92 },
  inputLeft: { alignItems: "flex-start" },
  inputRight: { alignItems: "flex-end" },
  input: {
    width: 92,
    backgroundColor: "#ffffff",
    borderWidth: 2,
    borderColor: "rgba(0,0,0,0.18)",
    borderRadius: 10,
    paddingVertical: 6,
    textAlign: "center",
    fontSize: 22,
    fontWeight: "900",
    color: "rgba(0,0,0,0.85)",
  },
  inputVisible: { opacity: 1 },
  inputHidden: { opacity: 0 },

  // KEYBOARD
  keyboardArea: { flex: 1, paddingHorizontal: 6, paddingTop: 4, paddingBottom: 2 },
  keyboard: { flex: 1 },
  kRowFlex: { flex: 1, flexDirection: "row", gap: 6, marginBottom: 6 },
  keyFlex: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: "#f3d49b",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.12)",
  },
  keyAction: { backgroundColor: "#7a5b22" },
  keyQuick: { backgroundColor: "#c9b07a" },
  keyText: { color: "#b3422a", fontWeight: "900", fontSize: 26 },
  keyTextAction: { color: "rgba(255,255,255,0.92)", fontSize: 18 },

  // BOTTOM BAR
  statsBar: { paddingHorizontal: 6, paddingBottom: 6, paddingTop: 4, backgroundColor: "#ffffff" },
  statsBarInner: { alignItems: "center", gap: 8 },
  statsEdgeSpacer: { width: 66 },
  statChip: {
    height: 34,
    borderRadius: 10,
    backgroundColor: "rgba(74,13,13,0.10)",
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  statChipText: { color: "rgba(74,13,13,0.85)", fontWeight: "900" },
  statChipLabel: { color: "rgba(74,13,13,0.45)" },

  // FLOATING CORNERS
  cornerCheck: {
    position: "absolute",
    left: 6,
    bottom: 6,
    width: 64,
    height: 64,
    borderRadius: 999,
    backgroundColor: "#2f6f18",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 999,
    elevation: 5,
  },
  cornerMenu: {
    position: "absolute",
    right: 6,
    bottom: 6,
    width: 64,
    height: 64,
    borderRadius: 999,
    backgroundColor: "#2f6f18",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 999,
    elevation: 5,
  },
  cornerText: { color: "#ffffff", fontWeight: "900", fontSize: 22 },
  cornerCheckText: { color: "#ffffff", fontWeight: "900", fontSize: 16 },

  // MODALS
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCard: { width: "92%", maxWidth: 360, backgroundColor: "#fff", borderRadius: 14, padding: 14 },
  modalTitle: { fontWeight: "900", fontSize: 18, marginBottom: 10, color: "rgba(0,0,0,0.85)" },
  modalLabel: { fontWeight: "800", color: "rgba(0,0,0,0.6)", marginTop: 6, marginBottom: 4 },
  modalInput: {
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.2)",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontWeight: "800",
    color: "rgba(0,0,0,0.85)",
  },

  boardPickGrid: {
    marginTop: 10,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 2,
    justifyContent: "space-between",
  },
  boardPickCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
  },
  boardPickCircleOff: { borderColor: "rgba(0,0,0,0.18)", backgroundColor: "rgba(0,0,0,0.04)" },
  boardPickCircleOn: { borderColor: "#2f6f18", backgroundColor: "rgba(47,111,24,0.12)" },

  // ✅ dim (de nem disabled!)
  boardPickCircleDim: {
    opacity: 0.35,
  },

  boardPickText: { fontWeight: "900", fontSize: 13 },
  boardPickTextOff: { color: "rgba(0,0,0,0.6)" },
  boardPickTextOn: { color: "#2f6f18" },
  boardPickTextDim: { color: "rgba(0,0,0,0.45)" },

  modalHintSmall: { marginTop: 10, color: "rgba(63, 63, 63, 0.45)", fontWeight: "800", fontSize: 12 },

  namesGap: { height: 10 },
  namesBlock: { position: "relative", paddingRight: 52 },
  menuBoardPickerWrap: { marginTop: 10 },

  swapBtnBetween: {
    position: "absolute",
    right: 8,
    top: "50%",
    marginTop: -20,
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  swapBtnText: {
    fontSize: 20,
    fontWeight: "900",
    color: "rgba(0,0,0,0.6)",
    transform: [{ rotate: "90deg" }, { translateY: -3 }],
  },

  modalBtns: { flexDirection: "row", gap: 10, marginTop: 12 },
  modalBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  modalBtnGhost: { backgroundColor: "rgba(0,0,0,0.08)" },
  modalBtnOk: { backgroundColor: "#2f6f18" },
  modalBtnTextGhost: { fontWeight: "900", color: "rgba(0,0,0,0.75)" },
  modalBtnTextOk: { fontWeight: "900", color: "#ffffff" },
  onlineInfoText: {
    marginTop: 10,
    marginBottom: 2,
    fontWeight: "900",
    color: "#b3422a",
  },
  exitInline: { marginTop: 14, alignItems: "center" },
  exitInlineText: {
    color: "rgba(0,0,0,0.55)",
    fontWeight: "900",
    textDecorationLine: "underline",
  },

  checkoutRow: { flexDirection: "row", gap: 10, marginTop: 10, marginBottom: 12 },
  checkoutBtn: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  checkoutText: { color: "white", fontWeight: "900", fontSize: 22 },
});