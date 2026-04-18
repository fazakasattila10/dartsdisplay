import { useKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { onValue, push, ref } from "firebase/database";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DimensionValue, StyleProp, ViewStyle } from "react-native";

import {
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { db } from "../../lib/firebase";
import HistoryScreen from "./HistoryScreen";
import KrikettScreen from "./KrikettScreen";
import ScoringScreen2 from "./ScoringScreen2";
import { addWatchedId, getDistanceMeters, getOrCreateDeviceId, getSavedWatchedIds, parseBoardIdFromText, requestBrowserLikeLocation, saveWatchedIds } from "./broadcastShared";

type BoardData = {
  raw: string;
  parts: string[];
  timestamp: number; // millis
};

const DEFAULT_CLUB_ID = "";
const BOARD_NRS = [1, 2, 3, 4, 5, 6, 7, 8];

// freshness
const FRESH_LIMIT_MS = 2 * 60 * 1000; // 2 minutes
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // check every 2 perc
const STALE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

// colors
const ACCENT_SCORE = "#b38f00";
// const ACCENT_LEGS = "#326b15";
const ACCENT_LEGS = "rgba(61,255,47,0.42)";

const CARD_BG_A = "#2f2e2d";
const CARD_BG_B = "#2f2e2d";

const BADGE_BG = "#1E1C1F";
const BADGE_TEXT_DEFAULT = "#99949494";
const FULL_ICON = "#99949494";

const BADGE_ACTIVE_BG = "#3DFF2F";
const BADGE_ACTIVE_TEXT = "#0B2E00";

// club chip colors
const CLUB_CHIP_BG = "rgba(0,0,0,0.85)";
const CLUB_CHIP_BORDER = "#b38f00";
// const CLUB_CHIP_BORDER = "rgba(255,255,255,0.18)";
const CLUB_CHIP_TEXT = "rgba(255,255,255,0.82)";

// global font zoom
const FONT_ZOOM_MIN = 0.1;
const FONT_ZOOM_MAX = 2.5;
const FONT_ZOOM_STEP = 0.2;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function scaleFont(size: number, zoom: number) {
  return Math.round(size * zoom * 10) / 10;
}

function parseBoard(raw: unknown): BoardData {
  const safe = raw == null ? "" : String(raw).trim();
  const parts = safe ? safe.split("_") : [];

  let ts = 0;
  if (parts.length > 0) {
    const maybe = Number(parts[parts.length - 1]);
    if (!Number.isNaN(maybe) && Number.isFinite(maybe)) ts = maybe;
  }

  return { raw: safe || "—", parts, timestamp: ts };
}

function getPart(parts: string[], idx: number, fallback: string = "—"): string {
  const v = parts[idx];
  return v == null || v === "" ? fallback : v;
}

function isCricketBoardData(data: BoardData) {
  return data.parts[0] === "cricket";
}

function parseCricketBoard(parts: string[]) {
  if (parts[0] !== "cricket") return null;
  const playerCount = Math.max(0, Math.min(8, Number(parts[1]) || 0));
  const players: Array<{
    name: string;
    wins: string;
    points: string;
    m20: string;
    m19: string;
    m18: string;
    m17: string;
    m16: string;
    m15: string;
    bull: string;
  }> = [];

  let offset = 2;
  for (let i = 0; i < playerCount; i += 1) {
    players.push({
      name: getPart(parts, offset + 0),
      wins: getPart(parts, offset + 1, "0"),
      points: getPart(parts, offset + 2, "0"),
      m20: getPart(parts, offset + 3, "0"),
      m19: getPart(parts, offset + 4, "0"),
      m18: getPart(parts, offset + 5, "0"),
      m17: getPart(parts, offset + 6, "0"),
      m16: getPart(parts, offset + 7, "0"),
      m15: getPart(parts, offset + 8, "0"),
      bull: getPart(parts, offset + 9, "0"),
    });
    offset += 10;
  }

  return { players, round: getPart(parts, offset, "1") };
}

function marksToSlashesDisplay(v: string) {
  const n = Math.max(0, Math.min(3, Number(v) || 0));
  return "/".repeat(n);
}
function getWindowSearch(): string {
  try {
    if (typeof window === 'undefined') return '';
    const search = (window as any)?.location?.search;
    return typeof search === 'string' ? search : '';
  } catch {
    return '';
  }
}
function ensureDocFullscreen() {
  if (typeof document === "undefined") return Promise.resolve();
  if (document.fullscreenElement) return Promise.resolve();
  return document.documentElement.requestFullscreen?.() ?? Promise.resolve();
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
    supported: typeof navigator !== "undefined" && "wakeLock" in navigator,
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
    if (typeof window === "undefined" || typeof document === "undefined") return false;
    if (!("wakeLock" in navigator)) {
      setState({ supported: false, active: false, error: null });
      return false;
    }
    if (document.visibilityState !== "visible") return false;
    if (sentinelRef.current && !sentinelRef.current.released) {
      setState((prev) => ({ ...prev, supported: true, active: true, error: null }));
      return true;
    }
    if (requestInFlightRef.current) return false;

    requestInFlightRef.current = true;
    try {
      const wakeLockApi = (navigator as Navigator & {
        wakeLock?: { request?: (type: "screen") => Promise<WakeLockSentinelLike> };
      }).wakeLock;

      const sentinel = await wakeLockApi?.request?.("screen");
      if (!sentinel) {
        setState({ supported: true, active: false, error: "Wake lock not granted." });
        return false;
      }

      const handleRelease = () => {
        sentinelRef.current = null;
        setState((prev) => ({ ...prev, active: false }));
      };

      sentinel.addEventListener?.("release", handleRelease);
      sentinelRef.current = sentinel;
      setState({ supported: true, active: true, error: null });
      return true;
    } catch (err: any) {
      setState({
        supported: true,
        active: false,
        error: err?.message ?? "Wake lock request failed.",
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

    document.addEventListener("visibilitychange", retry);
    window.addEventListener("focus", retry);
    window.addEventListener("pageshow", retry);
    window.addEventListener("pointerdown", retry, { passive: true });
    window.addEventListener("touchstart", retry, { passive: true });
    window.addEventListener("keydown", retry);

    return () => {
      document.removeEventListener("visibilitychange", retry);
      window.removeEventListener("focus", retry);
      window.removeEventListener("pageshow", retry);
      window.removeEventListener("pointerdown", retry);
      window.removeEventListener("touchstart", retry);
      window.removeEventListener("keydown", retry);
      void releaseWakeLock();
    };
  }, [enabled, releaseWakeLock, requestWakeLock]);

  return state;
}
const CURRENT_VERSION_CODE = 1;

function loadClubId(): string {
  try {
    if (typeof window === "undefined") return DEFAULT_CLUB_ID;
    const v = window.localStorage.getItem("clubId");
    return v && v.trim() ? v.trim().toLowerCase() : DEFAULT_CLUB_ID;
  } catch {
    return DEFAULT_CLUB_ID;
  }
}

function saveClubId(v: string) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("clubId", v);
  } catch {}
}

