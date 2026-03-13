import { onValue, ref, remove } from "firebase/database";
import React, { useEffect, useMemo, useState } from "react";

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
import { db } from "../../lib/firebase";

type Props = {
  clubId: string;
  onExit: () => void;
};

type HistoryItem = {
  id: string;
  boardNr: number;
  raw: string;
  parts: string[];
  timestamp: number;
};

type Filters = {
  player1: string;
  player2: string;
  avgMin: string;
  avgMax: string;
};

const ACCENT_SCORE = "#b38f00";
const ACCENT_LEGS = "#326b15";

const CARD_BG = "#2f2e2d";
const BADGE_BG = "#1E1C1F";
const BADGE_TEXT_DEFAULT = "#99949494";

const DEFAULT_FILTERS: Filters = {
  player1: "",
  player2: "",
  avgMin: "",
  avgMax: "",
};

function parseBoard(raw: unknown) {
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

function formatDateTime(ts: number) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function normalizeText(v: string) {
  return (v ?? "").trim().toLowerCase();
}

function includesLoose(source: string, query: string) {
  const s = normalizeText(source);
  const q = normalizeText(query);
  if (!q) return true;
  return s.includes(q);
}

function parseFlexibleDecimal(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function getAvgRange(filters: Filters) {
  const min = parseFlexibleDecimal(filters.avgMin);
  const max = parseFlexibleDecimal(filters.avgMax);

  const lo = min ?? 0.0;
  const hi = max ?? 180.0;

  return {
    min: Math.min(lo, hi),
    max: Math.max(lo, hi),
  };
}

function isAvgInRange(avgRaw: string, min: number, max: number) {
  const n = parseFlexibleDecimal(avgRaw);
  if (n == null) return false;
  return n >= min && n <= max;
}

function hasAnyFilter(filters: Filters) {
  return !!(
    filters.player1.trim() ||
    filters.player2.trim() ||
    filters.avgMin.trim() ||
    filters.avgMax.trim()
  );
}

function matchesFilters(item: HistoryItem, filters: Filters) {
  const player1Query = filters.player1.trim();
  const player2Query = filters.player2.trim();

  const name1 = getPart(item.parts, 0, "");
  const name2 = getPart(item.parts, 1, "");
  const avg1 = getPart(item.parts, 12, "");
  const avg2 = getPart(item.parts, 13, "");

  const { min, max } = getAvgRange(filters);

  const q1Filled = !!player1Query;
  const q2Filled = !!player2Query;

  const q1MatchesPos1 = q1Filled ? includesLoose(name1, player1Query) : false;
  const q1MatchesPos2 = q1Filled ? includesLoose(name2, player1Query) : false;

  const q2MatchesPos1 = q2Filled ? includesLoose(name1, player2Query) : false;
  const q2MatchesPos2 = q2Filled ? includesLoose(name2, player2Query) : false;

  if (!q1Filled && !q2Filled) {
    return isAvgInRange(avg1, min, max) || isAvgInRange(avg2, min, max);
  }

  if (q1Filled && !q2Filled) {
    const leftOk = q1MatchesPos1 && isAvgInRange(avg1, min, max);
    const rightOk = q1MatchesPos2 && isAvgInRange(avg2, min, max);
    return leftOk || rightOk;
  }

  if (!q1Filled && q2Filled) {
    const leftOk = q2MatchesPos1 && isAvgInRange(avg1, min, max);
    const rightOk = q2MatchesPos2 && isAvgInRange(avg2, min, max);
    return leftOk || rightOk;
  }

  const directOrder =
    q1MatchesPos1 &&
    q2MatchesPos2 &&
    (isAvgInRange(avg1, min, max) || isAvgInRange(avg2, min, max));

  const swappedOrder =
    q1MatchesPos2 &&
    q2MatchesPos1 &&
    (isAvgInRange(avg2, min, max) || isAvgInRange(avg1, min, max));

  return directOrder || swappedOrder;
}

function HistoryCard(props: {
  item: HistoryItem;
  onDelete: (item: HistoryItem) => void;
}) {
  const { item, onDelete } = props;
  const parts = item.parts;

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

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.boardBadge}>
          <Text style={styles.boardBadgeText}>{item.boardNr}</Text>
        </View>

        <Text style={styles.savedAtText}>{formatDateTime(item.timestamp)}</Text>
      </View>

      <View style={styles.bodyWrap}>
        <View style={styles.nameLegsRow}>
          <Text style={styles.nameBig} numberOfLines={1}>
            {nameL}
          </Text>

          <View style={styles.legsCenter}>
            <Text style={styles.legsBig} numberOfLines={1}>
              {legsL}-{legsR}
            </Text>
          </View>

          <Text style={[styles.nameBig, styles.rightAlign]} numberOfLines={1}>
            {nameR}
          </Text>
        </View>

        <View style={styles.scoresRow}>
          <Text style={styles.scoreBig} numberOfLines={1}>
            {scoreL}
          </Text>
          <Text style={[styles.scoreBig, styles.rightAlign]} numberOfLines={1}>
            {scoreR}
          </Text>
        </View>

        <View style={styles.lastRow}>
          <Text style={styles.lastText} numberOfLines={1}>
            {lastL}
          </Text>
          <Text style={[styles.lastText, styles.rightAlign]} numberOfLines={1}>
            {lastR}
          </Text>
        </View>

        <View style={styles.avgX3Row}>
          <Text style={styles.avgX3Val} numberOfLines={1}>
            {avgX3L}
          </Text>
          <Text style={styles.avgX3Label} numberOfLines={1}>
            Avg.x3
          </Text>
          <Text style={[styles.avgX3Val, styles.rightAlign]} numberOfLines={1}>
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

        <Pressable
          onPress={() => onDelete(item)}
          hitSlop={10}
          style={({ pressed }) => [styles.deleteBtn, pressed ? styles.deleteBtnPressed : null]}
        >
          <Image source={require("./bin.png")} style={styles.deleteBtnIcon} resizeMode="contain" />
        </Pressable>
      </View>
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

export default function HistoryScreen({ clubId, onExit }: Props) {
  const { width } = useWindowDimensions();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [draftFilters, setDraftFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<HistoryItem | null>(null);

  useEffect(() => {
    const r = ref(db, `history/${clubId}`);

    const unsub = onValue(
      r,
      (snap) => {
        const v = snap.val();
        if (!v || typeof v !== "object") {
          setItems([]);
          return;
        }

        const next: HistoryItem[] = [];

        Object.entries(v).forEach(([boardKey, boardValue]) => {
          const boardNr = Number(boardKey);
          if (!Number.isFinite(boardNr)) return;
          if (!boardValue || typeof boardValue !== "object") return;

          Object.entries(boardValue as Record<string, unknown>).forEach(([id, raw]) => {
            const parsed = parseBoard(raw);
            next.push({
              id,
              boardNr,
              raw: parsed.raw,
              parts: parsed.parts,
              timestamp: parsed.timestamp,
            });
          });
        });

        next.sort((a, b) => b.timestamp - a.timestamp);
        setItems(next);
      },
      (err) => {
        console.error("[RTDB ERROR]", `history/${clubId}`, err?.message);
        setItems([]);
      }
    );

    return () => unsub();
  }, [clubId]);

  const cardWidth = useMemo(() => {
    if (width >= 1200) return 520;
    if (width >= 900) return 500;
    if (width >= 700) return 460;
    return Math.min(width - 24, 520);
  }, [width]);

  const filterActive = useMemo(() => hasAnyFilter(filters), [filters]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => matchesFilters(item, filters));
  }, [items, filters]);

  const openFilterModal = () => {
    setDraftFilters(filters);
    setShowFilterModal(true);
  };

  const applyFilters = () => {
    setFilters({
      player1: draftFilters.player1.trim(),
      player2: draftFilters.player2.trim(),
      avgMin: draftFilters.avgMin.trim(),
      avgMax: draftFilters.avgMax.trim(),
    });
    setShowFilterModal(false);
  };

  const clearFilters = () => {
    setDraftFilters(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setShowFilterModal(false);
  };

  const confirmDelete = (item: HistoryItem) => {
    setPendingDeleteItem(item);
  };

  const executeDelete = async () => {
    const item = pendingDeleteItem;
    if (!item) return;

    try {
      await remove(ref(db, `history/${clubId}/${item.boardNr}/${item.id}`));
    } catch (e) {
      console.error("[RTDB ERROR]", `history/${clubId}/${item.boardNr}/${item.id}`, e);
    } finally {
      setPendingDeleteItem(null);
    }
  };

  return (
    <View style={styles.safe}>
      <View style={styles.topBar}>
        <Pressable style={styles.topBtn} onPress={onExit}>
          <Text style={styles.topBtnText}>← Back</Text>
        </Pressable>

        <Pressable
          style={[styles.searchBtn, filterActive ? styles.searchBtnActive : null]}
          onPress={openFilterModal}
        >
          <Text
            style={[styles.searchBtnText, filterActive ? styles.searchBtnTextActive : null]}
          >
            SEARCH
          </Text>

          {filterActive ? <View style={styles.filterDot} /> : null}
        </Pressable>

        <View style={styles.topRightInfo}>
          <Text style={styles.topRightInfoText}>
            {clubId} · {filteredItems.length}/{items.length}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {filteredItems.length === 0 ? (
          <View style={[styles.emptyWrap, { width: cardWidth }]}>
            <Text style={styles.emptyTitle}>
              {items.length === 0 ? "No saved history yet." : "Nincs találat a szűrésre."}
            </Text>
            <Text style={styles.emptySub}>
              {items.length === 0
                ? "A főképernyőn a board badge-re kattintva tudsz menteni pillanatképet."
                : "Módosítsd a szűrőt, vagy töröld a feltételeket."}
            </Text>
          </View>
        ) : (
          filteredItems.map((item) => (
            <View key={`${item.boardNr}-${item.id}`} style={{ width: cardWidth }}>
              <HistoryCard item={item} onDelete={confirmDelete} />
            </View>
          ))
        )}
      </ScrollView>

      <Modal
        visible={showFilterModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowFilterModal(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowFilterModal(false)}>
          <Pressable style={styles.filterModalCard} onPress={() => {}}>
            <Text style={styles.filterModalTitle}>Szűrés</Text>

            <TextInput
              value={draftFilters.player1}
              onChangeText={(v) => setDraftFilters((prev) => ({ ...prev, player1: v }))}
              placeholder="player 1"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <TextInput
              value={draftFilters.player2}
              onChangeText={(v) => setDraftFilters((prev) => ({ ...prev, player2: v }))}
              placeholder="player 2"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.avgFilterRow}>
              <TextInput
                value={draftFilters.avgMin}
                onChangeText={(v) => setDraftFilters((prev) => ({ ...prev, avgMin: v }))}
                placeholder="0.0"
                placeholderTextColor="rgba(255,255,255,0.35)"
                style={[styles.input, styles.avgInput]}
                keyboardType="decimal-pad"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.avgBetweenLabel} numberOfLines={1}>
                {"< Avg.x3 <"}
              </Text>

              <TextInput
                value={draftFilters.avgMax}
                onChangeText={(v) => setDraftFilters((prev) => ({ ...prev, avgMax: v }))}
                placeholder="180.0"
                placeholderTextColor="rgba(255,255,255,0.35)"
                style={[styles.input, styles.avgInput]}
                keyboardType="decimal-pad"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={styles.filterActions}>
              <Pressable style={styles.filterActionGhost} onPress={clearFilters}>
                <Text style={styles.filterActionGhostText}>Törlés</Text>
              </Pressable>

              <Pressable
                style={styles.filterActionGhost}
                onPress={() => setShowFilterModal(false)}
              >
                <Text style={styles.filterActionGhostText}>Mégse</Text>
              </Pressable>

              <Pressable style={styles.filterActionOk} onPress={applyFilters}>
                <Text style={styles.filterActionOkText}>Alkalmaz</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={pendingDeleteItem != null}
        transparent
        animationType="fade"
        onRequestClose={() => setPendingDeleteItem(null)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setPendingDeleteItem(null)}>
          <Pressable style={styles.confirmModalCard} onPress={() => {}}>
            <Text style={styles.confirmTitle}>History törlése</Text>

            <Text style={styles.confirmText}>Biztosan törlöd ezt a mentést?</Text>

            <Text style={styles.confirmSubText}>
              {pendingDeleteItem
                ? `Board ${pendingDeleteItem.boardNr} • ${getPart(
                    pendingDeleteItem.parts,
                    0,
                    "—"
                  )} vs ${getPart(pendingDeleteItem.parts, 1, "—")}`
                : ""}
            </Text>

            <View style={styles.filterActions}>
              <Pressable
                style={styles.filterActionGhost}
                onPress={() => setPendingDeleteItem(null)}
              >
                <Text style={styles.filterActionGhostText}>Mégse</Text>
              </Pressable>

              <Pressable style={styles.deleteConfirmBtn} onPress={() => void executeDelete()}>
                <Text style={styles.deleteConfirmBtnText}>Törlés</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0f14" },

  topBar: {
    height: 64,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.10)",
    position: "relative",
  },
  filterDot: {
    position: "absolute",
    right: 6,
    top: 6,
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: "#3DFF2F",
  },
  searchBtn: {
    position: "absolute",
    left: "50%",
    transform: [{ translateX: -50 }],
    paddingHorizontal: 18,
    height: 40,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  searchBtnActive: {
    backgroundColor: "rgba(61,255,47,0.18)",
    borderColor: "rgba(61,255,47,0.55)",
  },
  searchBtnText: {
    color: "rgba(255,255,255,0.92)",
    fontWeight: "900",
    fontSize: 14,
    letterSpacing: 0.5,
  },
  searchBtnTextActive: {
    color: "#b9ffb2",
  },
  topBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  topBtnText: {
    color: "rgba(255,255,255,0.92)",
    fontWeight: "900",
    fontSize: 14,
  },
  topRightInfo: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  topRightInfoText: {
    color: "rgba(255,255,255,0.82)",
    fontWeight: "900",
    fontSize: 13,
  },

  scroll: { flex: 1 },
  scrollContent: {
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 16,
    gap: 14,
  },

  emptyWrap: {
    marginTop: 20,
    padding: 18,
    borderRadius: 16,
    backgroundColor: "#2f2e2d",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  emptyTitle: {
    color: "white",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 8,
  },
  emptySub: {
    color: "rgba(255,255,255,0.68)",
    fontSize: 14,
    lineHeight: 20,
  },

  card: {
    borderRadius: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: CARD_BG,
    overflow: "hidden",
  },

  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },

  boardBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: BADGE_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  boardBadgeText: {
    fontSize: 13,
    fontWeight: "900",
    color: BADGE_TEXT_DEFAULT,
  },
  savedAtText: {
    color: "rgba(255,255,255,0.58)",
    fontSize: 12,
    fontWeight: "800",
  },

  bodyWrap: {
    position: "relative",
    paddingBottom: 44,
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
    minWidth: 0,
    color: ACCENT_SCORE,
    fontSize: 22,
    fontWeight: "900",
  },
  avgX3Label: {
    minWidth: 0,
    width: "auto",
    flexShrink: 0,
    paddingHorizontal: 12,
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
  deleteBtnIcon: {
    width: 18,
    height: 18,
    opacity: 0.9,
  },

  deleteBtn: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  deleteBtnPressed: {
    opacity: 0.7,
  },
  deleteBtnText: {
    fontSize: 16,
    lineHeight: 18,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  filterModalCard: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "#1b1f25",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    gap: 12,
  },
  filterModalTitle: {
    color: "white",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 2,
  },
  input: {
    height: 44,
    borderRadius: 12,
    paddingHorizontal: 12,
    color: "white",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    fontSize: 14,
    fontWeight: "700",
  },
  avgFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  avgInput: {
    width: 86,
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
  },
  avgBetweenLabel: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 14,
    fontWeight: "900",
    flexShrink: 0,
  },
  filterActions: {
    marginTop: 6,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  filterActionGhost: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  filterActionGhostText: {
    color: "rgba(255,255,255,0.9)",
    fontWeight: "900",
    fontSize: 14,
  },
  filterActionOk: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#2f6f18",
  },
  filterActionOkText: {
    color: "white",
    fontWeight: "900",
    fontSize: 14,
  },

  confirmModalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#1b1f25",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    gap: 12,
  },
  confirmTitle: {
    color: "white",
    fontSize: 18,
    fontWeight: "900",
  },
  confirmText: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 15,
    fontWeight: "800",
  },
  confirmSubText: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 13,
    lineHeight: 18,
  },
  deleteConfirmBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#8f1f1f",
  },
  deleteConfirmBtnText: {
    color: "white",
    fontWeight: "900",
    fontSize: 14,
  },
});