import { onValue, push, ref } from "firebase/database";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import {
  Animated,
  Easing,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { db } from "../../lib/firebase";
import HistoryScreen from "./HistoryScreen";
import ScoringScreen from "./ScoringScreen";

type BoardData = {
  raw: string;
  parts: string[];
  timestamp: number; // millis
};

const DEFAULT_CLUB_ID = "helios";
const BOARD_NRS = [1, 2, 3, 4, 5, 6, 7, 8];

// freshness
const FRESH_LIMIT_MS = 2 * 60 * 1000; // 2 minutes
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // check every 2 perc
const STALE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

// colors
const ACCENT_SCORE = "#b38f00";
const ACCENT_LEGS = "#326b15";

const CARD_BG_A = "#2f2e2d";
const CARD_BG_B = "#2f2e2d";

const BADGE_BG = "#1E1C1F";
const BADGE_TEXT_DEFAULT = "#99949494";
const FULL_ICON = "#99949494";

const BADGE_ACTIVE_BG = "#3DFF2F";
const BADGE_ACTIVE_TEXT = "#0B2E00";

// club chip colors
const CLUB_CHIP_BG = "rgba(0,0,0,0.85)";
const CLUB_CHIP_BORDER = "rgba(255,255,255,0.18)";
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

function ensureDocFullscreen() {
  if (typeof document === "undefined") return Promise.resolve();
  if (document.fullscreenElement) return Promise.resolve();
  return document.documentElement.requestFullscreen?.() ?? Promise.resolve();
}

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

  return (
    <View
      style={[
        styles.card,
        props.isAlt ? styles.cardAlt : styles.cardBase,
        props.isFullscreen ? styles.cardFullscreen : styles.cardGrid,
      ]}
    >
      <View style={styles.cardHeader}>
        {props.onSaveHistory  ? (
          <Pressable
            onPress={() => {
              props.onUiAction();
              props.onSaveHistory?.();
            }}
            hitSlop={10}
          >
            <View style={[styles.boardBadge, badgeBgStyle, badgeGlowStyle]}>
              <Text style={[styles.boardBadgeText, badgeTextStyle, { fontSize: scaleFont(13, z) }]}>
                {props.boardNr}
              </Text>
            </View>
          </Pressable>
        ) : (
          <View style={[styles.boardBadge, badgeBgStyle, badgeGlowStyle]}>
            <Text style={[styles.boardBadgeText, badgeTextStyle, { fontSize: scaleFont(13, z) }]}>
              {props.boardNr}
            </Text>
          </View>
        )}

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
        <Text style={[styles.emptyText, { fontSize: scaleFont(14, z) }]}>
          No action on this board in the last hour.
        </Text>
      ) : (
        <View style={styles.bodyWrap}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            overScrollMode="never"
            bounces={false}
            contentContainerStyle={{ paddingBottom: 40 }}
          >
            <View style={styles.nameLegsRow}>
              <Text
                style={[
                  styles.nameBig,
                  { fontSize: scaleFont(props.isFullscreen ? 32 : 16, z) },
                ]}
                numberOfLines={1}
              >
                {nameL}
              </Text>

              <View style={[styles.legsCenter, props.isFullscreen ? styles.legsCenterFs : null]}>
                <Text
                  style={[
                    styles.legsBig,
                    {
                      fontSize: scaleFont(props.isFullscreen ? 52 : 26, z),
                      lineHeight: scaleFont(props.isFullscreen ? 56 : 28, z),
                    },
                  ]}
                  numberOfLines={1}
                >
                  {legsL}-{legsR}
                </Text>
              </View>

              <Text
                style={[
                  styles.nameBig,
                  styles.rightAlign,
                  { fontSize: scaleFont(props.isFullscreen ? 32 : 16, z) },
                ]}
                numberOfLines={1}
              >
                {nameR}
              </Text>
            </View>

            <View style={styles.scoresRow}>
              <Text
                style={[
                  styles.scoreBig,
                  { fontSize: scaleFont(props.isFullscreen ? 72 : 36, z) },
                ]}
                numberOfLines={1}
              >
                {scoreL}
              </Text>
              <Text
                style={[
                  styles.scoreBig,
                  styles.rightAlign,
                  { fontSize: scaleFont(props.isFullscreen ? 72 : 36, z) },
                ]}
                numberOfLines={1}
              >
                {scoreR}
              </Text>
            </View>

            <View style={styles.lastRow}>
              <Text
                style={[
                  styles.lastText,
                  { fontSize: scaleFont(props.isFullscreen ? 44 : 22, z) },
                ]}
                numberOfLines={1}
              >
                {lastL}
              </Text>
              <Text
                style={[
                  styles.lastText,
                  styles.rightAlign,
                  { fontSize: scaleFont(props.isFullscreen ? 44 : 22, z) },
                ]}
                numberOfLines={1}
              >
                {lastR}
              </Text>
            </View>

            <View style={styles.avgX3Row}>
              <Text
                style={[
                  styles.avgX3Val,
                  props.isFullscreen ? styles.avgX3ValFsFill : null,
                  { fontSize: scaleFont(props.isFullscreen ? 44 : 22, z) },
                ]}
                numberOfLines={1}
              >
                {avgX3L}
              </Text>

              <Text
                style={[
                  styles.avgX3Label,
                  props.isFullscreen ? styles.avgX3LabelFsFill : null,
                  !props.isFullscreen ? styles.avgX3LabelFill : null,
                  { fontSize: scaleFont(props.isFullscreen ? 28 : 14, z) },
                ]}
                numberOfLines={1}
              >
                Avg.x3
              </Text>

              <Text
                style={[
                  styles.avgX3Val,
                  styles.rightAlign,
                  props.isFullscreen ? styles.avgX3ValFsFill : null,
                  { fontSize: scaleFont(props.isFullscreen ? 44 : 22, z) },
                ]}
                numberOfLines={1}
              >
                {avgX3R}
              </Text>
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
  const [clubId, setClubId] = useState<string>(() => loadClubId());

  const [boards, setBoards] = useState<Record<number, BoardData>>(() => {
    const init: Record<number, BoardData> = {};
    BOARD_NRS.forEach((nr) => (init[nr] = parseBoard(null)));
    return init;
  });

  const [fullscreenBoard, setFullscreenBoard] = useState<number | null>(null);

  const [freshMap, setFreshMap] = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    BOARD_NRS.forEach((nr) => (init[nr] = false));
    return init;
  });
  const [staleMap, setStaleMap] = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    BOARD_NRS.forEach((nr) => (init[nr] = false));
    return init;
  });
  const [initialScoringBoard, setInitialScoringBoard] = useState<number | null>(null);

  const { width, height } = useWindowDimensions();

  const isProbablyDesktop =
    typeof window !== "undefined" &&
    (((navigator as any)?.maxTouchPoints ?? 0) === 0 || Math.max(width, height) >= 900);

  const [forcedLandscape, setForcedLandscape] = useState<boolean>(() => !!isProbablyDesktop);
  const isPortrait = !forcedLandscape && height >= width;
  const [mode, setMode] = useState<"display" | "scoring" | "history">("display");

  const [fontZoom, setFontZoom] = useState(1);
  const [showFontSlider, setShowFontSlider] = useState(false);
  const suppressNextBackgroundTapRef = useRef(false);

  const markUiAction = () => {
    suppressNextBackgroundTapRef.current = true;
  };

  const handleBackgroundTap = () => {
    if (suppressNextBackgroundTapRef.current) {
      suppressNextBackgroundTapRef.current = false;
      return;
    }
    setShowFontSlider((v) => !v);
  };

  const [qrBoard, setQrBoard] = useState<number | null>(null);
  const [showQrChoiceDialog, setShowQrChoiceDialog] = useState(false);

  const isTvLike = useMemo(() => {
    try {
      if (typeof navigator === "undefined") return false;
      const ua = (navigator.userAgent || "").toLowerCase();
      return ua.includes("webos") || ua.includes("tizen") || ua.includes("aft") || ua.includes("android tv");
    } catch {
      return false;
    }
  }, []);

  const isLargeLandscape = width >= 1400 && height >= 800 && !isPortrait;

  const safePad = isTvLike || isLargeLandscape ? 24 : 8;
  const chipOffset = isTvLike || isLargeLandscape ? 24 : 10;
  const chipBottom = isTvLike || isLargeLandscape ? 48 : 40;

  const gridCols = isPortrait ? 2 : 4;
  const gridRows = isPortrait ? 4 : 2;

  const gridItemStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      styles.gridItemBase,
      {
        width: `${100 / gridCols}%`,
        height: `${100 / gridRows}%`,
      },
    ],
    [gridCols, gridRows]
  );

  const isGrid = fullscreenBoard == null;

  const [clubMessage, setClubMessage] = useState<string>("");
  const [clubPhoto, setClubPhoto] = useState<string>("");

  const [dismissedMessageValue, setDismissedMessageValue] = useState<string>(() =>
    loadDismissedMessage(loadClubId())
  );

  const marqueeX = useRef(new Animated.Value(0)).current;
  const { width: screenW } = useWindowDimensions();
  const [msgW, setMsgW] = useState(0);

  useEffect(() => {
    if (!forcedLandscape) return;
    if (height > width) {
      setForcedLandscape(false);
    }
  }, [forcedLandscape, width, height]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const qs = new URLSearchParams(window.location.search);
    const qClub = (qs.get("clubId") || qs.get("club") || "").trim().toLowerCase();
    const qBoardRaw = (qs.get("board") || "").trim();

    const qBoard = qBoardRaw ? Number(qBoardRaw) : NaN;
    const boardOk = Number.isFinite(qBoard) && BOARD_NRS.includes(qBoard as any);

    const hasAny = !!qClub || !!qBoardRaw;
    if (!hasAny) return;

    if (qClub) {
      saveClubId(qClub);
      setClubId(qClub);
    }

    if (boardOk) {
      setQrBoard(qBoard as number);
      setShowQrChoiceDialog(true);

      setFullscreenBoard(null);
      setMode("display");
      setInitialScoringBoard(null);
    }
  }, []);

  useEffect(() => {
    const v = loadDismissedMessage(clubId);
    setDismissedMessageValue(v);
  }, [clubId]);

  const messageVisible = useMemo(() => {
    const msg = (clubMessage ?? "").trim();
    if (!msg) return false;
    return msg !== (dismissedMessageValue ?? "");
  }, [clubMessage, dismissedMessageValue]);

  useEffect(() => {
    if (!messageVisible || !isGrid) return;
    if (!msgW) return;

    let cancelled = false;

    const run = () => {
      marqueeX.setValue(0);

      Animated.timing(marqueeX, {
        toValue: 1,
        duration: Math.max(8000, (screenW + msgW) * 12),
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && !cancelled) run();
      });
    };

    run();

    return () => {
      cancelled = true;
      marqueeX.stopAnimation();
    };
  }, [messageVisible, isGrid, clubMessage, msgW, screenW, marqueeX]);

  const photoAvailable = useMemo(() => (clubPhoto ?? "").trim().length > 0, [clubPhoto]);
  const [showPhotoDialog, setShowPhotoDialog] = useState(false);

  useEffect(() => {
    const msgRef = ref(db, `messages/${clubId}message1`);
    const photoRef = ref(db, `photos/${clubId}photo1`);

    const unsubMsg = onValue(
      msgRef,
      (snap) => {
        const v = snap.val();
        setClubMessage(v == null ? "" : String(v));
      },
      (err) => console.error("[RTDB ERROR]", `messages/${clubId}message1`, err?.message)
    );

    const unsubPhoto = onValue(
      photoRef,
      (snap) => {
        const v = snap.val();
        setClubPhoto(v == null ? "" : String(v));
      },
      (err) => console.error("[RTDB ERROR]", `photos/${clubId}photo1`, err?.message)
    );

    return () => {
      unsubMsg();
      unsubPhoto();
    };
  }, [clubId]);

  const dismissMessage = () => {
    const v = (clubMessage ?? "").trim();
    setDismissedMessageValue(v);
    saveDismissedMessage(clubId, v);
  };

  useEffect(() => {
    setFullscreenBoard(null);
    setBoards(() => {
      const init: Record<number, BoardData> = {};
      BOARD_NRS.forEach((nr) => (init[nr] = parseBoard(null)));
      return init;
    });

    const unsubs = BOARD_NRS.map((nr) => {
      const r = ref(db, `score/${clubId}/${nr}`);
      return onValue(
        r,
        (snap) => {
          setBoards((prev) => ({ ...prev, [nr]: parseBoard(snap.val()) }));
        },
        (err) => {
          console.error("[RTDB ERROR]", `score/${clubId}/${nr}`, err?.message);
        }
      );
    });

    return () => unsubs.forEach((u) => u());
  }, [clubId]);

  useEffect(() => {
    const check = () => {
      const now = Date.now();

      const nextFresh: Record<number, boolean> = {};
      const nextStale: Record<number, boolean> = {};

      BOARD_NRS.forEach((nr) => {
        const ts = boards[nr]?.timestamp || 0;

        nextFresh[nr] = ts > 0 && now - ts <= FRESH_LIMIT_MS;
        nextStale[nr] = ts === 0 ? true : now - ts > STALE_LIMIT_MS;
      });

      setFreshMap(nextFresh);
      setStaleMap(nextStale);
    };

    check();
    const id = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [boards]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const handler = () => {
      if (!document.fullscreenElement) {
        setFullscreenBoard(null);
      }
    };

    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const openBoardFullscreen = async (nr: number) => {
    try {
      await ensureDocFullscreen();
    } catch (e) {
      console.warn("requestFullscreen blocked:", e);
    }
    setFullscreenBoard(nr);
  };

  const saveBoardToHistory = async (boardNr: number) => {
    try {
      const raw = boards[boardNr]?.raw ?? "";
      const value = raw.trim();
      if (!value || value === "—") return;

      await push(ref(db, `history/${clubId}/${boardNr}`), value);
    } catch (e) {
      console.error("[RTDB ERROR]", `history/${clubId}/${boardNr}`, e);
    }
  };

  const onPickClub = () => {
    if (typeof window === "undefined") return;

    const next = window.prompt("Enter club ID:", clubId)?.trim().toLowerCase();
    if (!next) return;

    const cleaned = next.replace(/[^a-z0-9_-]/g, "").slice(0, 32);
    if (!cleaned) return;

    saveClubId(cleaned);
    setClubId(cleaned);
  };

 const showBottomHud = mode === "display" && isGrid && showFontSlider;

  const chooseDisplayFromQr = async () => {
    const b = qrBoard;
    setShowQrChoiceDialog(false);
    if (b == null) return;
    await openBoardFullscreen(b);
  };

  const chooseScoringFromQr = async () => {
    const b = qrBoard;
    setShowQrChoiceDialog(false);
    if (b == null) return;

    try {
      await ensureDocFullscreen();
    } catch {}

    setInitialScoringBoard(b);
    setFullscreenBoard(null);
    setMode("scoring");
  };

  return (
    <View style={styles.safe}>
      {mode === "scoring" ? (
        <ScoringScreen
          clubId={clubId}
          onExit={() => setMode("display")}
          initialBoardNr={initialScoringBoard}
        />
      ) : mode === "history" ? (
        <HistoryScreen
          clubId={clubId}
          onExit={() => setMode("display")}
        />
      ) : (
        <View
          style={[styles.screen, { padding: safePad }]}
          onStartShouldSetResponder={() => true}
          onResponderRelease={handleBackgroundTap}
        >
          {showBottomHud ? (
            <Pressable
              onPress={() => {
                markUiAction();
                onPickClub();
              }}
              hitSlop={12}
              style={({ pressed }) => [
                styles.clubChip,
                { right: chipOffset, bottom: chipBottom },
                pressed ? styles.clubChipPressed : null,
              ]}
            >
              <Text style={[styles.clubChipText, { fontSize: scaleFont(13, fontZoom) }]}>{clubId}</Text>
            </Pressable>
          ) : null}

          {showBottomHud ? (
            <View style={[styles.bottomLeftRow, { left: chipOffset, bottom: chipBottom }]}>
              <Pressable
                onPress={async () => {
                  markUiAction();
                  try {
                    await ensureDocFullscreen();
                  } catch {}
                  setMode("scoring");
                }}
                hitSlop={12}
                style={({ pressed }) => [styles.scoringChip, pressed ? styles.clubChipPressed : null]}
              >
                <Text style={[styles.clubChipText, { fontSize: scaleFont(13, fontZoom) }]}>scoring mode</Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  markUiAction();
                  setMode("history");
                }}
                hitSlop={12}
                style={({ pressed }) => [styles.scoringChip, pressed ? styles.clubChipPressed : null]}
              >
                <Text style={[styles.clubChipText, { fontSize: scaleFont(13, fontZoom) }]}>history</Text>
              </Pressable>

              {photoAvailable ? (
                <Pressable
                  onPress={() => {
                    markUiAction();
                    setShowPhotoDialog(true);
                  }}
                  hitSlop={12}
                  style={({ pressed }) => [styles.scoringChip, pressed ? styles.clubChipPressed : null]}
                >
                  <Text style={[styles.clubChipText, { fontSize: scaleFont(13, fontZoom) }]}>table</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {showBottomHud && messageVisible ? (
            <View style={[styles.subtitleBar, { bottom: chipOffset }]}>
              <View style={{ flex: 1, overflow: "hidden" }}>
                <Animated.Text
                  onLayout={(e) => setMsgW(e.nativeEvent.layout.width)}
                  numberOfLines={1}
                  style={[
                    styles.subtitleText,
                    {
                      fontSize: scaleFont(15, fontZoom),
                      transform: [
                        {
                          translateX: marqueeX.interpolate({
                            inputRange: [0, 1],
                            outputRange: [screenW, -msgW],
                          }),
                        },
                      ],
                    },
                  ]}
                >
                  {(clubMessage ?? "").trim()}
                </Animated.Text>
              </View>

              <Pressable
                onPress={() => {
                  markUiAction();
                  dismissMessage();
                }}
                hitSlop={12}
                style={styles.subtitleCloseBtn}
              >
                <Text
                  style={[
                    styles.subtitleCloseText,
                    { fontSize: scaleFont(18, fontZoom), lineHeight: scaleFont(20, fontZoom) },
                  ]}
                >
                  ✕
                </Text>
              </Pressable>
            </View>
          ) : null}

          {isGrid ? (
            <View style={styles.grid}>
              {BOARD_NRS.map((nr, idx) => (
                <View key={nr} style={gridItemStyle}>
                  <BoardCard
                    boardNr={nr}
                    data={boards[nr]}
                    isFullscreen={false}
                    onToggleFullscreen={() => openBoardFullscreen(nr)}
                    onSaveHistory={() => saveBoardToHistory(nr)}
                    onUiAction={markUiAction}
                    isAlt={idx % 2 === 1}
                    isFresh={!!freshMap[nr]}
                    isStale={!!staleMap[nr]}
                    fontZoom={fontZoom}
                  />
                </View>
              ))}
            </View>
          ) : (
            <View style={styles.fullWrap}>
              <BoardCard
                boardNr={fullscreenBoard as number}
                data={boards[fullscreenBoard as number]}
                isFullscreen={true}
                onToggleFullscreen={() => setFullscreenBoard(null)}
                onSaveHistory={() => saveBoardToHistory(fullscreenBoard as number)}
                onUiAction={markUiAction}
                isAlt={false}
                isFresh={!!freshMap[fullscreenBoard as number]}
                isStale={!!staleMap[fullscreenBoard as number]}
                fontZoom={fontZoom}
              />
            </View>
          )}

          <Modal
            visible={showPhotoDialog}
            transparent
            animationType="fade"
            onRequestClose={() => setShowPhotoDialog(false)}
          >
            <View style={styles.photoOverlay}>
              <View style={styles.photoCard}>
                <View style={styles.photoHeader}>
                  <Text style={[styles.photoTitle, { fontSize: scaleFont(16, fontZoom) }]}>Táblázat</Text>
                  <Pressable
                    onPress={() => setShowPhotoDialog(false)}
                    hitSlop={12}
                    style={styles.photoCloseBtn}
                  >
                    <Text
                      style={[
                        styles.photoCloseText,
                        { fontSize: scaleFont(18, fontZoom), lineHeight: scaleFont(20, fontZoom) },
                      ]}
                    >
                      ✕
                    </Text>
                  </Pressable>
                </View>

                <View style={styles.photoBody}>
                  <Image source={{ uri: toImageUri(clubPhoto) }} style={styles.photoImage} resizeMode="contain" />
                </View>
              </View>
            </View>
          </Modal>

          <Modal
            visible={showQrChoiceDialog}
            transparent
            animationType="fade"
            onRequestClose={() => setShowQrChoiceDialog(false)}
          >
            <Pressable style={styles.modalOverlay} onPress={() => setShowQrChoiceDialog(false)}>
              <Pressable style={styles.modalCard} onPress={() => {}}>
                <Text style={[styles.modalTitle, { fontSize: scaleFont(18, fontZoom) }]}>
                  Hogyan szeretnéd használni?
                </Text>

                <Text style={[styles.modalLabel, { fontSize: scaleFont(14, fontZoom) }]}>
                  Club: {clubId} • Board: {qrBoard ?? "-"}
                </Text>

                <View style={styles.modalBtns}>
                  <Pressable
                    style={[styles.modalBtn, styles.modalBtnOk, styles.modalBtnWithIcon]}
                    onPress={() => void chooseScoringFromQr()}
                  >
                    <Image source={require("./keypad.png")} style={styles.modalBtnWhiteIcon} />
                    <Text style={[styles.modalBtnTextOk, { fontSize: scaleFont(14, fontZoom) }]}>SCORING</Text>
                  </Pressable>

                  <Pressable
                    style={[styles.modalBtn, styles.modalBtnGhost, styles.modalBtnWithIcon]}
                    onPress={() => void chooseDisplayFromQr()}
                  >
                    <Image source={require("./scoredisp.png")} style={styles.modalBtnIcon} />
                    <Text style={[styles.modalBtnTextGhost, { fontSize: scaleFont(14, fontZoom) }]}>DISPLAY</Text>
                  </Pressable>
                </View>
              </Pressable>
            </Pressable>
          </Modal>

          {showFontSlider ? (
            <View style={styles.fontZoomOverlay} pointerEvents="box-none">
              <Pressable onPress={() => markUiAction()} style={styles.fontZoomPanel}>
                <Text style={[styles.fontZoomLabel, { fontSize: scaleFont(12, fontZoom) }]}>
                  Font zoom
                </Text>

                <View style={styles.fontZoomRow}>
                  <Pressable
                    onPress={() => {
                      markUiAction();
                      setFontZoom((z) => clamp(Math.round((z - FONT_ZOOM_STEP) * 10) / 10, FONT_ZOOM_MIN, FONT_ZOOM_MAX));
                    }}
                    style={styles.fontZoomBtn}
                  >
                    <Text style={styles.fontZoomBtnText}>−</Text>
                  </Pressable>

                  {typeof document !== "undefined" ? (
                    <input
                      type="range"
                      min={FONT_ZOOM_MIN}
                      max={FONT_ZOOM_MAX}
                      step={0.1}
                      value={fontZoom}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        markUiAction();
                        const next = clamp(Number((e.target as HTMLInputElement).value), FONT_ZOOM_MIN, FONT_ZOOM_MAX);
                        setFontZoom(next);
                      }}
                      style={{ width: 180 }}
                    />
                  ) : null}

                  <Pressable
                    onPress={() => {
                      markUiAction();
                      setFontZoom((z) => clamp(Math.round((z + FONT_ZOOM_STEP) * 10) / 10, FONT_ZOOM_MIN, FONT_ZOOM_MAX));
                    }}
                    style={styles.fontZoomBtn}
                  >
                    <Text style={styles.fontZoomBtnText}>+</Text>
                  </Pressable>
                </View>

                <Text style={[styles.fontZoomValue, { fontSize: scaleFont(12, fontZoom) }]}>
                  {fontZoom.toFixed(1)}x
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      )}
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