function loadDismissedMessage(clubId: string): string {
  try {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(`dismissedMessage:${clubId}`) ?? "";
  } catch {
    return "";
  }
}

function saveDismissedMessage(clubId: string, v: string) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(`dismissedMessage:${clubId}`, v);
  } catch {}
}

function toImageUri(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";

  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:image\//i.test(s)) return s;

  return `data:image/jpeg;base64,${s}`;
}
function CricketMarkBox(props: {
  label: string;
  marks: string;
  fontZoom: number;
  isFullscreen: boolean;
}) {
  const z = props.fontZoom;
  const marks = Math.max(0, Math.min(3, Number(props.marks) || 0));
  const fillWidth: DimensionValue = `${(marks / 3) * 100}%`;

  const labelFontSize = scaleFont(props.isFullscreen ? 16 : 11, z);

  return (
    <View
      style={[
        styles.cricketMarkChip,
        {
          paddingVertical: props.isFullscreen ? 7 : 4,
          paddingHorizontal: props.isFullscreen ? 20 : 12,
          minWidth: labelFontSize * (props.label === "B." ? 4.7 : 4.7),
        },
      ]}
    >
      <View style={styles.cricketMarkChipBg}>
        {marks > 0 ? (
          <View style={[styles.cricketMarkChipFill, { width: fillWidth }]} />
        ) : null}

        <View style={[styles.cricketMarkDivider, styles.cricketMarkDivider1]} />
        <View style={[styles.cricketMarkDivider, styles.cricketMarkDivider2]} />
      </View>

      <Text
        style={[
          styles.cricketMarkChipLabelCentered,
          { fontSize: labelFontSize, lineHeight: labelFontSize * 1.05 },
        ]}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </View>
  );
}
function BoardCard(props: {
  boardNr: number;
  data: BoardData;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onSaveHistory?: () => void;
  onUiAction: () => void;
  isAlt?: boolean;
  isFresh: boolean;
  isStale: boolean;
  fontZoom: number;
}) {
  const hasData = !props.isStale && props.data.raw !== "—" && props.data.raw !== "";
  const parts = props.data.parts;
  const z = props.fontZoom;
  const isCricket = isCricketBoardData(props.data);

  const nameL = getPart(parts, 0);
  const nameR = getPart(parts, 1);
  const scoreL = getPart(parts, 2);
  const scoreR = getPart(parts, 3);
  const lastL = getPart(parts, 4);
  const lastR = getPart(parts, 5);
  const legsL = getPart(parts, 8);
  const legsR = getPart(parts, 9);
  const avgX3L = getPart(parts, 12);
  const avgX3R = getPart(parts, 13);

  const badgeBgStyle = props.isFresh ? { backgroundColor: BADGE_ACTIVE_BG } : { backgroundColor: BADGE_BG };
  const badgeGlowStyle = props.isFresh
    ? {
        shadowColor: BADGE_ACTIVE_BG,
        shadowOpacity: 0.9,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 0 },
        elevation: 6,
      }
    : null;
  const badgeTextStyle = props.isFresh ? { color: BADGE_ACTIVE_TEXT } : { color: BADGE_TEXT_DEFAULT };
  const cricket = isCricket ? parseCricketBoard(parts) : null;

  return (
    <View
      style={[
        styles.card,
        props.isAlt ? styles.cardAlt : styles.cardBase,
        props.isFullscreen ? styles.cardFullscreen : styles.cardGrid,
      ]}
    >
      <View style={styles.cardHeader}>
        {/* {props.onSaveHistory ? (
          <Pressable
            onPress={() => {
              props.onUiAction();
              props.onSaveHistory?.();
            }}
            hitSlop={10}
          >
            <View style={[styles.boardBadge, badgeBgStyle, badgeGlowStyle]}>
              <Text style={[styles.boardBadgeText, badgeTextStyle, { fontSize: scaleFont(13, z) }]}> 
                {props.boardNr > 0 ? props.boardNr : ''}
              </Text>
            </View>
          </Pressable>
        ) : (
          <View style={[styles.boardBadge, badgeBgStyle, badgeGlowStyle]}>
            <Text style={[styles.boardBadgeText, badgeTextStyle, { fontSize: scaleFont(13, z) }]}> 
              {props.boardNr > 0 ? props.boardNr : ''}
            </Text>
          </View>
        )} */}
        <View>
            <Text> 
              ""
            </Text>
          </View>
        <Pressable
          onPress={() => {
            props.onUiAction();
            props.onToggleFullscreen();
          }}
          hitSlop={12}
          style={({ pressed }) => (pressed ? styles.fullBtnPressed : null)}
        >
          <Text style={[styles.fullIcon, { fontSize: scaleFont(22, z), lineHeight: scaleFont(24, z) }]}>⛶</Text>
        </Pressable>
      </View>

      {!hasData ? (
        <Text style={[styles.emptyText, { fontSize: scaleFont(14, z) }]}>No action on this board in the last hour.</Text>
      ) : isCricket && cricket ?  (
          <View style={styles.bodyWrap}>
            <View
              style={[
                styles.cricketPlayersRow,
                cricket.players.length === 2
                  ? styles.cricketPlayersRow2
                  : cricket.players.length === 3
                    ? styles.cricketPlayersRow3
                    : styles.cricketPlayersRow4,
              ]}
            >
              {cricket.players.map((player, idx) => (
                <React.Fragment key={`cricket-${idx}`}>
                  {idx === 0 ? null : <View style={styles.cricketGap} />}

                  <View style={styles.cricketPlayerCol}>
                  <View style={styles.cricketPlayerHeader}>
                    <Text
                      style={[
                        styles.cricketPlayerName,
                        { fontSize: scaleFont(props.isFullscreen ? 26 : 14, z) },
                      ]}
                      numberOfLines={1}
                    >
                      {player.name}
                    </Text>

                    <Text
                      style={[
                        styles.cricketPlayerWinsInline,
                        { fontSize: scaleFont(props.isFullscreen ? 26 : 14, z) },
                      ]}
                      numberOfLines={1}
                    >
                      {player.wins}
                    </Text>
                  </View>

                  <Text
                    style={[
                      styles.cricketPlayerPoints,
                      { fontSize: scaleFont(props.isFullscreen ? 34 : 18, z) },
                    ]}
                  >
                    {player.points}
                  </Text>

                  <View
                    style={[
                      styles.cricketMarksStack,
                      props.isFullscreen ? styles.cricketMarksStackLarge : null,
                    ]}
                  >
                      <CricketMarkBox label="20" marks={player.m20} fontZoom={z} isFullscreen={props.isFullscreen} />
                      <CricketMarkBox label="19" marks={player.m19} fontZoom={z} isFullscreen={props.isFullscreen} />
                      <CricketMarkBox label="18" marks={player.m18} fontZoom={z} isFullscreen={props.isFullscreen} />
                      <CricketMarkBox label="17" marks={player.m17} fontZoom={z} isFullscreen={props.isFullscreen} />
                      <CricketMarkBox label="16" marks={player.m16} fontZoom={z} isFullscreen={props.isFullscreen} />
                      <CricketMarkBox label="15" marks={player.m15} fontZoom={z} isFullscreen={props.isFullscreen} />
                      <CricketMarkBox label="B." marks={player.bull} fontZoom={z} isFullscreen={props.isFullscreen} />
                    </View>
                  </View>
                </React.Fragment>
              ))}
            </View>
          </View>
        ) : (
        <View style={styles.bodyWrap}>
          <ScrollView showsVerticalScrollIndicator={false} overScrollMode="never" bounces={false} contentContainerStyle={{ paddingBottom: 40 }}>
            <View style={styles.nameLegsRow}>
              <Text style={[styles.nameBig, { fontSize: scaleFont(props.isFullscreen ? 32 : 16, z) }]} numberOfLines={1}>{nameL}</Text>
              <View style={[styles.legsCenter, props.isFullscreen ? styles.legsCenterFs : null]}>
                <Text style={[styles.legsBig, { fontSize: scaleFont(props.isFullscreen ? 52 : 26, z), lineHeight: scaleFont(props.isFullscreen ? 56 : 28, z) }]} numberOfLines={1}>{legsL}-{legsR}</Text>
              </View>
              <Text style={[styles.nameBig, styles.rightAlign, { fontSize: scaleFont(props.isFullscreen ? 32 : 16, z) }]} numberOfLines={1}>{nameR}</Text>
            </View>
            <View style={styles.scoresRow}>
              <Text style={[styles.scoreBig, { fontSize: scaleFont(props.isFullscreen ? 72 : 36, z) }]} numberOfLines={1}>{scoreL}</Text>
              <Text style={[styles.scoreBig, styles.rightAlign, { fontSize: scaleFont(props.isFullscreen ? 72 : 36, z) }]} numberOfLines={1}>{scoreR}</Text>
            </View>
            <View style={styles.lastRow}>
              <Text style={[styles.lastText, { fontSize: scaleFont(props.isFullscreen ? 44 : 22, z) }]} numberOfLines={1}>{lastL}</Text>
              <Text style={[styles.lastText, styles.rightAlign, { fontSize: scaleFont(props.isFullscreen ? 44 : 22, z) }]} numberOfLines={1}>{lastR}</Text>
            </View>
            <View style={styles.avgX3Row}>
              <Text style={[styles.avgX3Val, props.isFullscreen ? styles.avgX3ValFsFill : null, { fontSize: scaleFont(props.isFullscreen ? 44 : 22, z) }]} numberOfLines={1}>{avgX3L}</Text>
              <Text style={[styles.avgX3Label, props.isFullscreen ? styles.avgX3LabelFsFill : null, !props.isFullscreen ? styles.avgX3LabelFill : null, { fontSize: scaleFont(props.isFullscreen ? 28 : 14, z) }]} numberOfLines={1}>Avg.x3</Text>
              <Text style={[styles.avgX3Val, styles.rightAlign, props.isFullscreen ? styles.avgX3ValFsFill : null, { fontSize: scaleFont(props.isFullscreen ? 44 : 22, z) }]} numberOfLines={1}>{avgX3R}</Text>
            </View>
            <View style={styles.divider} />
            <StatRow left={getPart(parts, 6)} label="Throws" right={getPart(parts, 7)} fontZoom={z} />
            <StatRow left={getPart(parts, 10)} label="Avg." right={getPart(parts, 11)} fontZoom={z} />
            <StatRow left={getPart(parts, 14)} label="100+" right={getPart(parts, 15)} fontZoom={z} />
            <StatRow left={getPart(parts, 16)} label="140+" right={getPart(parts, 17)} fontZoom={z} />
            <StatRow left={getPart(parts, 18)} label="180+" right={getPart(parts, 19)} fontZoom={z} />
            <StatRow left={getPart(parts, 20)} label="H.out" right={getPart(parts, 21)} fontZoom={z} />
            <View style={{ height: 70 }} />
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function StatRow(props: { left: string; label: string; right: string; fontZoom: number }) {
  const z = props.fontZoom;

  return (
    <View style={styles.statRow}>
      <Text style={[styles.statValLeft, { fontSize: scaleFont(15, z) }]} numberOfLines={1}>
        {props.left}
      </Text>

      <Text style={[styles.statLabel, { fontSize: scaleFont(14, z) }]} numberOfLines={1}>
        {props.label}
      </Text>

      <Text style={[styles.statValRight, { fontSize: scaleFont(15, z) }]} numberOfLines={1}>
        {props.right}
      </Text>
    </View>
  );
}

export default function HomeScreen() {

if (Platform.OS !== 'web') {
    useKeepAwake();
  }
  const insets = useSafeAreaInsets();
  const [showStartupLocationDialog, setShowStartupLocationDialog] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
const [updateTitle, setUpdateTitle] = useState('Update available');
const [updateMessage, setUpdateMessage] = useState('');
const [updateStoreUrl, setUpdateStoreUrl] = useState('');
const analyticsDeviceIdRef = useRef<string>(getOrCreateDeviceId());

const trackAnalyticsClick = useCallback(async (clickType: string, extraInfo: string = '') => {
  try {
    await push(ref(db, 'analyticsClicks'), {
      deviceId: analyticsDeviceIdRef.current,
      timestamp: Date.now(),
      extraInfo,
      clickType,
    });
  } catch {}
}, []);
const startupLocationAskedRef = useRef(false);
  const { width, height } = useWindowDimensions();
  const isPortrait = height >= width;
  const [mode, setMode] = useState<"display" | "scoring" | "cricket" | "history">(() => {
  const parsed = parseBoardIdFromText(getWindowSearch());
    return parsed ? 'display' : 'scoring';
    });
  const [displayReturnMode, setDisplayReturnMode] = useState<"scoring" | "cricket">('scoring');
  const [fullscreenBoardId, setFullscreenBoardId] = useState<string | null>(() => {
    return parseBoardIdFromText(getWindowSearch());
  });
  const [watchedIds, setWatchedIds] = useState<string[]>(() => getSavedWatchedIds());
  const [locationCoords, setLocationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [allBoards, setAllBoards] = useState<Record<string, { id: string; raw: string; data: BoardData; lat: number | null; lng: number | null; deviceId: string | null; timestamp: number }>>({});
  const [fontZoom, setFontZoom] = useState(1);
  const [showHud, setShowHud] = useState(true);
  const [displayLayout, setDisplayLayout] = useState<'grid' | 'list'>('grid');
  const [showFontSlider, setShowFontSlider] = useState(false);
  const wakeLock = useDisplayWakeLock(mode === 'display');
  const [showGameMenu, setShowGameMenu] = useState(false);
  const gameMode = mode === 'cricket' ? 'cricket' : 'scoring';
  const [scoringOpenNewKey, setScoringOpenNewKey] = useState<number | undefined>(undefined);
  const [cricketOpenNewKey, setCricketOpenNewKey] = useState<number | undefined>(undefined);
  const [scoringReplayKey, setScoringReplayKey] = useState<number | undefined>(undefined);
  const [cricketReplayKey, setCricketReplayKey] = useState<number | undefined>(undefined);
  const pinchStartZoomRef = useRef(1);
  useEffect(() => { saveWatchedIds(watchedIds); }, [watchedIds]);
useEffect(() => {
  if (Platform.OS === "web") {
    void requestBrowserLikeLocation().then((coords) => {
      setLocationCoords(coords);
    });
    return;
  }

  if (Platform.OS !== "android") {
    return;
  }

  if (startupLocationAskedRef.current) {
    return;
  }

  startupLocationAskedRef.current = true;

  void (async () => {
    try {
      const current = await Location.getForegroundPermissionsAsync();

      if (current.status === "granted") {
        const lastKnown = await Location.getLastKnownPositionAsync();
        if (lastKnown?.coords) {
          setLocationCoords({
            lat: lastKnown.coords.latitude,
            lng: lastKnown.coords.longitude,
          });
          return;
        }

        const currentPos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        setLocationCoords({
          lat: currentPos.coords.latitude,
          lng: currentPos.coords.longitude,
        });
        return;
      }

      if (current.status === "denied" && !current.canAskAgain) {
        return;
      }

      setShowStartupLocationDialog(true);
    } catch {}
  })();
}, []);
useEffect(() => {
  const updateRef = ref(db, "appConfig/update");

  const unsub = onValue(updateRef, (snap) => {
    const value = snap.val();
    const enabled = !!value?.enabled;
    const minVersionCode = Number(value?.minVersionCode) || 0;
    const title = String(value?.title || "Update available");
    const message = String(value?.message || "");
    const storeUrl = String(value?.storeUrl || "");

    if (enabled && minVersionCode > CURRENT_VERSION_CODE && message && storeUrl) {
      setUpdateTitle(title);
      setUpdateMessage(message);
      setUpdateStoreUrl(storeUrl);
      setShowUpdateDialog(true);
      return;
    }

    setShowUpdateDialog(false);
  });

  return () => unsub();
}, []);
  useEffect(() => {
    const unsub = onValue(ref(db, 'boards'), (snap) => {
      const value = snap.val() || {};
      const next: Record<string, any> = {};
      Object.entries(value).forEach(([id, rec]: any) => {
        const raw = String(rec?.stats || '').trim();
        next[String(id)] = {
          id: String(id),
          raw,
          data: parseBoard(raw),
          lat: typeof rec?.lat === 'number' ? rec.lat : null,
          lng: typeof rec?.lng === 'number' ? rec.lng : null,
          deviceId: rec?.deviceId ? String(rec.deviceId) : null,
          timestamp: Number(rec?.timestamp) || 0,
        };
      });
      setAllBoards(next);
    });
    return () => unsub();
  }, []);

  const visibleBoards = useMemo(() => {
    const now = Date.now();
    const watched = new Set(watchedIds);
    return Object.values(allBoards)
      .filter((b: any) => {
        const fresh = !!b.timestamp && now - b.timestamp <= 20 * 60 * 1000;
        if (!fresh) return false;
        if (watched.has(b.id)) return true;
        if (!locationCoords || b.lat == null || b.lng == null) return false;
        return getDistanceMeters(locationCoords.lat, locationCoords.lng, b.lat, b.lng) <= 100;
      })
      .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
  }, [allBoards, watchedIds, locationCoords]);
const toggleHud = useCallback(() => {
  setShowHud((v) => !v);
}, []);
  useEffect(() => {
    if (fullscreenBoardId) addWatchedId(fullscreenBoardId);
  }, [fullscreenBoardId]);
  const displayTapGesture = useMemo(
  () =>
    Gesture.Tap().onEnd(() => {
      runOnJS(toggleHud)();
    }),
  [toggleHud]
);
  const displayPinchGesture = useMemo(
  () =>
    Gesture.Pinch()
      .onBegin(() => {
        pinchStartZoomRef.current = fontZoom;
      })
      .onUpdate((event) => {
        const nextZoom = clamp(
          pinchStartZoomRef.current * event.scale,
          FONT_ZOOM_MIN,
          FONT_ZOOM_MAX
        );
        setFontZoom(nextZoom);
      }),
  [fontZoom]
);
const displayGesture = useMemo(
  () => Gesture.Simultaneous(displayPinchGesture, displayTapGesture),
  [displayPinchGesture, displayTapGesture]
);

  const replayCurrentGame = useCallback(() => {
  void trackAnalyticsClick('menu_re_match', gameMode);
  setShowGameMenu(false);

  if (gameMode === 'scoring') {
    setScoringReplayKey((v) => (v ?? 0) + 1);
    return;
  }

  setCricketReplayKey((v) => (v ?? 0) + 1);
}, [gameMode, trackAnalyticsClick]);

  const closeGameMenu = useCallback(() => {
    setShowGameMenu(false);
  }, []);
  const handleRootExit = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) window.history.back();
  }, []);

const openScoringNewGame = useCallback(() => {
  // void trackAnalyticsClick('menu_new_501');
  setShowGameMenu(false);
  setMode('scoring');
  setScoringOpenNewKey((v) => (v ?? 0) + 1);
}, [trackAnalyticsClick]);

const openCricketNewGame = useCallback(() => {
  // void trackAnalyticsClick('menu_new_cricket');
  setShowGameMenu(false);
  setMode('cricket');
  setCricketOpenNewKey((v) => (v ?? 0) + 1);
}, [trackAnalyticsClick]);
const clearGameTriggers = useCallback(() => {
  setScoringOpenNewKey(undefined);
  setCricketOpenNewKey(undefined);
  setScoringReplayKey(undefined);
  setCricketReplayKey(undefined);
}, []);
const openDisplayFrom = useCallback((from: 'scoring' | 'cricket') => {
  void trackAnalyticsClick('menu_big_display', from);
  setShowGameMenu(false);
  clearGameTriggers();
  setDisplayReturnMode(from);
  setFullscreenBoardId(null);
  setMode('display');
}, [clearGameTriggers, trackAnalyticsClick]);

const openDisplayById = useCallback((id: string, from?: 'scoring' | 'cricket') => {
  const nextId = String(id || '').trim().toUpperCase();
  if (!nextId) return;
  clearGameTriggers();
  addWatchedId(nextId);
  setWatchedIds((prev) => (prev.includes(nextId) ? prev : [nextId, ...prev]));
  if (from) setDisplayReturnMode(from);
  setFullscreenBoardId(nextId);
  setMode('display');
}, [clearGameTriggers]);

const goBackFromDisplay = useCallback(() => {
  if (fullscreenBoardId) {
    setFullscreenBoardId(null);
    return;
  }
  clearGameTriggers();
  setMode(displayReturnMode);
}, [clearGameTriggers, displayReturnMode, fullscreenBoardId]);

  const currentFullscreenEntry = fullscreenBoardId ? allBoards[fullscreenBoardId] : null;
const displayBoards = fullscreenBoardId ? (currentFullscreenEntry ? [currentFullscreenEntry] : []) : visibleBoards;

const canUseGridLayout = displayBoards.length <= 8;
const effectiveDisplayLayout: 'grid' | 'list' =
  !fullscreenBoardId && canUseGridLayout ? displayLayout : 'list';

const gridSlotCount =
  displayBoards.length <= 4 ? 4 : displayBoards.length <= 8 ? 8 : 0;

const paddedGridBoards: Array<(typeof displayBoards)[number] | null> =
  effectiveDisplayLayout === 'grid'
    ? [...displayBoards, ...Array(Math.max(0, gridSlotCount - displayBoards.length)).fill(null)]
    : [];

const gridItemStyle = useMemo<StyleProp<ViewStyle>>(
  () => [
    styles.gridItemBase,
    {
      width: fullscreenBoardId ? ('100%' as any) : '25%',
      height: fullscreenBoardId ? ('100%' as any) : undefined,
    },
  ],
  [fullscreenBoardId]
);
if (mode === 'scoring' || mode === 'cricket') {
  return (
    <View style={styles.safe}>
      {gameMode === 'scoring' ? (
       <ScoringScreen2
          clubId=""
          onExit={handleRootExit}
          onOpenCricket={openCricketNewGame}
          onOpenDisplay={() => openDisplayFrom('scoring')}
          onOpenDisplayById={(id) => openDisplayById(id, 'scoring')}
          openNewGameRequestKey={scoringOpenNewKey}
          replayRequestKey={scoringReplayKey}
        />
      ) : (
        <KrikettScreen
          clubId=""
          onExit={handleRootExit}
          onOpenScoring={openScoringNewGame}
          onOpenDisplay={() => openDisplayFrom('cricket')}
          onOpenDisplayById={(id) => openDisplayById(id, 'cricket')}
          openNewGameRequestKey={cricketOpenNewKey}
          replayRequestKey={cricketReplayKey}
        />
      )}

      
      <Pressable
        style={[
          styles.rootCornerMenu,
          { right: 2 + insets.right, bottom: 2 + insets.bottom }
        ]}
        onPress={() => setShowGameMenu((v) => !v)}
      >
        <Text style={styles.rootCornerMenuText}>☰</Text>
      </Pressable>
      <Modal
        visible={showGameMenu}
        transparent
        animationType="fade"
        onRequestClose={closeGameMenu}
      >
        <Pressable style={styles.quickMenuOverlay} onPress={closeGameMenu}>
          <View style={styles.quickMenuCard}>
            <Pressable style={styles.quickMenuItem} onPress={openScoringNewGame}>
              <Text style={styles.quickMenuItemText}>
                {gameMode === 'scoring' ? 'new 501' : '501'}
              </Text>
            </Pressable>

            <Pressable style={styles.quickMenuItem} onPress={openCricketNewGame}>
              <Text style={styles.quickMenuItemText}>
                {gameMode === 'cricket' ? 'new Cricket' : 'Cricket'}
              </Text>
            </Pressable>
            <Pressable
              style={styles.quickMenuItem}
              onPress={() => openDisplayFrom(gameMode)}
            >
              <Text style={styles.quickMenuItemText}>Big Display</Text>
            </Pressable>
            <Pressable
              style={styles.quickMenuItem}
              onPress={replayCurrentGame}
            >
              <Text style={styles.quickMenuItemText}>re-match</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
      <Modal
  visible={showStartupLocationDialog}
  transparent
  animationType="fade"
  onRequestClose={() => setShowStartupLocationDialog(false)}
>
  <Pressable
    style={styles.modalOverlay}
    onPress={() => setShowStartupLocationDialog(false)}
  >
    <Pressable style={styles.modalCard} onPress={() => {}}>
      <Text style={styles.modalTitle}>Location access</Text>

      <Text style={styles.modalLabel}>
        Allow location access so your board can appear on the big display when you use the app inside the club.
      </Text>

      <View style={styles.modalBtns}>
        <Pressable
          style={[styles.modalBtn, styles.modalBtnGhost]}
          onPress={() => setShowStartupLocationDialog(false)}
        >
          <Text style={styles.modalBtnTextGhost}>Not now</Text>
        </Pressable>

        <Pressable
          style={[styles.modalBtn, styles.modalBtnOk]}
          onPress={async () => {
            try {
              const asked = await Location.requestForegroundPermissionsAsync();

              if (asked.status === "granted") {
                const lastKnown = await Location.getLastKnownPositionAsync();
                if (lastKnown?.coords) {
                  setLocationCoords({
                    lat: lastKnown.coords.latitude,
                    lng: lastKnown.coords.longitude,
                  });
                } else {
                  const currentPos = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                  });

                  setLocationCoords({
                    lat: currentPos.coords.latitude,
                    lng: currentPos.coords.longitude,
                  });
                }
              }
            } catch {}

            setShowStartupLocationDialog(false);
          }}
        >
          <Text style={styles.modalBtnTextOk}>Continue</Text>
        </Pressable>
      </View>
    </Pressable>
  </Pressable>
</Modal>
{ <Modal
  visible={showUpdateDialog}
  transparent
  animationType="fade"
  onRequestClose={() => setShowUpdateDialog(false)}
>
  <View style={styles.modalOverlay}>
    <View style={styles.modalCard}>
      <Text style={styles.modalTitle}>{updateTitle}</Text>
      <Text style={styles.modalLabel}>{updateMessage}</Text>

      <View style={styles.modalBtns}>
        <Pressable
          style={[styles.modalBtn, styles.modalBtnGhost]}
          onPress={() => setShowUpdateDialog(false)}
        >
          <Text style={styles.modalBtnTextGhost}>LATER</Text>
        </Pressable>

        <Pressable
          style={[styles.modalBtn, styles.modalBtnOk]}
          onPress={() => {
            if (updateStoreUrl) {
              void Linking.openURL(updateStoreUrl);
            }
          }}
        >
          <Text style={styles.modalBtnTextOk}>UPDATE</Text>
        </Pressable>
      </View>
    </View>
  </View>
</Modal> }
    </View>
  );
}
if (mode === 'history') {
  return <HistoryScreen clubId="" onExit={() => setMode('display')} />;
}

  return (
    
    <View style={styles.safe}>
  <View style={[styles.screen, { padding: 8 }]}>
    <Pressable onPress={goBackFromDisplay} hitSlop={12} style={styles.displayBackChip}>
      <Text style={styles.displayBackChipText}>←</Text>
    </Pressable>

    {showHud ? (
      <View style={[styles.bottomLeftRow, { left: 10 + insets.left, bottom: 12 + insets.bottom }]}>
        {/* <Pressable onPress={() => setMode('history')} hitSlop={12} style={styles.scoringChip}>
          <Text style={[styles.clubChipText, { fontSize: scaleFont(13, fontZoom) }]}>history</Text>
        </Pressable> */}

        <Pressable
          onPress={() => setFontZoom((z) => clamp(z - FONT_ZOOM_STEP, FONT_ZOOM_MIN, FONT_ZOOM_MAX))}
          hitSlop={12}
          style={styles.scoringChip}
        >
          <Text style={[styles.clubChipText, { fontSize: scaleFont(13, fontZoom) }]}> - </Text>
        </Pressable>

        <Pressable
          onPress={() => setFontZoom((z) => clamp(z + FONT_ZOOM_STEP, FONT_ZOOM_MIN, FONT_ZOOM_MAX))}
          hitSlop={12}
          style={styles.scoringChip}
        >
          <Text style={[styles.clubChipText, { fontSize: scaleFont(13, fontZoom) }]}> + </Text>
        </Pressable>
      </View>
    ) : null}

    {showHud && !fullscreenBoardId ? (
      <Pressable
        style={[styles.layoutToggleBtn, { right: 10 + insets.right, bottom: 12 + insets.bottom }]}
        onPress={() => {
          if (!canUseGridLayout) {
            setDisplayLayout('list');
            return;
          }
          setDisplayLayout((v) => (v === 'grid' ? 'list' : 'grid'));
        }}
        hitSlop={12}
      >
        <Text style={styles.layoutToggleBtnText}>
          {effectiveDisplayLayout === 'grid' ? '☷' : '▦'}
        </Text>
      </Pressable>
    ) : null}

    <GestureDetector gesture={displayGesture}>
      <View style={styles.displayGestureArea}>
        {fullscreenBoardId ? (
          currentFullscreenEntry ? (
            <BoardCard
              boardNr={0}
              data={currentFullscreenEntry.data}
              isFullscreen={true}
              onToggleFullscreen={() => setFullscreenBoardId(null)}
              onUiAction={() => {}}
              isFresh={true}
              isStale={false}
              fontZoom={fontZoom}
            />
          ) : (
            <View style={[styles.card, styles.cardBase, styles.cardFullscreen, { alignItems: 'center', justifyContent: 'center' }]}>
              <Text style={styles.emptyText}>No live data for this board.</Text>
            </View>
          )
        ) : (
          <ScrollView contentContainerStyle={{ paddingTop: 52, paddingBottom: 24 }}>
            {displayBoards.length === 0 ? (
              <Text style={[styles.emptyText, { marginTop: 80 }]}>No nearby or linked live boards.</Text>
            ) : effectiveDisplayLayout === 'list' ? (
              <View style={styles.listWrap}>
                {displayBoards.map((entry: any, idx) => (
                  <View key={entry.id} style={styles.listItemWrap}>
                    <BoardCard
                      boardNr={0}
                      data={entry.data}
                      isFullscreen={false}
                      onToggleFullscreen={() => setFullscreenBoardId(entry.id)}
                      onUiAction={() => {}}
                      isAlt={idx % 2 === 1}
                      isFresh={true}
                      isStale={false}
                      fontZoom={fontZoom}
                    />
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.gridWrap}>
                {paddedGridBoards.map((entry: any, idx) => (
                  <View key={entry ? entry.id : `empty-${idx}`} style={gridItemStyle}>
                    {entry ? (
                      <BoardCard
                        boardNr={0}
                        data={entry.data}
                        isFullscreen={false}
                        onToggleFullscreen={() => setFullscreenBoardId(entry.id)}
                        onUiAction={() => {}}
                        isAlt={idx % 2 === 1}
                        isFresh={true}
                        isStale={false}
                        fontZoom={fontZoom}
                      />
                    ) : (
                      <View style={styles.gridEmptySlot} />
                    )}
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </GestureDetector>
  </View>
</View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0f14" },

  screen: { flex: 1, padding: 8 },

  grid: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
  },

  gridItemBase: {
    padding: 6,
  },

  fullWrap: {
    flex: 1,
    padding: 6,
  },

  bottomLeftRow: {
    position: "absolute",
    left: 10,
    bottom: 40,
    zIndex: 1999,
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },

  scoringChip: {
    borderWidth: 1,
    borderColor: CLUB_CHIP_BORDER,
    backgroundColor: CLUB_CHIP_BG,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
scoringChipNew: {
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
  borderWidth: 1,
    borderColor: CLUB_CHIP_BORDER,
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderRadius: 999,
  // backgroundColor: "#2f6f18",
   backgroundColor: CLUB_CHIP_BG,
  shadowColor: "#000",
  shadowOpacity: 0.15,
  shadowRadius: 4,
  elevation: 3,
},

scoringChipPressed: {
  opacity: 0.75,
},

scoringIcon: {
  width: 20,
  height: 20,
  resizeMode: "contain",
},

scoringChipText: {
  color: "#fff",
  fontWeight: "900",
  letterSpacing: 0.4,
},
gridWrap: {
  flexDirection: 'row',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  alignContent: 'flex-start',
},
  clubChip: {
    position: "absolute",
    right: 10,
    bottom: 40,
    zIndex: 1999,
    borderWidth: 1,
    borderColor: CLUB_CHIP_BORDER,
    backgroundColor: CLUB_CHIP_BG,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  clubChipPressed: {
    opacity: 0.75,
  },
  clubChipText: {
    color: CLUB_CHIP_TEXT,
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 0.3,
  },

  subtitleBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 10,
    zIndex: 1000,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderColor: "rgba(255,255,255,0.14)",
  },
  subtitleText: {
    flex: 1,
    color: "rgba(255,255,255,0.92)",
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 0.2,
  },
  subtitleCloseBtn: {
    width: 24,
    height: 24,
    borderRadius: 99,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.01)",
  },
  subtitleCloseText: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 18,
    fontWeight: "900",
    lineHeight: 20,
  },

  photoOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoCard: {
    width: "95%",
    height: "95%",
    backgroundColor: "rgba(15,15,15,0.92)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    overflow: "hidden",
  },
  photoHeader: {
    height: 52,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.10)",
  },
  photoTitle: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 16,
    fontWeight: "900",
  },
  photoCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  photoCloseText: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 18,
    fontWeight: "900",
    lineHeight: 20,
  },
  photoBody: {
    flex: 1,
    padding: 10,
  },
  photoImage: {
    flex: 1,
    width: "100%",
    height: "100%",
  },

  card: {
    flex: 1,
    borderRadius: 18,
    padding: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    overflow: "hidden",
  },
  cardBase: { backgroundColor: CARD_BG_A },
  cardAlt: { backgroundColor: CARD_BG_B },

  cardGrid: {},
  cardFullscreen: {
    flex: 1,
  },

  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },

  boardBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: BADGE_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  boardBadgeText: {
    fontSize: 13,
    fontWeight: "900",
  },

  fullBtnPressed: {
    opacity: 0.55,
  },
  fullIcon: {
    color: FULL_ICON,
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 24,
  },
  emptyText: {
    marginTop: 10,
    color: "rgba(255,255,255,0.6)",
    fontSize: 14,
  },
listWrap: {
  gap: 12,
},

listItemWrap: {
  paddingHorizontal: 6,
  paddingBottom: 6,
},

gridEmptySlot: {
  minHeight: 140,
  borderRadius: 18,
  backgroundColor: 'transparent',
},

layoutToggleBtn: {
  position: 'absolute',
  right: 10,
  bottom: 40,
  zIndex: 1999,
  width: 46,
  height: 46,
  borderRadius: 999,
  borderWidth: 1,
  borderColor: CLUB_CHIP_BORDER,
  backgroundColor: CLUB_CHIP_BG,
  alignItems: 'center',
  justifyContent: 'center',
},

layoutToggleBtnText: {
  color: CLUB_CHIP_TEXT,
  fontSize: 22,
  fontWeight: '900',
  lineHeight: 22,
},
displayGestureArea: {
  flex: 1,
},
  bodyWrap: {
    flex: 1,
    position: "relative",
  },

  nameLegsRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  nameBig: {
    flex: 1,
    color: "white",
    fontSize: 16,
    fontWeight: "900",
  },
  legsCenter: {
    minWidth: 70,
    paddingHorizontal: 6,
    alignItems: "center",
  },
  legsBig: {
    color: ACCENT_LEGS,
    fontSize: 26,
    fontWeight: "900",
    lineHeight: 28,
  },

  scoresRow: {
    marginTop: 4,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  scoreBig: {
    flex: 1,
    color: ACCENT_SCORE,
    fontSize: 36,
    fontWeight: "800",
  },

  lastRow: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  lastText: {
    flex: 1,
    color: "rgba(255,255,255,0.92)",
    fontSize: 22,
    fontWeight: "900",
  },
  avgX3ValFsFill: {
    flex: 1,
    minWidth: 0,
  },

  avgX3LabelFsFill: {
    width: "auto",
    minWidth: 0,
    flexShrink: 0,
    paddingHorizontal: 12,
  },

  avgX3LabelFill: {
    width: "auto",
    minWidth: 0,
    flexShrink: 0,
    paddingHorizontal: 12,
  },

  avgX3Row: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: "rgba(179,143,0,0.10)",
  },
  avgX3Val: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    color: ACCENT_SCORE,
    fontSize: 22,
    fontWeight: "900",
  },
  avgX3Label: {
    width: 80,
    textAlign: "center",
    color: "rgba(255,255,255,0.85)",
    fontSize: 14,
    fontWeight: "900",
  },

  divider: {
    marginTop: 10,
    marginBottom: 8,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.10)",
  },

  statRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
  },
  statValLeft: {
    width: 62,
    color: "white",
    fontSize: 15,
    fontWeight: "900",
    textAlign: "left",
  },
  statLabel: {
    flex: 1,
    textAlign: "center",
    color: "rgba(255,255,255,0.62)",
    fontSize: 14,
    fontWeight: "800",
  },
  statValRight: {
    width: 62,
    color: "white",
    fontSize: 15,
    fontWeight: "900",
    textAlign: "right",
  },
    cricketWrap: {
      paddingTop: 4,
      paddingBottom: 8,
      minWidth: "100%",
    },

    cricketWrapCentered: {
      justifyContent: "center",
    },

    cricketTable: {
      alignSelf: "center",
    },

    cricketRow: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: 28,
    },

    cricketPlayerCell: {
      minWidth: 92,
      paddingHorizontal: 4,
      alignItems: "center",
      justifyContent: "center",
    },

    cricketLabelCell: {
      minWidth: 42,
      paddingHorizontal: 2,
      alignItems: "center",
      justifyContent: "center",
    },

   
    cricketPlayersRow: {
      flex: 1,
      flexDirection: "row",
      alignItems: "flex-start",
    },

    cricketPlayersRow2: {
      justifyContent: "space-between",
    },

    cricketPlayersRow3: {
      justifyContent: "space-between",
    },

    cricketPlayersRow4: {
      justifyContent: "space-between",
    },

    cricketGap: {
      flex: 1,
    },
    cricketPlayerCol: {
      flex: 2,
      minWidth: 0,
      alignItems: "stretch",
    },

    cricketPlayerHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 4,
    },

    cricketPlayerName: {
      color: "white",
      fontWeight: "900",
      textAlign: "center",
      flexShrink: 1,
    },

    cricketPlayerWinsInline: {
      color: ACCENT_LEGS,
      fontWeight: "900",
      textAlign: "left",
      marginLeft: 6,
      flexShrink: 0,
    },

    cricketPlayerPoints: {
      color: ACCENT_SCORE,
      fontWeight: "900",
      textAlign: "center",
      marginTop: 0,
      marginBottom: 8,
    },
    cricketMarksStack: {
      alignItems: "center",
      gap: 6,
    },

    cricketMarksStackLarge: {
      gap: 14,
    },

    cricketMarkChip: {
      borderRadius: 15,
      borderWidth: 1,
      
      // borderColor: "rgba(255,255,255,0.16)",
      borderColor: "rgba(12, 12, 12, 0.32)",
      backgroundColor: "rgba(255, 255, 255, 0.19)",
      overflow: "hidden",
      justifyContent: "center",
      alignItems: "center",
      alignSelf: "center",
      position: "relative",
    },

    cricketMarkChipBg: {
      ...StyleSheet.absoluteFillObject,
      position: "absolute",
    },

    cricketMarkChipFill: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      backgroundColor: "rgba(61,255,47,0.42)",
    },

    cricketMarkDivider: {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: 2,
      //backgroundColor: "rgba(210,210,210,0.32)",
      backgroundColor: "rgba(12, 12, 12, 0.32)",
    },

    cricketMarkDivider1: {
      left: "33.3333%",
      marginLeft: -1,
    },

    cricketMarkDivider2: {
      left: "66.6666%",
      marginLeft: -1,
    },

    cricketMarkChipLabelCentered: {
      color: "rgba(255,255,255,0.92)",
      fontWeight: "700",
      textAlign: "center",
      zIndex: 2,
    },
   
    cricketPlayerWins: {
      color: ACCENT_LEGS,
      fontWeight: "900",
      textAlign: "center",
      marginTop: 2,
    },

  
    cricketMarkChipSmall: {
      height: 28,
      paddingHorizontal: 8,
    },

    cricketMarkChipLarge: {
      height: 42,          // ~2.5–3x
      paddingHorizontal: 18,
    },
    cricketMarkChipNum: {
      width: 84,
    },

    cricketMarkChipBull: {
      width: 84,
    },

   
    cricketMarkChipLabel: {
      width: 32,
      color: "rgba(255,255,255,0.68)",
      fontWeight: "700",
      textAlign: "left",
    },

    cricketMarkChipValue: {
      flex: 1,
      minWidth: 24,
      color: "rgba(255,255,255,0.92)",
      fontWeight: "900",
      textAlign: "center",
    },
    cricketMarkVal: {
      color: "rgba(255,255,255,0.92)",
      fontWeight: "900",
      textAlign: "center",
      lineHeight: 22,
    },

    cricketLabelText: {
      color: "rgba(255,255,255,0.72)",
      fontWeight: "900",
      textAlign: "center",
      lineHeight: 22,
    },

    cricketLabelSpacer: {
      color: "transparent",
      lineHeight: 22,
    },

  rightAlign: { textAlign: "right" },

  nameBigFs: {
    fontSize: 32,
  },
  legsBigFs: {
    fontSize: 52,
    lineHeight: 56,
  },
  scoreBigFs: {
    fontSize: 72,
  },
  lastTextFs: {
    fontSize: 44,
  },
  avgX3ValFs: {
    fontSize: 44,
  },
  avgX3LabelFs: {
    fontSize: 28,
  },
  legsCenterFs: {
    minWidth: 120,
  },

  modalBtnWithIcon: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  modalBtnIcon: {
    width: 18,
    height: 18,
    tintColor: "rgba(7, 7, 7, 0.7)",
    resizeMode: "contain",
    opacity: 0.95,
  },
  modalBtnWhiteIcon: {
    width: 18,
    height: 18,
    tintColor: "rgba(252, 252, 252, 0.91)",
    resizeMode: "contain",
    opacity: 0.95,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  clubIdInput: {
  borderWidth: 1,
  borderColor: "rgba(0,0,0,0.18)",
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 10,
  fontSize: 15,
  fontWeight: "800",
  color: "rgba(0,0,0,0.85)",
  backgroundColor: "#ffffff",
},

clubIdErrorText: {
  marginTop: 10,
  color: "#b3422a",
  fontWeight: "900",
  fontSize: 13,
},

clubIdHelpWrap: {
  marginTop: 14,
  alignSelf: "flex-start",
},

clubIdHelpText: {
  color: "rgba(0,0,0,0.65)",
  fontWeight: "800",
  textDecorationLine: "underline",
},
  modalCard: {
    width: "92%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
  },
  modalTitle: {
    fontWeight: "900",
    fontSize: 18,
    marginBottom: 10,
    color: "rgba(0,0,0,0.85)",
  },
  modalLabel: {
    fontWeight: "800",
    color: "rgba(0,0,0,0.6)",
    marginTop: 6,
    marginBottom: 4,
  },
  modalBtns: { flexDirection: "row", gap: 10, marginTop: 12 },
  modalBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  modalBtnGhost: { backgroundColor: "rgba(0,0,0,0.08)" },
  modalBtnOk: { backgroundColor: "#2f6f18" },
  modalBtnTextGhost: { fontWeight: "900", color: "rgba(0,0,0,0.75)" },
  modalBtnTextOk: { fontWeight: "900", color: "#ffffff" },
  fontZoomOverlay: {
    position: "absolute",
    top: 16,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 4000,
  },
  fontZoomPanel: {
    minWidth: 280,
    backgroundColor: "rgba(0,0,0,0.82)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: "center",
    gap: 8,
  },
  fontZoomLabel: {
    color: "rgba(255,255,255,0.78)",
    fontWeight: "800",
    fontSize: 12,
  },
  fontZoomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  fontZoomBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  rootCornerMenu: {
  position: 'absolute',
  
  zIndex: 5000,
  width: 58,
  height: 58,
  borderRadius: 999,
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'rgba(0,0,0,0.86)',
  borderWidth: 1,
  borderColor: CLUB_CHIP_BORDER,
},

  rootCornerMenuText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '900',
    lineHeight: 30,
  },

  quickMenuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.28)',
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    paddingRight: 14,
    paddingBottom: 102,
  },

  quickMenuCard: {
    minWidth: 180,
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 8,
    overflow: 'hidden',
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },

  quickMenuItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },

  quickMenuItemText: {
    color: '#111',
    fontSize: 16,
    fontWeight: '800',
  },
  displayBackChip: {
    position: "absolute",
    left: 10,
    top: 10,
    zIndex: 60,
    backgroundColor: "rgba(0,0,0,0.82)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  displayBackChipText: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 13,
    fontWeight: "700",
  },
  fontZoomBtnText: {
    color: "white",
    fontSize: 20,
    fontWeight: "900",
    lineHeight: 22,
  },
  fontZoomValue: {
    color: "rgba(255,255,255,0.92)",
    fontWeight: "900",
    fontSize: 12,
  },
  exitInline: { marginTop: 14, alignItems: "center" },
  exitInlineText: {
    color: "rgba(0,0,0,0.55)",
    fontWeight: "900",
    textDecorationLine: "underline",
  },
});