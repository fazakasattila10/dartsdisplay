
import { equalTo, get, orderByChild, query, ref, set } from 'firebase/database';
import { db } from '../../lib/firebase';
const DEVICE_ID_KEY = 'broadcast.deviceId';
const BOARD_ID_KEY = 'broadcast.boardId';
const WATCHED_KEY = 'broadcast.watchedIds';
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const memoryStore: Record<string, string> = {};

function hasLocalStorage() {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function readStore(key: string): string | null {
  try {
    if (hasLocalStorage()) return window.localStorage.getItem(key);
  } catch {}
  return memoryStore[key] ?? null;
}

function writeStore(key: string, value: string) {
  try {
    if (hasLocalStorage()) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch {}
  memoryStore[key] = value;
}

function randomId(len: number) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += CHARS[Math.floor(Math.random() * CHARS.length)];
  return out;
}

export function getOrCreateDeviceId() {
  const existing = readStore(DEVICE_ID_KEY);
  if (existing) return existing;
  const next = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  writeStore(DEVICE_ID_KEY, next);
  return next;
}

export async function getOrCreateBoardId(deviceId: string) {
  const cached = readStore(BOARD_ID_KEY);
  if (cached) return cached;

  try {
    const q = query(ref(db, 'boards'), orderByChild('deviceId'), equalTo(deviceId));
    const existingSnap = await get(q);

    if (existingSnap.exists()) {
      const value = existingSnap.val() as Record<string, any>;
      const existingBoardId = Object.keys(value)[0];
      if (existingBoardId) {
        writeStore(BOARD_ID_KEY, existingBoardId);
        return existingBoardId;
      }
    }
  } catch {}

  while (true) {
    const candidate = randomId(6);
    const snap = await get(ref(db, `boards/${candidate}`));
    if (!snap.exists()) {
      writeStore(BOARD_ID_KEY, candidate);
      return candidate;
    }
  }
}

export function getSavedWatchedIds(): string[] {
  try {
    const raw = readStore(WATCHED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v || '').trim().toUpperCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveWatchedIds(ids: string[]) {
  const cleaned = Array.from(new Set(ids.map((v) => String(v || '').trim().toUpperCase()).filter(Boolean))).slice(0, 30);
  writeStore(WATCHED_KEY, JSON.stringify(cleaned));
}

export function addWatchedId(id: string) {
  const ids = getSavedWatchedIds();
  if (!ids.includes(id)) saveWatchedIds([id, ...ids]);
}

export function parseBoardIdFromText(input: string): string | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const match = raw.match(/[?&]board=([A-Z0-9]{6})/i) || raw.match(/\b([A-Z0-9]{6})\b/);
  if (!match) return null;
  return String(match[1]).toUpperCase();
}

export function buildBoardShareUrl(boardId: string) {
  return `https://dartsdisplay.backrec.eu/?board=${boardId}`;
}

export function buildQrImageUrl(text: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(text)}`;
}

export async function publishBoardRecord(params: {
  boardId: string;
  kind: 'score' | 'cricket';
  stats: string;
  deviceId: string;
  lat?: number | null;
  lng?: number | null;
}) {
  await set(ref(db, `boards/${params.boardId}`), {
    kind: params.kind,
    stats: params.stats,
    deviceId: params.deviceId,
    lat: params.lat ?? null,
    lng: params.lng ?? null,
    timestamp: Date.now(),
  });
}

export function requestBrowserLikeLocation(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    try {
      const geo = typeof navigator !== 'undefined' ? (navigator as any).geolocation : null;
      if (!geo?.getCurrentPosition) {
        resolve(null);
        return;
      }
      geo.getCurrentPosition(
        (pos: any) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, maximumAge: 60000, timeout: 10000 }
      );
    } catch {
      resolve(null);
    }
  });
}

export function getDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
