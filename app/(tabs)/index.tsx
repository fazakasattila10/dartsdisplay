import { onValue, ref } from "firebase/database";
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
const BADGE_TEXT_DEFAULT = "#99949494"; // ARGB in RN (#AARRGGBB)
const FULL_ICON = "#99949494";

const BADGE_FRESH = "#7CFF6B"; // "lightgreen" vibe
const BADGE_ACTIVE_BG = "#3DFF2F"; // élénk, TV-barát zöld
const BADGE_ACTIVE_TEXT = "#0B2E00";

// ✅ club chip colors
const CLUB_CHIP_BG = "rgba(0,0,0,0.85)";
const CLUB_CHIP_BORDER = "rgba(255,255,255,0.18)";
const CLUB_CHIP_TEXT = "rgba(255,255,255,0.82)";

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

  // already a url or data uri
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:image\//i.test(s)) return s;

  // assume base64
  return `data:image/jpeg;base64,${s}`;
}

function BoardCard(props: {
  boardNr: number;
  data: BoardData;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  isAlt?: boolean;
  isFresh: boolean;
  isStale: boolean; // ✅ NEW
}) {
  const hasData = !props.isStale && props.data.raw !== "—" && props.data.raw !== "";
  const parts = props.data.parts;

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
        <View style={[styles.boardBadge, badgeBgStyle, badgeGlowStyle]}>
          <Text style={[styles.boardBadgeText, badgeTextStyle]}>{props.boardNr}</Text>
        </View>

        <Pressable
          onPress={props.onToggleFullscreen}
          hitSlop={12}
          style={({ pressed }) => (pressed ? styles.fullBtnPressed : null)}
        >
          <Text style={styles.fullIcon}>⛶</Text>
        </Pressable>
      </View>

      {!hasData ? (
        <Text style={styles.emptyText}>No action on this board in the last hour.</Text>
      ) : (
        <View style={styles.bodyWrap}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            overScrollMode="never"
            bounces={false}
            contentContainerStyle={{ paddingBottom: 40 }}
          >
            <View style={styles.nameLegsRow}>
              <Text style={[styles.nameBig, props.isFullscreen ? styles.nameBigFs : null]} numberOfLines={1}>
                {nameL}
              </Text>

              <View style={[styles.legsCenter, props.isFullscreen ? styles.legsCenterFs : null]}>
                <Text style={[styles.legsBig, props.isFullscreen ? styles.legsBigFs : null]} numberOfLines={1}>
                  {legsL}-{legsR}
                </Text>
              </View>

              <Text
                style={[styles.nameBig, styles.rightAlign, props.isFullscreen ? styles.nameBigFs : null]}
                numberOfLines={1}
              >
                {nameR}
              </Text>
            </View>

            <View style={styles.scoresRow}>
              <Text style={[styles.scoreBig, props.isFullscreen ? styles.scoreBigFs : null]} numberOfLines={1}>
                {scoreL}
              </Text>
              <Text
                style={[
                  styles.scoreBig,
                  styles.rightAlign,
                  props.isFullscreen ? styles.scoreBigFs : null,
                ]}
                numberOfLines={1}
              >
                {scoreR}
              </Text>
            </View>

            <View style={styles.lastRow}>
              <Text style={[styles.lastText, props.isFullscreen ? styles.lastTextFs : null]} numberOfLines={1}>
                {lastL}
              </Text>
              <Text
                style={[styles.lastText, styles.rightAlign, props.isFullscreen ? styles.lastTextFs : null]}
                numberOfLines={1}
              >
                {lastR}
              </Text>
            </View>

            <View style={styles.avgX3Row}>
              <Text style={[styles.avgX3Val, props.isFullscreen ? styles.avgX3ValFs : null]} numberOfLines={1}>
                {avgX3L}
              </Text>
              <Text
                style={[styles.avgX3Label, props.isFullscreen ? styles.avgX3LabelFs : null]}
                numberOfLines={1}
              >
                Avg.x3
              </Text>
              <Text
                style={[
                  styles.avgX3Val,
                  styles.rightAlign,
                  props.isFullscreen ? styles.avgX3ValFs : null,
                ]}
                numberOfLines={1}
              >
                {avgX3R}
              </Text>
            </View>

            <View style={styles.divider} />

            <StatRow left={getPart(parts, 6)} label="Throws" right={getPart(parts, 7)} />
            <StatRow left={getPart(parts, 10)} label="Avg." right={getPart(parts, 11)} />
            <StatRow left={getPart(parts, 14)} label="100+" right={getPart(parts, 15)} />
            <StatRow left={getPart(parts, 16)} label="140+" right={getPart(parts, 17)} />
            <StatRow left={getPart(parts, 18)} label="180+" right={getPart(parts, 19)} />
            <StatRow left={getPart(parts, 20)} label="H.out" right={getPart(parts, 21)} />

            <View style={{ height: 70 }} />
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function StatRow(props: { left: string; label: string; right: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statValLeft} numberOfLines={1}>
        {props.left}
      </Text>

      <Text style={styles.statLabel} numberOfLines={1}>
        {props.label}
      </Text>

      <Text style={styles.statValRight} numberOfLines={1}>
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

  // ✅ portrait / landscape detection for grid layout
  const { width, height } = useWindowDimensions();
  const isPortrait = height >= width;
  const [mode, setMode] = useState<"display" | "scoring">("display");

  // ✅ QR: store parsed board + show choice dialog
  const [qrBoard, setQrBoard] = useState<number | null>(null);
  const [showQrChoiceDialog, setShowQrChoiceDialog] = useState(false);

  // ✅ TV / overscan-safe padding (csak TV-n nagy)
  const isTvLike = useMemo(() => {
    try {
      if (typeof navigator === "undefined") return false;
      const ua = (navigator.userAgent || "").toLowerCase();
      // webOS (LG TV), Tizen (Samsung), Android TV
      return ua.includes("webos") || ua.includes("tizen") || ua.includes("aft") || ua.includes("android tv");
    } catch {
      return false;
    }
  }, []);

  // ha nagyon nagy a felbontás és nem portrait, az is TV-gyanús
  const isLargeLandscape = width >= 1400 && height >= 800 && !isPortrait;

  const safePad = isTvLike || isLargeLandscape ? 24 : 8;
  const chipOffset = isTvLike || isLargeLandscape ? 24 : 10;
  const chipBottom = isTvLike || isLargeLandscape ? 48 : 40;

  // Derived grid config:
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

  // ===================== CLUB MESSAGE + PHOTO (GRID ONLY UI) =====================
  const [clubMessage, setClubMessage] = useState<string>("");
  const [clubPhoto, setClubPhoto] = useState<string>("");

  const [dismissedMessageValue, setDismissedMessageValue] = useState<string>(() =>
    loadDismissedMessage(loadClubId())
  );

  const marqueeX = useRef(new Animated.Value(0)).current;
  const { width: screenW } = useWindowDimensions();
  const [msgW, setMsgW] = useState(0);

  // ✅ URL query parse: only clubId/club + board -> show choice dialog
  useEffect(() => {
    if (typeof window === "undefined") return;

    console.log("QUERY:", window.location.search);

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

      // go back to grid while choosing
      setFullscreenBoard(null);
      setMode("display");
      setInitialScoringBoard(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // when clubId changes, load dismissed for that club
    const v = loadDismissedMessage(clubId);
    setDismissedMessageValue(v);
  }, [clubId]);

  const messageVisible = useMemo(() => {
    const msg = (clubMessage ?? "").trim();
    if (!msg) return false;
    return msg !== (dismissedMessageValue ?? "");
  }, [clubMessage, dismissedMessageValue]);

  // marquee loop
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
    // subscribe message + photo for club
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

  // ===================== SCORE BOARDS SUBSCRIBE =====================
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

  // timer freshness check
  useEffect(() => {
      const check = () => {
      const now = Date.now();

      const nextFresh: Record<number, boolean> = {};
      const nextStale: Record<number, boolean> = {};

      BOARD_NRS.forEach((nr) => {
        const ts = boards[nr]?.timestamp || 0;

        nextFresh[nr] = ts > 0 && now - ts <= FRESH_LIMIT_MS;
        nextStale[nr] = ts === 0 ? true : now - ts > STALE_LIMIT_MS; // ✅ 1 órán túl: üresnek számít
      });

      setFreshMap(nextFresh);
      setStaleMap(nextStale);
    };

    check();
    const id = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [boards]);

  // handle escape fullscreen by user (ESC) -> go back to grid
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

  const onPickClub = () => {
    if (typeof window === "undefined") return;

    const next = window.prompt("Enter club ID:", clubId)?.trim().toLowerCase();
    if (!next) return;

    const cleaned = next.replace(/[^a-z0-9_-]/g, "").slice(0, 32);
    if (!cleaned) return;

    saveClubId(cleaned);
    setClubId(cleaned);
  };

  const showBottomHud = mode === "display" && isGrid;

  // ✅ QR choice actions
  const chooseDisplayFromQr = async () => {
    const b = qrBoard;
    setShowQrChoiceDialog(false);
    if (b == null) return;

    // display => zoom the selected board (fullscreen)
    await openBoardFullscreen(b);
  };

  const chooseScoringFromQr = async () => {
    const b = qrBoard;
    setShowQrChoiceDialog(false);
    if (b == null) return;

    // scoring => fullscreen + open scoring screen with board nr
    try {
      await ensureDocFullscreen(); // user gesture -> should succeed
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
      ) : (
        <View style={[styles.screen, { padding: safePad }]}>
          {/* meglévő display UI marad ugyanúgy */}
          {isGrid ? (
            <Pressable
              onPress={onPickClub}
              hitSlop={12}
              style={({ pressed }) => [
                styles.clubChip,
                { right: chipOffset, bottom: chipBottom },
                pressed ? styles.clubChipPressed : null,
              ]}
            >
              <Text style={styles.clubChipText}>{clubId}</Text>
            </Pressable>
          ) : null}

          {/* ✅ bottom-left: scoring + table (same style), ONLY in grid */}
          {showBottomHud ? (
            <View style={[styles.bottomLeftRow, { left: chipOffset, bottom: chipBottom }]}>
              <Pressable
                onPress={async () => {
                  try {
                    await ensureDocFullscreen();
                  } catch {}
                  setMode("scoring");
                }}
                hitSlop={12}
                style={({ pressed }) => [styles.scoringChip, pressed ? styles.clubChipPressed : null]}
              >
                <Text style={styles.clubChipText}>scoring mode</Text>
              </Pressable>

              {photoAvailable ? (
                <Pressable
                  onPress={() => setShowPhotoDialog(true)}
                  hitSlop={12}
                  style={({ pressed }) => [styles.scoringChip, pressed ? styles.clubChipPressed : null]}
                >
                  <Text style={styles.clubChipText}>table</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {/* ✅ message bar: ONLY in grid + display */}
          {showBottomHud && messageVisible ? (
            <View style={[styles.subtitleBar, { bottom: chipOffset }]}>
              <View style={{ flex: 1, overflow: "hidden" }}>
                <Animated.Text
                  onLayout={(e) => setMsgW(e.nativeEvent.layout.width)}
                  numberOfLines={1}
                  style={[
                    styles.subtitleText,
                    {
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

              <Pressable onPress={dismissMessage} hitSlop={12} style={styles.subtitleCloseBtn}>
                <Text style={styles.subtitleCloseText}>✕</Text>
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
                    isAlt={idx % 2 === 1}
                    isFresh={!!freshMap[nr]}
                    isStale={!!staleMap[nr]}   // ✅ NEW
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
                isAlt={false}
                isFresh={!!freshMap[fullscreenBoard as number]}
                isStale={!!staleMap[fullscreenBoard as number]} // ✅ NEW
              />
            </View>
          )}

          {/* ✅ PHOTO MODAL (95% screen, X close) */}
          <Modal
            visible={showPhotoDialog}
            transparent
            animationType="fade"
            onRequestClose={() => setShowPhotoDialog(false)}
          >
            <View style={styles.photoOverlay}>
              <View style={styles.photoCard}>
                <View style={styles.photoHeader}>
                  <Text style={styles.photoTitle}>Táblázat</Text>
                  <Pressable
                    onPress={() => setShowPhotoDialog(false)}
                    hitSlop={12}
                    style={styles.photoCloseBtn}
                  >
                    <Text style={styles.photoCloseText}>✕</Text>
                  </Pressable>
                </View>

                <View style={styles.photoBody}>
                  <Image source={{ uri: toImageUri(clubPhoto) }} style={styles.photoImage} resizeMode="contain" />
                </View>
              </View>
            </View>
          </Modal>

          {/* ✅ QR CHOICE DIALOG */}
          <Modal
            visible={showQrChoiceDialog}
            transparent
            animationType="fade"
            onRequestClose={() => setShowQrChoiceDialog(false)}
          >
            {/* ✅ overlay: mellékattintásra zár */}
            <Pressable
              style={styles.modalOverlay}
              onPress={() => setShowQrChoiceDialog(false)}
            >
              {/* ✅ card: ne záródjon be ha a kártyára nyomsz */}
              <Pressable style={styles.modalCard} onPress={() => {}}>
                <Text style={styles.modalTitle}>Hogyan szeretnéd használni?</Text>

                <Text style={styles.modalLabel}>
                  Club: {clubId} • Board: {qrBoard ?? "-"}
                </Text>

                <View style={styles.modalBtns}>
                  <Pressable
                    style={[styles.modalBtn, styles.modalBtnOk, styles.modalBtnWithIcon]}
                    onPress={() => void chooseScoringFromQr()}
                  >
                    <Image source={require("./keypad.png")} style={styles.modalBtnWhiteIcon} />
                    <Text style={styles.modalBtnTextOk}>SCORING</Text>
                  </Pressable>

                  <Pressable
                    style={[styles.modalBtn, styles.modalBtnGhost, styles.modalBtnWithIcon]}
                    onPress={() => void chooseDisplayFromQr()}
                  >
                    <Image source={require("./scoredisp.png")} style={styles.modalBtnIcon} />
                    <Text style={styles.modalBtnTextGhost}>DISPLAY</Text>
                  </Pressable>
                </View>
              </Pressable>
            </Pressable>
          </Modal>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0f14" },

  // base padding (works in portrait too)
  screen: { flex: 1, padding: 8 },

  grid: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
  },

  // base item paddings; width/height are set dynamically
  gridItemBase: {
    padding: 6,
  },

  fullWrap: {
    flex: 1,
    padding: 6,
  },

  // bottom-left row (scoring + table)
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

  // floating club chip (bottom-right), only in grid
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

  // ✅ subtitle / message bar (outside scoring screen, only in grid)
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

  // photo modal
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

  // fullscreen typography boost
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

  // ✅ QR CHOICE MODAL styles (copied/minimal, self-contained)
  modalBtnWithIcon: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  modalBtnIcon: {
    width: 18,
    height: 18,
    tintColor:  "rgba(7, 7, 7, 0.7)",
    resizeMode: "contain",
    opacity: 0.95,
  },
  modalBtnWhiteIcon: {
    width: 18,
    height: 18,
    tintColor:  "rgba(252, 252, 252, 0.91)",
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

  exitInline: { marginTop: 14, alignItems: "center" },
  exitInlineText: {
    color: "rgba(0,0,0,0.55)",
    fontWeight: "900",
    textDecorationLine: "underline",
  },
});