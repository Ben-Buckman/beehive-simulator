import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { View, StyleSheet, Animated, Easing, Dimensions, TouchableOpacity, Text, ScrollView } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Svg, { Path, G, Ellipse } from 'react-native-svg';

const { width: W, height: H } = Dimensions.get('window');
const IS_MOBILE = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

// Hive dimensions
const HIVE_W = 160;
const BOX_H = 68;
const LID_W = HIVE_W + 22;
const LID_H = 22;
const INNER_H = 6;
const BB_H = 20;
const STAND_H = 18;
const ENTRANCE_W = 58;
const ENTRANCE_H = 7;

const GROUND_Y = H * 0.80;
const ENT_X = W / 2;
const LAND_Y = GROUND_Y - STAND_H - ENTRANCE_H / 2 - 2;
// HIVE_TOP is now computed dynamically as hiveTop(boxStack) in homePos/App

// ── Frames ───────────────────────────────────────────────────────────────────

const FRAME_W = HIVE_W / 10;   // 16px
const FRAME_PEEK = 3;
const FRAME_INNER_H = BOX_H - 4; // 64px

// Hex cell: 5.4mm flat-to-flat → s ≈ 1.21px
const HEX_S = 1.21;

// ── Lifecycle constants ───────────────────────────────────────────────────────

const HOUR_MS               = 3_600_000;
const DAY_MS                = 86_400_000;
const EGG_DURATION_MS       = 72  * HOUR_MS;   // 259_200_000
const LARVA_CAP_MS          = 204 * HOUR_MS;   // 734_400_000  (72h + 132h)
const EMERGE_MS             = 492 * HOUR_MS;   // 1_771_200_000 (20.5 days total)
const ADULT_LIFESPAN_MS     = 42  * DAY_MS;    // 3_628_800_000
const LAY_INTERVAL_MS       = 57_600;           // ~57.6s = 1,500 eggs/day
const QUEEN_SPEED_PX_PER_MS  = 0.000774;        // 2 mm/s × 0.387 px/mm (measured, Scientific Reports 2025)
const LAY_INTERVAL_ACTIVE_MS = 12_000;           // 12s/egg in burst (5/min = real peak rate)
const BURST_EGGS_MIN         = 15;               // eggs per laying burst
const BURST_EGGS_MAX         = 25;
const REST_MIN_MS            = 5  * 60_000;      // queen rest between bursts: 5 min
const REST_MAX_MS            = 20 * 60_000;      //                           20 min
const INSPECT_DWELL_MIN_MS   = 1_000;            // pause at each visited cell: 1s
const INSPECT_DWELL_MAX_MS   = 3_000;            //                             3s
const MAX_COLONY_SIZE        = 50_000;
const BROOD_CHECK_MS         = 1_000;
const STORAGE_KEY            = 'hive-sim-v1';

// ── Forager / resource constants ──────────────────────────────────────────────
// Biology: foragers (21d+) make ~10 trips/day; ~60% nectar, ~40% pollen.
// Nectar trip ~2h simulated; trophallaxis (bee-to-bee transfer) ~3 min sim.
// Nectar → honey ~2 simulated days of evaporation.
const FORAGER_AGE_MS           = 21 * DAY_MS;    // simulated age when foraging begins
const RECEIVER_AGE_MIN_MS      = 12 * DAY_MS;    // 12–18d age range: nectar receivers
const RECEIVER_AGE_MAX_MS      = 18 * DAY_MS;
const FORAGER_TRIP_MS          = 2  * HOUR_MS;   // simulated foraging trip duration
const TROPHALLAXIS_MS          = 3  * 60_000;    // simulated trophallaxis duration
const NECTAR_TO_HONEY_MS       = 2  * DAY_MS;    // simulated nectar→honey conversion
const FORAGER_TRIP_PROB_PER_S  = 50 / (24 * 60 * 60); // visible sim: ~50 trip checks/day per eligible forager
const MAX_OUTSIDE_FORAGER_FRACTION = 0.08;            // cap visible flyers so the exterior never overwhelms frame bees

// ── Comb drawing (wax building) ───────────────────────────────────────────────
// Biology: colony draws ~1 full frame (≈1,800 hex cells in COMB_W×COMB_H) in
// 1–3 days at peak. Rate scales with colony size.
// At 50,000 bees: 1 cell / 20 s → full frame ≈ 10 h  (biological scale)
// At 10,000 bees: 1 cell / 100 s → full frame ≈ 55 h
const WAX_PER_CELL            = 1.0;                               // normalised unit
const WAX_RATE_PER_BEE_PER_MS = WAX_PER_CELL / (50_000 * 20_000); // 1 cell/20s at 50 k bees

// ── Types ─────────────────────────────────────────────────────────────────────

type CellType = 'egg' | 'larvae' | 'capped_brood' | 'pollen' | 'nectar' | 'honey' | 'capped_honey' | 'empty' | 'foundation';

interface CellInfo {
  cx: number; cy: number; type: CellType; color: string;
  r: number; c: number;
  larvalInstar?: 1|2|3|4|5;
  rotation?: number;
}

type CellOverride = {
  type: CellType;
  larvalInstar?: 1|2|3|4|5;
  rotation?: number;
  layTime?: number; // stored for larvae so rotation can be computed from sim age
};

interface QueenState {
  frameKey: string;   // stable frame ID e.g. '4' (box1 slot4), '13' (box2 slot3)
  x: number; y: number;
  angle: number;
  txTarget: number; tyTarget: number;
  nextLayTime: number;
  layDirection: 1 | -1;
  layRow: number;
}

interface HivePersistentState {
  version: 2;
  initTime: number;
  lastSaveTime: number;
  simSpeed?: number;       // speed active at save time; restored on load so brood timestamps stay valid
  totalAdultBees: number; // snapshot for display on load; recomputed from frameBeeStore each tick
  queen: QueenState;
  broodCells: Record<string, number>;  // "${frameKey}:${r}:${c}" → layTime
  boxStack: string[];                  // box IDs top→bottom between inner and bottom board
  boxFrames: Record<string, (string | null)[]>; // boxId → 10-slot frame array; null = empty slot
  drawnCells: Record<string, string[]>; // frameKey → ["r:c", ...] drawn cell keys (blank frames only)
  resourceCells?: ResourceCellStore;   // live honey/nectar/pollen cell store
  simTimeMs?: number;                  // accumulated simulated milliseconds (for clock display)
}

// ── Cell colours ──────────────────────────────────────────────────────────────

const POLLEN_COLOR = '#E8A000';

const CELL_FILL: Record<CellType, string> = {
  egg:          '#0D0D0D',
  larvae:       '#0D0D0D',
  capped_brood: '#C8906A',
  pollen:       POLLEN_COLOR,
  nectar:       '#FDFAD8',
  honey:        '#C08010',  // ripened but not yet wax-capped
  capped_honey: '#C08010',  // same amber; wax-cap lines distinguish it visually
  empty:        '#18120A',
  foundation:   '#C8BA8A',
};

const LARVA_PARAMS: Record<1|2|3|4|5, { r: number; sw: number; span: number }> = {
  1: { r: HEX_S * 0.182, sw: 0.14, span: Math.PI },
  2: { r: HEX_S * 0.289, sw: 0.22, span: Math.PI },
  3: { r: HEX_S * 0.372, sw: 0.35, span: Math.PI },
  4: { r: HEX_S * 0.455, sw: 0.50, span: Math.PI * 1.22 },
  5: { r: HEX_S * 0.496, sw: 0.70, span: Math.PI * 1.50 },
};

// Simulated-time period (ms) for one full larval rotation per instar.
// Instar 1 barely moves; instar 5 is actively spinning before capping.
// Based on observed ~0.5–1 rotation/hour for active instars (Seeley 1985).
const LARVA_ROT_PERIOD_MS: Record<1|2|3|4|5, number> = {
  1: 4 * HOUR_MS,
  2: 3 * HOUR_MS,
  3: 2 * HOUR_MS,
  4: 90 * 60_000,
  5: 1 * HOUR_MS,
};

function cellCoords(r: number, c: number): { cx: number; cy: number } {
  const colStep = HEX_S * Math.sqrt(3);
  return { cx: c * colStep + (r % 2 === 1 ? colStep / 2 : 0), cy: r * 1.5 * HEX_S };
}

function hexPathStr(cx: number, cy: number, s: number): string {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(cx + s * Math.cos(a)).toFixed(2)},${(cy + s * Math.sin(a)).toFixed(2)}`;
  }).join(' L ');
  return `M ${pts} Z`;
}

function generateCells(w: number, h: number, seed: number): CellInfo[] {
  if (seed <= 0) {
    // Blank foundation frame — all empty drawn wax
    const cells: CellInfo[] = [];
    const s = HEX_S;
    const colStep = s * Math.sqrt(3), rowStep = 1.5 * s;
    const rows = Math.ceil(h / rowStep) + 2, cols = Math.ceil(w / colStep) + 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = c * colStep + (r % 2 === 1 ? colStep / 2 : 0);
        const cy = r * rowStep;
        if (cx > w + s || cy > h + s) continue;
        cells.push({ cx, cy, type: 'empty', color: CELL_FILL.empty, r, c });
      }
    }
    return cells;
  }
  const s = HEX_S;
  const colStep = s * Math.sqrt(3);
  const rowStep = 1.5 * s;
  const cells: CellInfo[] = [];
  const rows = Math.ceil(h / rowStep) + 2;
  const cols = Math.ceil(w / colStep) + 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = c * colStep + (r % 2 === 1 ? colStep / 2 : 0);
      const cy = r * rowStep;
      if (cx > w + s || cy > h + s) continue;
      cells.push({ cx, cy, type: 'empty', color: CELL_FILL.empty, r, c });
    }
  }
  return cells;
}

// Derives comb cell type from lay timestamp — no side effects.
function getLifeStage(layTime: number, now: number, speed: number = 1): CellOverride & { emerged: boolean } {
  const age = (now - layTime) * speed;
  if (age < 0) return { type: 'empty', emerged: false };
  if (age < EGG_DURATION_MS) return { type: 'egg', emerged: false };
  if (age < LARVA_CAP_MS) {
    const h = (age - EGG_DURATION_MS) / HOUR_MS;
    const larvalInstar: 1|2|3|4|5 =
      h < 20 ? 1 : h < 44 ? 2 : h < 72 ? 3 : h < 100 ? 4 : 5;
    return { type: 'larvae', larvalInstar, emerged: false };
  }
  if (age < EMERGE_MS) return { type: 'capped_brood', emerged: false };
  return { type: 'empty', emerged: true };
}

// Pulled frame face dimensions
const FACE_W = HIVE_W;
const FACE_H = FRAME_INNER_H;
const FACE_SIDE_BAR = 6;
const FACE_TOP_BAR  = 6;
const FACE_BOT_BAR  = 4;
const COMB_W = FACE_W - FACE_SIDE_BAR * 2;  // 148px
const COMB_H = FACE_H - FACE_TOP_BAR - FACE_BOT_BAR; // 54px

// Precomputed brood-zone cell positions for each frame index (queen navigation).
const BROOD_ZONE_CELLS: Map<number, Array<{r:number;c:number;cx:number;cy:number}>> = (() => {
  const map = new Map<number, Array<{r:number;c:number;cx:number;cy:number}>>();
  const s = HEX_S;
  const colStep = s * Math.sqrt(3);
  const rowStep = 1.5 * s;
  const w = COMB_W, h = COMB_H;
  const rows = Math.ceil(h / rowStep) + 2;
  const cols = Math.ceil(w / colStep) + 2;
  const bx = w * 0.50, by = h * 0.56;
  const brx = w * 0.36, bry = h * 0.40;

  for (let frameIdx = 0; frameIdx < 10; frameIdx++) {
    const centerDist = Math.abs(frameIdx - 4.5) / 4.5;
    const broodScale = 1.0 + centerDist * 0.55;
    const cells: Array<{r:number;c:number;cx:number;cy:number}> = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = c * colStep + (r % 2 === 1 ? colStep / 2 : 0);
        const cy = r * rowStep;
        if (cx > w + s || cy > h + s) continue;
        const ndx = (cx - bx) / brx;
        const ndy = (cy - by) / bry;
        const bd = Math.sqrt(ndx * ndx + ndy * ndy) * broodScale;
        if (bd < 0.83) {
          cells.push({ r, c, cx, cy });
        }
      }
    }
    cells.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    map.set(frameIdx, cells);
  }
  return map;
})();


// Draw order for blank frames: cells sorted top-centre first, matching the
// natural pattern where bees build downward from the top bar.
const BLANK_FRAME_DRAW_ORDER: Array<{r:number;c:number;cx:number;cy:number}> = (() => {
  const cx = COMB_W / 2;
  return generateCells(COMB_W, COMB_H, 0)
    .slice()
    .sort((a, b) => (a.cy * 0.7 + Math.abs(a.cx - cx) * 0.3) - (b.cy * 0.7 + Math.abs(b.cx - cx) * 0.3));
})();

// Subset of BLANK_FRAME_DRAW_ORDER that falls within the standard brood zone.
// Queen will only lay in these cells once drawn.
const BLANK_BROOD_ZONE: Array<{r:number;c:number;cx:number;cy:number}> = (() => {
  const bx = COMB_W * 0.50, by = COMB_H * 0.56;
  const brx = COMB_W * 0.36, bry = COMB_H * 0.40;
  return BLANK_FRAME_DRAW_ORDER.filter(cell => {
    const ndx = (cell.cx - bx) / brx, ndy = (cell.cy - by) / bry;
    return Math.sqrt(ndx * ndx + ndy * ndy) < 0.83;
  });
})();

// ── localStorage helpers ──────────────────────────────────────────────────────

// Frame key conventions:
//   box1 slots 0-9  → keys '0'-'9'   (seed = n+1, zoneIdx = n%10)
//   box2 slots 0-9  → keys '10'-'19' (seed = n+1, zoneIdx = n%10)
//   additional boxes → keys '20'+ in groups of 10
//   new blank frames → keys 'n${timestamp}' (no brood zone)
function frameSeedOf(frameKey: string): number {
  const n = parseInt(frameKey);
  return isNaN(n) ? 0 : n + 1;  // 0 = blank
}
function getFrameZoneCells(frameKey: string): Array<{r:number;c:number;cx:number;cy:number}> {
  const n = parseInt(frameKey);
  if (isNaN(n)) return [];
  return BROOD_ZONE_CELLS.get(n % 10) ?? [];
}

// ── Comb zone helpers ─────────────────────────────────────────────────────────
// Each cell's zone is determined by its normalized distance from the brood oval.
// Mirrors the logic in generateCells so bees target the correct zones.
function cellBd(r: number, c: number, frameIdx: number): number {
  const { cx, cy } = cellCoords(r, c);
  const ndx = (cx - COMB_W * 0.50) / (COMB_W * 0.36);
  const ndy = (cy - COMB_H * 0.56) / (COMB_H * 0.40);
  const centerDist = Math.abs(frameIdx - 4.5) / 4.5;
  const broodScale = 1.0 + centerDist * 0.55;
  return Math.sqrt(ndx * ndx + ndy * ndy) * broodScale;
}
function isNectarZone(r: number, c: number, frameIdx: number): boolean {
  const { cx, cy } = cellCoords(r, c);
  const bd = cellBd(r, c, frameIdx);
  const topFrac = 1.0 - cy / COMB_H;
  return bd > 1.18 || (topFrac > 0.72 && bd > 0.65);
}
function isPollenZone(r: number, c: number, frameIdx: number): boolean {
  const bd = cellBd(r, c, frameIdx);
  return bd >= 0.80 && bd < 1.18;
}
// Return the slot index (0-9) of a frame within its box — used for zone calculations on user-added frames.
function frameSlotIndex(frameKey: string): number {
  for (const frames of Object.values(globalBoxFrames)) {
    const idx = frames.indexOf(frameKey);
    if (idx >= 0) return idx;
  }
  return 4; // fallback: treat as a center frame
}

// Find an empty cell in the target zone for resource deposit
function findResourceDepositCell(
  frameKey: string, zone: 'nectar' | 'pollen',
  brood: Record<string, number>, resources: ResourceCellStore,
): { frameKey: string; r: number; c: number; cx: number; cy: number } | null {
  const n = parseInt(frameKey);
  const isBlankKey = isNaN(n);
  // For user-added blank frames ('n1', 'n2', …) use their slot position for zone calculation
  const fi   = isBlankKey ? frameSlotIndex(frameKey) : n % 10;
  const seed = isBlankKey ? (parseInt(frameKey.slice(1)) || 0) + 1 : n + 1;
  const cells = generateCells(COMB_W, COMB_H, seed);
  // For blank frames, only target cells that have already been drawn (wax laid)
  const drawnSet = isBlankKey
    ? new Set(getDrawnCells?.()[frameKey] ?? [])
    : null;
  const cands = cells.filter(cell => {
    const key = `${frameKey}:${cell.r}:${cell.c}`;
    if (key in brood || key in resources) return false;
    if (drawnSet && !drawnSet.has(`${cell.r}:${cell.c}`)) return false;
    return zone === 'nectar' ? isNectarZone(cell.r, cell.c, fi) : isPollenZone(cell.r, cell.c, fi);
  });
  if (!cands.length) return null;
  const cell = cands[Math.floor(Math.random() * cands.length)];
  return { frameKey, r: cell.r, c: cell.c, cx: cell.cx, cy: cell.cy };
}

// Hex-grid neighbours in offset coordinates (odd rows shifted right).
function hexNeighbors(r: number, c: number): Array<{r:number;c:number}> {
  return r % 2 === 0
    ? [{r:r-1,c:c-1},{r:r-1,c},{r,c:c-1},{r,c:c+1},{r:r+1,c:c-1},{r:r+1,c}]
    : [{r:r-1,c},{r:r-1,c:c+1},{r,c:c-1},{r,c:c+1},{r:r+1,c},{r:r+1,c:c+1}];
}

// Deposit nectar into a cluster of adjacent nectar-zone cells radiating from seedCell.
// Represents a receiver bee spreading a forager's load across nearby open cells.
function depositNectarCluster(
  frameKey: string, seed: {r:number;c:number},
  brood: Record<string,number>, resources: ResourceCellStore, now: number,
  clusterSize = 3,
): void {
  const n = parseInt(frameKey);
  const isBlankKey = isNaN(n);
  const fi = isBlankKey ? frameSlotIndex(frameKey) : n % 10;
  const seedNum = isBlankKey ? (parseInt(frameKey.slice(1)) || 0) + 1 : n + 1;
  const drawnSet = isBlankKey
    ? new Set(getDrawnCells?.()[frameKey] ?? [])
    : null;
  const allCells = generateCells(COMB_W, COMB_H, seedNum);
  const cellIndex = new Map(allCells.map(c => [`${c.r}:${c.c}`, c]));
  const visited = new Set<string>();
  const queue: Array<{r:number;c:number}> = [seed];
  visited.add(`${seed.r}:${seed.c}`);
  let deposited = 0;
  let first = true;
  while (queue.length > 0 && deposited < clusterSize) {
    const curr = queue.shift()!;
    const key = `${frameKey}:${curr.r}:${curr.c}`;
    // Seed cell is pre-validated by findResourceDepositCell; neighbours must also be in the nectar zone
    const cellKey = `${curr.r}:${curr.c}`;
    const drawnOk = !drawnSet || drawnSet.has(cellKey);
    if (drawnOk && !(key in brood) && !(key in resources) && (first || isNectarZone(curr.r, curr.c, fi))) {
      resources[key] = { kind: 'nectar', depositedAt: now };
      deposited++;
    }
    first = false;
    for (const nb of hexNeighbors(curr.r, curr.c)) {
      const nk = `${nb.r}:${nb.c}`;
      if (visited.has(nk) || !cellIndex.has(nk)) continue;
      visited.add(nk);
      queue.push(nb);
    }
  }
}

// Find a deposit cell across hive frames.
// Nectar: restricted to the topmost box; frames ordered outer→inner so honey naturally
// accumulates at the edges first, leaving centre frames available for any brood overflow.
// Pollen: searches all boxes but prefers the current (preferred) frame.
function findResourceDepositCellAcrossHive(
  preferredFk: string, zone: 'nectar' | 'pollen',
  brood: Record<string, number>, resources: ResourceCellStore,
): { frameKey: string; r: number; c: number; cx: number; cy: number } | null {
  if (zone === 'nectar') {
    // Only deposit nectar in the topmost box — bees carry it up before releasing
    const topBoxId = globalBoxStack[0];
    if (!topBoxId) return null;
    const topSlots = (globalBoxFrames[topBoxId] ?? []).filter((x): x is string => x !== null);
    if (!topSlots.length) return null;
    // Sort: preferred frame first, then outer frames (distance from centre), then inner
    const mid = (topSlots.length - 1) / 2;
    // Only include preferredFk at the front if it's actually in the top box
    const prefInTop = topSlots.includes(preferredFk);
    const ordered = [
      ...(prefInTop ? [preferredFk] : []),
      ...topSlots
        .filter(fk => fk !== preferredFk)
        .sort((a, b) => {
          const ai = topSlots.indexOf(a), bi = topSlots.indexOf(b);
          return Math.abs(bi - mid) - Math.abs(ai - mid); // outer frames first
        }),
    ];
    for (const fk of ordered) {
      const cell = findResourceDepositCell(fk, 'nectar', brood, resources);
      if (cell) return cell;
    }
    return null;
  }
  // Pollen: preferred frame first, then others in random order
  const preferred = findResourceDepositCell(preferredFk, zone, brood, resources);
  if (preferred) return preferred;
  const allFks = Object.keys(frameBeeStore).filter(fk => fk !== preferredFk);
  const shuffled = allFks.sort(() => Math.random() - 0.5);
  for (const fk of shuffled) {
    const cell = findResourceDepositCell(fk, zone, brood, resources);
    if (cell) return cell;
  }
  return null;
}

function defaultBoxStack(): string[] { return ['box1', 'box2']; }
function defaultBoxFrames(): Record<string, (string | null)[]> {
  return {
    box1: Array.from({ length: 10 }, (_, i) => String(i)),
    box2: Array.from({ length: 10 }, (_, i) => String(i + 10)),
  };
}

function migrateV1toV2(v1: any): HivePersistentState {
  const boxStack = defaultBoxStack();
  const boxFrames = defaultBoxFrames();
  const broodCells: Record<string, number> = {};
  for (const [key, layTime] of Object.entries(v1.broodCells as Record<string, number>)) {
    const parts = key.split(':');
    const box = parts[0], fidxStr = parts[1], rc = parts.slice(2).join(':');
    const fidx = parseInt(fidxStr);
    const newKey = box === 'box1' ? `${fidx}:${rc}` : `${fidx + 10}:${rc}`;
    broodCells[newKey] = layTime as number;
  }
  const oq = v1.queen as any;
  const queen: QueenState = {
    frameKey: oq.box === 'box1' ? String(oq.frameIdx) : String(oq.frameIdx + 10),
    x: oq.x, y: oq.y, angle: oq.angle,
    txTarget: oq.txTarget, tyTarget: oq.tyTarget,
    nextLayTime: oq.nextLayTime,
    layDirection: oq.layDirection ?? 1, layRow: oq.layRow ?? 0,
  };
  return { version: 2, initTime: v1.initTime, lastSaveTime: v1.lastSaveTime,
    totalAdultBees: v1.totalAdultBees ?? 0,
    queen, broodCells, boxStack, boxFrames, drawnCells: {} };
}

function loadHiveState(): HivePersistentState | null {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1) return migrateV1toV2(parsed);
    if (parsed?.version !== 2) return null;
    // Drop obsolete emergenceTimes from old saves (population is now derived from frameBeeStore)
    delete parsed.emergenceTimes;
    delete parsed.emergenceDays;
    return parsed as HivePersistentState;
  } catch {
    return null;
  }
}

function saveHiveState(state: HivePersistentState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    state.lastSaveTime = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota exceeded */ }
}

function initHiveState(): HivePersistentState {
  const now = Date.now();
  const boxStack = defaultBoxStack();
  const boxFrames = defaultBoxFrames();

  const broodCells: Record<string, number> = {};

  const queen: QueenState = {
    frameKey: '4',
    x: COMB_W * 0.50, y: COMB_H * 0.56, angle: 0,
    txTarget: COMB_W * 0.50, tyTarget: COMB_H * 0.56,
    nextLayTime: now + LAY_INTERVAL_MS,
    layDirection: 1, layRow: 0,
  };

  return { version: 2, initTime: now, lastSaveTime: now,
    totalAdultBees: 0, queen, broodCells, boxStack, boxFrames, drawnCells: {} };
}

// Nearest cell the queen can lay in: must be empty drawn comb right now.
// Cells containing honey, pollen, nectar, or active brood are excluded.
// Find the queen's next laying target using a biologically accurate scoring:
// strongly prefer inner (low brood-distance) cells so the queen works outward in a
// spiral from the centre, with a secondary preference for cells close to her current
// position to keep movement local.
function findBestLayTarget(
  q: QueenState,
  broodCells: Record<string, number>,
  now: number,
  drawnCells: Record<string, string[]> = {},
  recentCells: Set<string> = new Set(),
  skippedCells: Map<string, number> = new Map(),
): { r: number; c: number; cx: number; cy: number } | null {
  const isBlank = q.frameKey.startsWith('n');
  let cells: Array<{r:number;c:number;cx:number;cy:number}>;
  if (isBlank) {
    const drawnSet = new Set(drawnCells[q.frameKey] ?? []);
    cells = BLANK_BROOD_ZONE.filter(c => drawnSet.has(`${c.r}:${c.c}`));
  } else {
    cells = getFrameZoneCells(q.frameKey);
  }
  if (!cells.length) return null;
  const n = parseInt(q.frameKey);
  const fi = isNaN(n) ? 4 : n % 10;
  let best: { r: number; c: number; cx: number; cy: number } | null = null;
  let bestScore = Infinity;
  for (const cell of cells) {
    // Skip cells recently visited (short-term) or permanently rejected (until brood cycle expires)
    if (recentCells.has(`${cell.r}:${cell.c}`)) continue;
    const key = `${q.frameKey}:${cell.r}:${cell.c}`;
    if (skippedCells.has(key)) continue;
    if (key in broodCells && now - broodCells[key] < EMERGE_MS) continue;
    const qDist = Math.hypot(cell.cx - q.x, cell.cy - q.y);
    const bd = cellBd(cell.r, cell.c, fi);
    // Inner cells (low bd) weighted 8× over proximity — drives outward spiral
    const score = bd * 8 + qDist / COMB_W;
    if (score < bestScore) { bestScore = score; best = cell; }
  }
  return best;
}

// Lévy-walk next target for queen: step distance drawn from Pareto(α=1),
// which produces a power-law with exponent μ = 2 — the optimal value for
// searching an unknown area (measured exponent ≈ 2 in tracking study).
// Skips recently visited cells to implement observed anti-revisiting behaviour.
function pickLevyTarget(
  q: QueenState,
  recentCells: Set<string>,
  rand: () => number,
  drawnCells: Record<string, string[]> = {},
): {r:number;c:number;cx:number;cy:number} | null {
  let cells: Array<{r:number;c:number;cx:number;cy:number}>;
  if (q.frameKey.startsWith('n')) {
    const drawnSet = new Set(drawnCells[q.frameKey] ?? []);
    cells = BLANK_BROOD_ZONE.filter(c => drawnSet.has(`${c.r}:${c.c}`));
  } else {
    cells = getFrameZoneCells(q.frameKey);
  }
  if (!cells.length) return null;
  // Pareto sample: d = d_min / u, d_min = 2px (≈ one hex step)
  const u = Math.max(rand(), 0.02);
  const stepDist = Math.min(2 / u, COMB_W * 0.85);
  const angle = rand() * Math.PI * 2;
  // Blend random direction with a 30% pull toward the brood-centre oval so the
  // queen's Lévy walk stays concentrated in the brood nest.
  const bx = COMB_W * 0.50, by = COMB_H * 0.56;
  const toCx = bx - q.x, toCy = by - q.y;
  const toCLen = Math.max(Math.hypot(toCx, toCy), 1);
  const CENTER_BIAS = 0.30;
  const dirX = (1 - CENTER_BIAS) * Math.cos(angle) + CENTER_BIAS * (toCx / toCLen);
  const dirY = (1 - CENTER_BIAS) * Math.sin(angle) + CENTER_BIAS * (toCy / toCLen);
  const dirLen = Math.max(Math.hypot(dirX, dirY), 0.001);
  const tx = q.x + (dirX / dirLen) * stepDist;
  const ty = q.y + (dirY / dirLen) * stepDist;
  let best: {r:number;c:number;cx:number;cy:number} | null = null;
  let bestDist = Infinity;
  for (const cell of cells) {
    if (recentCells.has(`${cell.r}:${cell.c}`)) continue;
    const d = Math.hypot(cell.cx - tx, cell.cy - ty);
    if (d < bestDist) { bestDist = d; best = cell; }
  }
  if (!best) { recentCells.clear(); return cells[Math.floor(rand() * cells.length)]; }
  return best;
}

// ── Comb SVG ──────────────────────────────────────────────────────────────────

function buildCombSVG(cells: CellInfo[], s: number, overrides?: Map<string, CellOverride>, drawnSet?: Set<string>, frameKey?: string) {
  const fills = new Map<string, string>();
  let eggPath = '';
  let capPath = '';

  for (const cell of cells) {
    const cellKey = `${cell.r}:${cell.c}`;
    if (drawnSet && !drawnSet.has(cellKey)) {
      fills.set(CELL_FILL.foundation, (fills.get(CELL_FILL.foundation) ?? '') + hexPathStr(cell.cx, cell.cy, s));
      continue;
    }
    const ov = overrides?.get(cellKey);
    // Brood override wins; otherwise read resources directly from module-level store (always fresh)
    let type = ov?.type ?? cell.type;
    if (type === 'empty' && frameKey) {
      const rc = resourceCells[`${frameKey}:${cellKey}`];
      if (rc) type = rc.kind;
    }
    const color = CELL_FILL[type];
    const { cx, cy } = cell;

    fills.set(color, (fills.get(color) ?? '') + hexPathStr(cx, cy, s));

    if (type === 'egg') {
      const rx = s * 0.056, ry = s * 0.239;
      const ex = cx, ey = cy + s * 0.15;
      eggPath += `M ${(ex-rx).toFixed(2)},${ey.toFixed(2)} `
               + `A ${rx.toFixed(2)},${ry.toFixed(2)} 0 1 0 ${(ex+rx).toFixed(2)},${ey.toFixed(2)} `
               + `A ${rx.toFixed(2)},${ry.toFixed(2)} 0 1 0 ${(ex-rx).toFixed(2)},${ey.toFixed(2)} Z `;
    }

    if (type === 'capped_honey') {
      // Randomised wax-cap lines: 3 short segments per cell, positions seeded from r,c
      // so the pattern is deterministic (doesn't flicker) but unique per cell.
      const hy = cy - s * 0.45, hw = s * 0.55;
      const seed = ((cell.r * 2654435761) ^ (cell.c * 2246822519)) >>> 0;
      for (let i = 0; i < 3; i++) {
        const phase  = ((seed >>> (i * 10)) & 0xFF) / 255;     // 0–1
        const jitter = ((seed >>> (i * 10 + 8)) & 0x1F) / 31;  // 0–1
        const x0 = cx - hw * 0.9 + phase * hw * 1.4;
        const x1 = x0 + hw * (0.25 + jitter * 0.35);
        const dy2 = (jitter - 0.5) * s * 0.18;
        capPath += `M ${x0.toFixed(2)},${(hy + dy2).toFixed(2)} L ${Math.min(cx + hw * 0.9, x1).toFixed(2)},${(hy + dy2).toFixed(2)} `;
      }
    }
  }

  return { fills, eggPath, capPath };
}

// Larva arcs are computed separately so they can animate at tick rate (not just broodVersion rate).
// Rotation uses sim-time age + a stable per-cell phase so speed changes look correct.
function buildCombLarvaArcs(
  cells: CellInfo[], s: number,
  overrides: Map<string, CellOverride> | undefined,
  drawnSet: Set<string> | undefined,
  now: number, speed: number,
): Record<number, string> {
  const arcs: Record<number, string> = { 1: '', 2: '', 3: '', 4: '', 5: '' };
  for (const cell of cells) {
    const cellKey = `${cell.r}:${cell.c}`;
    if (drawnSet && !drawnSet.has(cellKey)) continue;
    const ov = overrides?.get(cellKey);
    const type = ov?.type ?? cell.type;
    if (type !== 'larvae') continue;
    const instar = ((ov?.larvalInstar ?? cell.larvalInstar) ?? 3) as 1|2|3|4|5;
    const { r: rRaw, sw, span } = LARVA_PARAMS[instar];
    const { cx, cy } = cell;
    const maxR = s * (Math.sqrt(3) / 2) - sw / 2 - 0.05;
    const r = Math.min(rRaw, maxR);
    const half = span / 2;

    let θ: number;
    if (ov?.layTime !== undefined) {
      // Continuous rotation: basePhase from grid position (invariant under speed rescaling)
      const basePhase = ((cell.r * 521 + cell.c * 127) % 1000) / 1000 * Math.PI * 2;
      const angularVel = (2 * Math.PI) / LARVA_ROT_PERIOD_MS[instar];
      θ = basePhase + angularVel * (now - ov.layTime) * speed;
    } else {
      θ = ov?.rotation ?? cell.rotation ?? 0;
    }

    const sa = θ - Math.PI / 2 + half;
    const ea = θ - Math.PI / 2 - half;
    const sx = cx + r * Math.sin(sa), sy = cy - r * Math.cos(sa);
    const ex = cx + r * Math.sin(ea), ey = cy - r * Math.cos(ea);
    const largeArc = span >= Math.PI ? 1 : 0;
    arcs[instar] += `M ${sx.toFixed(2)},${sy.toFixed(2)} A ${r.toFixed(2)},${r.toFixed(2)} 0 ${largeArc} 0 ${ex.toFixed(2)},${ey.toFixed(2)} `;
  }
  return arcs;
}

function HexComb({ width, height, seed = 1, overrides, drawnSet, frameKey }: {
  width: number; height: number; seed?: number; overrides?: Map<string, CellOverride>;
  drawnSet?: Set<string>; frameKey?: string;
}) {
  const [, forceUpdate] = useState(0);
  // Subscribe to bee tick so larvae animate smoothly at BEE_TICK_MS rate
  useEffect(() => {
    const cb = () => forceUpdate(n => n + 1);
    beeTickListeners.add(cb);
    return () => { beeTickListeners.delete(cb); };
  }, []);

  const s = HEX_S;
  const cells  = useMemo(() => generateCells(width, height, seed), [width, height, seed]);
  const outline = useMemo(() => cells.map(c => hexPathStr(c.cx, c.cy, s)).join(''), [cells]);
  // Compute fills fresh every render so live resource cells (read from module-level store) are always current.
  const { fills, eggPath, capPath } = buildCombSVG(cells, s, overrides, drawnSet, frameKey);
  // Larva arcs: recomputed every bee tick using current real time + sim speed
  const effectiveNow   = globalPauseNow ?? Date.now();
  const effectiveSpeed = globalPauseNow !== null ? globalLastActiveSpeed : Math.max(globalSimSpeed, 1);
  const larvaByInstar  = buildCombLarvaArcs(cells, s, overrides, drawnSet, effectiveNow, effectiveSpeed);

  return (
    <Svg width={width} height={height} style={{ backgroundColor: '#111' }}>
      {Array.from(fills.entries()).map(([color, d]) => (
        <Path key={color} d={d} fill={color} stroke="none" />
      ))}
      <Path d={outline} fill="none" stroke="#3A2008" strokeWidth={0.28} />
      {eggPath && <Path d={eggPath} fill="white" stroke="none" opacity={0.95} />}
      {([1,2,3,4,5] as const).map(i => larvaByInstar[i] && (
        <Path key={i} d={larvaByInstar[i]} fill="none"
          stroke="rgba(248,252,240,0.88)" strokeWidth={LARVA_PARAMS[i].sw} strokeLinecap="round" />
      ))}
      {capPath && <Path d={capPath} fill="none" stroke="rgba(255,240,180,0.45)" strokeWidth={0.40} strokeLinecap="round" />}
    </Svg>
  );
}

// ── Frame tops ────────────────────────────────────────────────────────────────

type PulledFrame = { box: string; idx: number; instant?: boolean } | null;

function FrameTops({ box, frames, pulledIdx, onPull, onAddFrame, boxStack, drawnCells }: {
  box: string;
  frames: (string | null)[];
  pulledIdx: number | null;
  onPull: (idx: number) => void;
  onAddFrame: (slotIdx: number) => void;
  boxStack: string[];
  drawnCells?: Record<string, string[]>;
}) {
  const topY = homePos(box, boxStack).y;
  const hiveLeft = W / 2 - HIVE_W / 2;
  const maxFrames = 10;
  const frameW = HIVE_W / maxFrames;
  const totalCells = BLANK_FRAME_DRAW_ORDER.length;
  return (
    <>
      {Array.from({ length: maxFrames }, (_, idx) => {
        const fk = frames[idx] ?? null;
        if (fk === null) {
          return (
            <TouchableOpacity
              key={`empty-${idx}`}
              onPress={() => onAddFrame(idx)}
              style={{ position: 'absolute', left: hiveLeft + idx * frameW, top: topY - FRAME_PEEK, width: frameW - 1, height: FRAME_PEEK + 3 }}
            >
              <View style={{ width: frameW - 1, height: FRAME_PEEK + 3, backgroundColor: '#1A2E10', borderTopLeftRadius: 1, borderTopRightRadius: 1, borderTopWidth: 0.5, borderColor: '#0A1A08', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#507830', fontSize: 7, fontWeight: '700', lineHeight: 8 }}>+</Text>
              </View>
            </TouchableOpacity>
          );
        }
        if (idx === pulledIdx) return null;
        const isFoundation = fk.startsWith('n');
        const pct = isFoundation ? (drawnCells?.[fk]?.length ?? 0) / totalCells : 1;
        const topColor = pct >= 1 ? '#7A5028' : pct > 0 ? '#9A7040' : '#C8BA8A';
        const borderColor = pct >= 1 ? '#4A2E10' : pct > 0 ? '#7A5828' : '#A89860';
        return (
          <TouchableOpacity
            key={fk}
            onPress={() => onPull(idx)}
            style={{ position: 'absolute', left: hiveLeft + idx * frameW, top: topY - FRAME_PEEK, width: frameW - 1, height: FRAME_PEEK + 3 }}
          >
            <View style={{ width: frameW - 1, height: FRAME_PEEK + 3, backgroundColor: topColor, borderTopLeftRadius: 1, borderTopRightRadius: 1, borderTopWidth: 0.5, borderColor }} />
          </TouchableOpacity>
        );
      })}
    </>
  );
}

// ── Pulled frame view ─────────────────────────────────────────────────────────

function PulledFrameView({
  box, idx, frameKey, instant, onReturn, boxStack, boxFrames,
  overrides, showQueen, queenRef,
  onRemove,
  drawnCells, getCellInfo, onHoverInfo, crosshairWorld,
}: {
  box: string; idx: number; frameKey: string; instant?: boolean;
  onReturn: () => void;
  boxStack: string[];
  boxFrames: Record<string, (string | null)[]>;
  overrides?: Map<string, CellOverride>;
  showQueen?: boolean;
  queenRef?: React.MutableRefObject<QueenState>;
  onRemove: () => void;
  drawnCells?: Record<string, string[]>;
  getCellInfo?: (frameKey: string, r: number, c: number) => CellInfoResult;
  onHoverInfo?: (info: CellInfoResult | null) => void;
  crosshairWorld?: { x: number; y: number } | null;
}) {
  const isMounted  = useRef(true);
  const returning  = useRef(false);
  useEffect(() => { return () => { isMounted.current = false; }; }, []);

  const frameSlotW = HIVE_W / 10;
  const hiveLeft   = W / 2 - HIVE_W / 2;
  const toothCX    = hiveLeft + idx * frameSlotW + frameSlotW / 2;
  const toothCY    = homePos(box, boxStack).y - FRAME_PEEK + (FRAME_PEEK + 3) / 2;
  const TOOLBAR_H  = 34; // estimated height of action bar above frame
  const initX      = toothCX - FACE_W / 2;
  const initY      = toothCY - FACE_H / 2 - TOOLBAR_H;
  const faceX      = W / 2 - FACE_W / 2;
  const faceY      = homePos(box, boxStack).y - FACE_H - 20 - TOOLBAR_H;

  const pos = useRef(new Animated.ValueXY(instant ? { x: faceX, y: faceY } : { x: initX, y: initY })).current;

  useEffect(() => {
    if (instant) return;
    Animated.parallel([
      Animated.spring(pos.x, { toValue: faceX, bounciness: 4, speed: 12, useNativeDriver: true }),
      Animated.spring(pos.y, { toValue: faceY, bounciness: 4, speed: 12, useNativeDriver: true }),
    ]).start();
  }, []);

  const combRef = useRef<any>(null);

  // Mobile: resolve hover info by measuring the comb's actual screen rect.
  // getBoundingClientRect() includes the viewport zoom transform, so the math is exact.
  useEffect(() => {
    if (!crosshairWorld || !onHoverInfo) return;
    const el = combRef.current;
    const rect = el?.getBoundingClientRect?.();
    if (!rect || rect.width === 0) return;
    const sx = W / 2, sy = H / 2;
    if (sx >= rect.left && sx <= rect.right && sy >= rect.top && sy <= rect.bottom) {
      resolveHoverAt(
        (sx - rect.left) * COMB_W / rect.width,
        (sy - rect.top) * COMB_H / rect.height,
      );
    } else {
      onHoverInfo(null);
    }
  }, [crosshairWorld]);

  const handleReturn = () => {
    if (returning.current) return;
    returning.current = true;
    Animated.parallel([
      Animated.spring(pos.x, { toValue: initX, bounciness: 2, speed: 14, useNativeDriver: true }),
      Animated.spring(pos.y, { toValue: initY, bounciness: 2, speed: 14, useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished && isMounted.current) onReturn(); });
  };

  const beesForHit = useRef<SimBee[]>([]);

  const frameSeed = frameSeedOf(frameKey);
  const isBlankFrame = frameKey.startsWith('n');

  const cellsForHit = useMemo(() => generateCells(COMB_W, COMB_H, frameSeed), [frameSeed]);

  // For blank/foundation frames: compute which cells are drawn and where the frontier is
  const drawnSet = useMemo(() => {
    if (!isBlankFrame) return undefined;
    return new Set(drawnCells?.[frameKey] ?? []);
  }, [isBlankFrame, frameKey, drawnCells]);

  const drawFrontierY = useMemo(() => {
    if (!isBlankFrame) return undefined;
    const drawn = drawnCells?.[frameKey] ?? [];
    if (drawn.length === 0) return 0;
    if (drawn.length >= BLANK_FRAME_DRAW_ORDER.length) return undefined; // fully drawn
    return BLANK_FRAME_DRAW_ORDER[drawn.length - 1].cy; // cy of last drawn cell
  }, [isBlankFrame, frameKey, drawnCells]);

  const resolveHoverAt = useCallback((px: number, py: number) => {
    if (!onHoverInfo) return;
    // Check bees first — use ellipse hit test matching the actual SVG body shape
    for (const bee of beesForHit.current) {
      const dx = px - bee.x;
      const dy = py - bee.y;
      const cosA = Math.cos(bee.angle);
      const sinA = Math.sin(bee.angle);
      const lx = dx * cosA + dy * sinA;  // local x (along body axis)
      const ly = -dx * sinA + dy * cosA; // local y (perpendicular)
      if ((lx / 2.2) ** 2 + (ly / 0.9) ** 2 <= 1) {
        onHoverInfo({ kind: 'bee', id: bee.id, bornAt: bee.bornAt, isBuilder: bee.isBuilder, waxUnits: bee.waxUnits, foragerPhase: bee.foragerPhase, receiverPhase: bee.receiverPhase, load: bee.load, activity: getBeeActivity(bee) });
        return;
      }
    }
    // Nearest hex cell
    let best: { r: number; c: number } | null = null;
    let bestDist = HEX_S * 2;
    for (const cell of cellsForHit) {
      const d = Math.hypot(cell.cx - px, cell.cy - py);
      if (d < bestDist) { bestDist = d; best = { r: cell.r, c: cell.c }; }
    }
    if (best && getCellInfo) onHoverInfo(getCellInfo(frameKey, best.r, best.c));
  }, [frameKey, getCellInfo, cellsForHit, onHoverInfo]);

  const handleCombHover = useCallback((evt: any) => {
    const px: number = evt.nativeEvent?.offsetX ?? evt.nativeEvent?.locationX ?? -1;
    const py: number = evt.nativeEvent?.offsetY ?? evt.nativeEvent?.locationY ?? -1;
    if (px >= 0) resolveHoverAt(px, py);
  }, [resolveHoverAt]);

  const ACTION_BTN: any = {
    paddingHorizontal: 6, paddingVertical: 4, borderRadius: 4, marginHorizontal: 2,
    backgroundColor: 'rgba(30,15,0,0.82)',
  };
  const ACTION_TXT: any = { color: '#F0C050', fontSize: 10, fontWeight: '600' };
  const DANGER_BTN: any = { ...ACTION_BTN, backgroundColor: 'rgba(80,10,10,0.88)' };
  const DANGER_TXT: any = { ...ACTION_TXT, color: '#FF8080' };

  return (
    <Animated.View style={{ position: 'absolute', left: 0, top: 0, transform: pos.getTranslateTransform() }}>
      {/* Beekeeper action bar — above the frame */}
      {isBlankFrame && (() => {
        const drawnCount = drawnCells?.[frameKey]?.length ?? 0;
        const totalCount = BLANK_FRAME_DRAW_ORDER.length;
        const pct = Math.round((drawnCount / totalCount) * 100);
        const label = drawnCount >= totalCount
          ? 'Comb fully drawn'
          : `Workers drawing comb: ${pct}%`;
        return (
          <View style={{ alignItems: 'center', marginBottom: 3 }}>
            <Text style={{ color: '#C8BA8A', fontSize: 9, fontWeight: '500' }}>{label}</Text>
          </View>
        );
      })()}
      <View style={{
        flexDirection: 'row', justifyContent: 'center',
        marginBottom: 6, gap: 6, paddingHorizontal: 4,
      }}>
        <TouchableOpacity style={ACTION_BTN} onPress={handleReturn}>
          <Text style={ACTION_TXT}>↩ Return</Text>
        </TouchableOpacity>
        <TouchableOpacity style={DANGER_BTN} onPress={() => { onRemove(); onReturn(); }}>
          <Text style={DANGER_TXT}>✕ Remove Frame</Text>
        </TouchableOpacity>
      </View>

      <View>
        <View style={{ width: FACE_W, height: FACE_H, flexDirection: 'row', borderWidth: 0.5, borderColor: '#4A2E10' }}>
          <View style={{ width: FACE_SIDE_BAR, height: FACE_H, backgroundColor: '#7A5028' }} />
          <View style={{ flex: 1 }}>
            <View style={{ height: FACE_TOP_BAR, backgroundColor: '#7A5028' }} />
            <View
              ref={combRef}
              style={{ width: COMB_W, height: COMB_H }}
              {...({
                onMouseMove: handleCombHover,
                onMouseLeave: () => onHoverInfo?.(null),
              } as any)}
            >
              <HexComb width={COMB_W} height={COMB_H} seed={frameSeed} overrides={overrides} drawnSet={drawnSet} frameKey={frameKey} />
              <FrameBeeLayer frameKey={frameKey} drawFrontierY={drawFrontierY} beesExternalRef={beesForHit} />
              {showQueen && queenRef && <QueenBeeLayer queenRef={queenRef} />}
            </View>
            <View style={{ height: FACE_BOT_BAR, backgroundColor: '#7A5028' }} />
          </View>
          <View style={{ width: FACE_SIDE_BAR, height: FACE_H, backgroundColor: '#7A5028' }} />
        </View>
      </View>

    </Animated.View>
  );
}

// ── Piece types ───────────────────────────────────────────────────────────────

function pieceH(id: string): number { return id === 'lid' ? LID_H : id === 'inner' ? INNER_H : BOX_H; }
function pieceW(id: string): number { return id === 'lid' ? LID_W : id === 'inner' ? LID_W - 4 : HIVE_W; }

function allPieces(boxStack: string[]): string[] { return ['lid', 'inner', ...boxStack]; }

function hiveTop(boxStack: string[]): number {
  return GROUND_Y - STAND_H - BB_H - boxStack.length * BOX_H - INNER_H - LID_H;
}

function homePos(id: string, boxStack: string[]): { x: number; y: number } {
  const pieces = allPieces(boxStack);
  let y = hiveTop(boxStack);
  for (const p of pieces) {
    if (p === id) break;
    y += pieceH(p);
  }
  return { x: W / 2 - pieceW(id) / 2, y };
}

const PILE_CX = W / 2 + LID_W / 2 + 30 + LID_W / 2;

function pilePos(id: string, pile: string[]): { x: number; y: number } {
  const idx = pile.indexOf(id);
  let stackBelow = 0;
  for (let i = 0; i < idx; i++) stackBelow += pieceH(pile[i]);
  return { x: PILE_CX - pieceW(id) / 2, y: GROUND_Y - stackBelow - pieceH(id) };
}

// ── Frame bee simulation ──────────────────────────────────────────────────────

interface SimBee {
  id: number;
  x: number; y: number;
  tx: number; ty: number;
  angle: number;
  dwell: number;
  greetCooldown: number;
  greetedX: number;
  greetedY: number;
  waxUnits: number;   // 0–WAX_MAX_PER_BEE: individual wax reserve for comb building
  isBuilder: boolean; // ~10% of frame bees exhibit drawing behaviour
  bornAt: number;
  // Forager fields (only populated for 21d+ bees in forager phase)
  load?: 'nectar' | 'pollen' | null;
  foragerPhase?: 'seeking_exit' | 'returning' | 'depositing';
  cellTarget?: { frameKey: string; r: number; c: number; cx: number; cy: number };
  // Receiver fields (12–18d house bees intercept returning foragers and deposit clusters)
  receiverPhase?: 'accepting' | 'processing';
}

const BEE_COLOR         = '#E8960A';
const BEE_TICK_MS       = 80;
const BEE_SPEED         = 24 / 1000;
const GREET_DIST        = 7;
const MIN_DIST          = 5;
const WAX_MAX_PER_BEE   = 8;
// Builder fills wax in ~4 min, deposits a full load in ~6 s at the frontier
const WAX_FILL_RATE     = WAX_MAX_PER_BEE / (240_000 / BEE_TICK_MS); // per tick
const WAX_DEPOSIT_RATE  = 0.08;  // units per tick while at frontier
const WAX_FRONTIER_BAND = 5;     // px: radius around drawing frontier

function frameBeeDensity(frameIdx: number): number {
  const dist = Math.abs(frameIdx - 4.5) / 4.5;
  return Math.round(180 * (1 - dist * 0.65));
}

function makeFramePopulation(frameIdx: number, salt: number, count?: number): SimBee[] {
  const rand = seeded(frameIdx * 137 + 42 + salt);
  const n = count ?? frameBeeDensity(frameIdx);
  return Array.from({ length: n }, (_, i) => {
    const x = Math.max(2, Math.min(COMB_W - 3, rand() * COMB_W));
    const y = Math.max(1, Math.min(COMB_H - 2, rand() * COMB_H));
    const isBuilder = rand() < 0.10;
    return { id: allocateBeeId(), x, y, tx: x, ty: y, angle: rand() * Math.PI * 2,
             dwell: rand() * 800, greetCooldown: 0, greetedX: -1, greetedY: 0,
             waxUnits: isBuilder ? rand() * WAX_MAX_PER_BEE : 0, isBuilder, bornAt: Date.now() };
  });
}

// ── Persistent frame-bee store — single source of truth for all bees ──────────
// Every frame's bees live here always; a global tick updates all of them.
interface FrameStore { bees: SimBee[]; rand: () => number; frontierY?: number; }
const frameBeeStore: Record<string, FrameStore> = {};
const beeTickListeners = new Set<() => void>(); // FrameBeeLayer instances subscribe here
let globalSimSpeed = 1;
let globalSimTimeMs = 0;  // accumulated simulated milliseconds since load
let globalBeeInterval: ReturnType<typeof setInterval> | null = null;
let onBeeCountUpdate: ((total: number) => void) | null = null; // registered by the hook
let onForagerUpdate: ((outside: OutsideForager[], stored: number) => void) | null = null;
let _beeTickN = 0; // throttle population display updates
let globalPauseNow: number | null = null;  // real timestamp when paused, null when running
let globalLastActiveSpeed: number = 1;     // speed just before last pause / current speed

// Adjacent-frame map: updated by the hook whenever boxFrames changes.
// Bees at the left/right edge of their frame can walk into the next frame.
let globalFrameAdjacency: Record<string, { left: string | null; right: string | null }> = {};
let globalBoxStack: string[] = [];
let globalBoxFrames: Record<string, (string | null)[]> = {};
function updateGlobalFrameAdjacency(boxFrames: Record<string, (string | null)[]>): void {
  const next: Record<string, { left: string | null; right: string | null }> = {};
  for (const frames of Object.values(boxFrames)) {
    const occupied = frames.filter((x): x is string => x !== null);
    for (let i = 0; i < occupied.length; i++) {
      next[occupied[i]] = {
        left:  i > 0 ? occupied[i - 1] : null,
        right: i < occupied.length - 1 ? occupied[i + 1] : null,
      };
    }
  }
  globalFrameAdjacency = next;
}
function frameBoxOfGlobal(fk: string): string | null {
  for (const [bid, flist] of Object.entries(globalBoxFrames)) {
    if (flist.includes(fk)) return bid;
  }
  return null;
}

// ── Forager / resource stores ─────────────────────────────────────────────────
interface ResourceCell { kind: 'nectar' | 'honey' | 'capped_honey' | 'pollen'; depositedAt: number; }
type ResourceCellStore = Record<string, ResourceCell>; // "${frameKey}:${r}:${c}"
const resourceCells: ResourceCellStore = {};

interface OutsideForager {
  id: number;
  spawnTime: number;      // wall time when the bee leaves the hive
  returnTime: number;     // wall time when forager returns to hive
  homeFrame: string;      // frame the bee originated from
  load: 'nectar' | 'pollen';
  bornAt: number; waxUnits: number; isBuilder: boolean;
}
const outsideForagers: OutsideForager[] = [];
let nextBeeId = 1;
const recycledBeeIds: number[] = [];
function allocateBeeId(): number {
  if (recycledBeeIds.length > 0) return recycledBeeIds.shift()!;
  return nextBeeId++;
}
function releaseBeeId(id: number): void {
  if (id > 0 && !recycledBeeIds.includes(id)) {
    recycledBeeIds.push(id);
    recycledBeeIds.sort((a, b) => a - b);
  }
}
function releaseBeeIds(bees: SimBee[] | OutsideForager[]): void { bees.forEach(b => releaseBeeId(b.id)); }
function countLiveBees(): number {
  return Object.values(frameBeeStore).reduce((a, s) => a + s.bees.length, 0) + outsideForagers.length;
}

let onResourceUpdate: (() => void) | null = null; // registered by hook to trigger re-render
let getBroodCells: (() => Record<string, number>) | null = null; // registered by hook
let getDrawnCells: (() => Record<string, string[]>) | null = null; // registered by hook

function emitForagerUpdate() {
  if (onForagerUpdate) onForagerUpdate([...outsideForagers], Object.keys(resourceCells).length);
}

function clearFrameStores(frameKey: string): void {
  delete frameBeeStore[frameKey];
  const prefix = `${frameKey}:`;
  for (const k of Object.keys(resourceCells)) {
    if (k.startsWith(prefix)) delete resourceCells[k];
  }
}

// Fraction of bees in the edge zone that cross per tick (~15 %).
const MIGRATE_EDGE = 2;    // px from left/right boundary
const MIGRATE_PROB = 0.15;

function startGlobalBeeTick() {
  if (globalBeeInterval) return;
  globalBeeInterval = setInterval(() => {
    _beeTickN++;
    if (globalSimSpeed > 0) {
      globalSimTimeMs += BEE_TICK_MS * globalSimSpeed;
      const now = Date.now();
      const lifespanMs = ADULT_LIFESPAN_MS / globalSimSpeed;
      for (const store of Object.values(frameBeeStore)) {
        // Natural death — bees older than their lifespan die
        if (store.bees.some(b => now - b.bornAt >= lifespanMs)) {
          const dead = store.bees.filter(b => now - b.bornAt >= lifespanMs);
          releaseBeeIds(dead);
          store.bees = store.bees.filter(b => now - b.bornAt < lifespanMs);
        }
        if (store.bees.length > 0) {
          store.bees = tickBees(store.bees, store.rand, globalSimSpeed, store.frontierY);
        }
      }

      // Frame-to-frame migration: bees at the left/right edge walk to the adjacent frame.
      // Collect first, apply after, so no bee is processed twice in one tick.
      const migrations: Array<{ targetKey: string; bee: SimBee }> = [];
      for (const [fk, store] of Object.entries(frameBeeStore)) {
        const adj = globalFrameAdjacency[fk];
        if (!adj) continue;
        const staying: SimBee[] = [];
        for (const bee of store.bees) {
          let migrated = false;
          if (bee.x < MIGRATE_EDGE && adj.left) {
            const tgt = frameBeeStore[adj.left];
            const tn = parseInt(adj.left);
            const tfi = isNaN(tn) ? 0 : tn % 10;
            if (tgt && tgt.bees.length < frameBeeDensity(tfi) * 3 && Math.random() < MIGRATE_PROB) {
              migrations.push({ targetKey: adj.left,
                bee: { ...bee, x: COMB_W - MIGRATE_EDGE * 0.5, tx: COMB_W * (0.3 + Math.random() * 0.4), dwell: 0 } });
              migrated = true;
            }
          } else if (bee.x > COMB_W - MIGRATE_EDGE && adj.right) {
            const tgt = frameBeeStore[adj.right];
            const tn = parseInt(adj.right);
            const tfi = isNaN(tn) ? 0 : tn % 10;
            if (tgt && tgt.bees.length < frameBeeDensity(tfi) * 3 && Math.random() < MIGRATE_PROB) {
              migrations.push({ targetKey: adj.right,
                bee: { ...bee, x: MIGRATE_EDGE * 0.5, tx: COMB_W * (0.3 + Math.random() * 0.4), dwell: 0 } });
              migrated = true;
            }
          }
          if (!migrated) staying.push(bee);
        }
        if (staying.length !== store.bees.length) store.bees = staying;
      }
      for (const { targetKey, bee } of migrations) {
        const tgt = frameBeeStore[targetKey];
        if (tgt) tgt.bees = [...tgt.bees, bee];
      }

      // ── Forager / resource logic ─────────────────────────────────────────────
      const speed2 = globalSimSpeed;
      let resourceChanged = false;
      let foragerRosterChanged = false;
      const broodSnap = getBroodCells?.() ?? {};

      // Debug: log forager stats every ~5 seconds of real time
      if (_beeTickN % 62 === 0) {
        let foragerAgeCount = 0, seekingCount = 0, returningCount = 0, depositingCount = 0;
        for (const store of Object.values(frameBeeStore)) {
          for (const bee of store.bees) {
            const sa = (now - bee.bornAt) * speed2;
            if (sa >= FORAGER_AGE_MS) foragerAgeCount++;
            if (bee.foragerPhase === 'seeking_exit') seekingCount++;
            if (bee.foragerPhase === 'returning') returningCount++;
            if (bee.foragerPhase === 'depositing') depositingCount++;
          }
        }
        console.log(`[forager] speed=${speed2.toFixed(0)}x foragerAge=${foragerAgeCount} seeking=${seekingCount} returning=${returningCount} depositing=${depositingCount} outside=${outsideForagers.length} resources=${Object.keys(resourceCells).length} boxStack=${JSON.stringify(globalBoxStack)}`);
      }

      // A) Nectar → honey (ripening by evaporation/fanning)
      for (const [key, rc] of Object.entries(resourceCells)) {
        if (rc.kind === 'nectar' && (now - rc.depositedAt) * speed2 >= NECTAR_TO_HONEY_MS) {
          resourceCells[key] = { kind: 'honey', depositedAt: rc.depositedAt };
          resourceChanged = true;
        }
      }

      // B) Inject returning foragers at the bottom of the bottom box
      const bottomBoxId2 = globalBoxStack[globalBoxStack.length - 1];
      if (bottomBoxId2) {
        const bottomFrames2 = (globalBoxFrames[bottomBoxId2] ?? []).filter((x): x is string => x !== null);
        for (let i = outsideForagers.length - 1; i >= 0; i--) {
          const of_ = outsideForagers[i];
          if (now < of_.returnTime) continue;
          if (!bottomFrames2.length) { console.warn('[forager] no bottom frames, discarding returning bee'); releaseBeeId(of_.id); outsideForagers.splice(i, 1); foragerRosterChanged = true; continue; }
          const targetFk = bottomFrames2[Math.floor(Math.random() * bottomFrames2.length)];
          const store = frameBeeStore[targetFk];
          if (!store) { console.warn('[forager] no store for', targetFk, 'discarding'); releaseBeeId(of_.id); outsideForagers.splice(i, 1); foragerRosterChanged = true; continue; }
          console.log(`[forager] bee RETURNS to frame=${targetFk} carrying=${of_.load}`);
          const injectX = COMB_W * (0.2 + Math.random() * 0.6);
          const newBee: SimBee = {
            id: of_.id, x: injectX, y: COMB_H - 1,
            tx: injectX, ty: 0, angle: -Math.PI / 2,
            dwell: 0, greetCooldown: 0, greetedX: -1, greetedY: 0,
            waxUnits: of_.waxUnits, isBuilder: of_.isBuilder, bornAt: of_.bornAt,
            load: of_.load, foragerPhase: 'returning',
          };
          store.bees = [...store.bees, newBee];
          outsideForagers.splice(i, 1);
          foragerRosterChanged = true;
        }
      }

      // C) Per-frame forager/receiver behavior + vertical transits
      const vertTransits: Array<{ fromFk: string; beeId: number; direction: 'down' | 'up' }> = [];

      for (const [fk, store] of Object.entries(frameBeeStore)) {
        const boxId = frameBoxOfGlobal(fk);
        const isBottomBox = boxId !== null && boxId === globalBoxStack[globalBoxStack.length - 1];
        const isTopBox    = boxId !== null && boxId === globalBoxStack[0];
        const toRemove = new Set<number>();

        // Pre-pass: match returning nectar foragers with accepting receiver bees.
        // Handoffs only trigger when both bees are within 8px of each other.
        const handoffLoads  = new Map<number, 'nectar'|'pollen'>(); // receiverId → load
        const handedForagers = new Set<number>();                    // foragerIds that handed off
        if (isTopBox) {
          for (const forager of store.bees) {
            if (forager.foragerPhase !== 'returning' || forager.load !== 'nectar') continue;
            if (forager.y > COMB_H * 0.75) continue; // still heading up
            for (const recv of store.bees) {
              if (recv.receiverPhase !== 'accepting') continue;
              if (recv.id === forager.id || handoffLoads.has(recv.id)) continue;
              if (Math.hypot(forager.x - recv.x, forager.y - recv.y) > 8) continue;
              handoffLoads.set(recv.id, 'nectar');
              handedForagers.add(forager.id);
              break;
            }
          }
        }

        // Pre-pass: assign honey-capping targets to idle builder bees (wax > 20%).
        // Builder walks to the honey cell; the map step caps it on arrival.
        const cappingTargets = new Map<number, {r:number;c:number;cx:number;cy:number}>(); // beeId → cell
        const claimedHoneyCells = new Set<string>();
        for (const bee of store.bees) {
          if (!bee.isBuilder || bee.waxUnits < WAX_MAX_PER_BEE * 0.20) continue;
          if (bee.foragerPhase || bee.receiverPhase) continue;
          if (bee.cellTarget) continue; // already has a target
          // Find nearest ripe honey cell in this frame
          const prefix = `${fk}:`;
          let bestDist = Infinity, bestCell: {r:number;c:number;cx:number;cy:number}|null = null;
          for (const [rck, rc] of Object.entries(resourceCells)) {
            if (!rck.startsWith(prefix) || rc.kind !== 'honey') continue;
            if (claimedHoneyCells.has(rck)) continue;
            const parts = rck.split(':');
            const hr = parseInt(parts[1]), hc = parseInt(parts[2]);
            const { cx: hcx, cy: hcy } = cellCoords(hr, hc);
            const d = Math.hypot(bee.x - hcx, bee.y - hcy);
            if (d < bestDist) { bestDist = d; bestCell = { r: hr, c: hc, cx: hcx, cy: hcy }; }
          }
          if (bestCell) {
            cappingTargets.set(bee.id, bestCell);
            claimedHoneyCells.add(`${fk}:${bestCell.r}:${bestCell.c}`);
          }
        }

        store.bees = store.bees.map(bee => {
          const { foragerPhase, load, cellTarget } = bee;
          const simAge = (now - bee.bornAt) * speed2;
          const isForagerAge = simAge >= FORAGER_AGE_MS;

          // --- RECEIVER ACCEPTING: idle near frame centre, waiting for handoff ---
          if (bee.receiverPhase === 'accepting') {
            // If a forager handed off to this bee in the pre-pass, start processing
            if (handoffLoads.has(bee.id)) {
              const recvLoad = handoffLoads.get(bee.id)!;
              const cell = findResourceDepositCell(fk, 'nectar', broodSnap, resourceCells);
              if (!cell) return { ...bee, receiverPhase: undefined, load: null, dwell: 300 };
              return { ...bee, receiverPhase: 'processing', load: recvLoad,
                cellTarget: { frameKey: fk, r: cell.r, c: cell.c, cx: cell.cx, cy: cell.cy },
                tx: cell.cx, ty: cell.cy };
            }
            // Keep hovering near the frame bottom-centre (handoff zone)
            if (Math.random() < 0.02) {
              return { ...bee, tx: COMB_W * (0.3 + Math.random() * 0.4),
                ty: COMB_H * (0.55 + Math.random() * 0.2), dwell: 400 + Math.random() * 600 };
            }
            return bee;
          }

          // --- RECEIVER PROCESSING: carry nectar to storage zone, deposit cluster ---
          if (bee.receiverPhase === 'processing') {
            if (!cellTarget) {
              // Pick storage target
              const cell = findResourceDepositCell(fk, 'nectar', broodSnap, resourceCells);
              if (!cell) return { ...bee, receiverPhase: undefined, load: null, dwell: 300 };
              return { ...bee, cellTarget: { frameKey: fk, r: cell.r, c: cell.c, cx: cell.cx, cy: cell.cy },
                tx: cell.cx, ty: cell.cy };
            }
            if (cellTarget.frameKey !== fk) {
              // Migrated frame — re-pick
              const cell = findResourceDepositCell(fk, 'nectar', broodSnap, resourceCells);
              return cell
                ? { ...bee, cellTarget: { ...cell, frameKey: fk }, tx: cell.cx, ty: cell.cy }
                : { ...bee, receiverPhase: undefined, load: null, cellTarget: undefined, dwell: 300 };
            }
            const dist = Math.hypot(bee.x - cellTarget.cx, bee.y - cellTarget.cy);
            if (dist < 4) {
              // Arrived — deposit a cluster of adjacent nectar cells
              depositNectarCluster(fk, cellTarget, broodSnap, resourceCells, now);
              resourceChanged = true;
              return { ...bee, receiverPhase: 'accepting', load: null, cellTarget: undefined,
                tx: COMB_W * (0.3 + Math.random() * 0.4), ty: COMB_H * (0.6 + Math.random() * 0.2),
                dwell: 200 + Math.random() * 300 };
            }
            return { ...bee, tx: cellTarget.cx, ty: cellTarget.cy };
          }

          // --- BUILDER CAPPING: walk to honey cell, cap it with wax ---
          const cappingTarget = cappingTargets.get(bee.id);
          if (cappingTarget && bee.isBuilder && !bee.foragerPhase && !bee.receiverPhase) {
            const dist = Math.hypot(bee.x - cappingTarget.cx, bee.y - cappingTarget.cy);
            if (dist < 4) {
              const rcKey = `${fk}:${cappingTarget.r}:${cappingTarget.c}`;
              if (resourceCells[rcKey]?.kind === 'honey') {
                resourceCells[rcKey] = { ...resourceCells[rcKey], kind: 'capped_honey' };
                resourceChanged = true;
              }
              return { ...bee, cellTarget: undefined, waxUnits: Math.max(0, bee.waxUnits - 0.5),
                tx: COMB_W * (0.2 + Math.random() * 0.6), ty: cappingTarget.cy + (Math.random() - 0.5) * 4,
                dwell: 150 + Math.random() * 200 };
            }
            return { ...bee, cellTarget: { frameKey: fk, ...cappingTarget }, tx: cappingTarget.cx, ty: cappingTarget.cy };
          }

          // --- DEPOSITING: walk to cell, deposit on arrival ---
          if (foragerPhase === 'depositing' && cellTarget) {
            if (cellTarget.frameKey !== fk) {
              const zone: 'nectar' | 'pollen' = load === 'pollen' ? 'pollen' : 'nectar';
              const newCell = findResourceDepositCell(fk, zone, broodSnap, resourceCells);
              if (newCell) return { ...bee, cellTarget: newCell, tx: newCell.cx, ty: newCell.cy };
              return { ...bee, foragerPhase: undefined, load: null, cellTarget: undefined, dwell: 300 };
            }
            const dist = Math.hypot(bee.x - cellTarget.cx, bee.y - cellTarget.cy);
            if (dist < 4) {
              if (load === 'nectar') {
                // Nectar forager deposits a cluster (no handoff found)
                depositNectarCluster(fk, cellTarget, broodSnap, resourceCells, now);
              } else {
                const rcKey = `${fk}:${cellTarget.r}:${cellTarget.c}`;
                if (!(rcKey in broodSnap) && !(rcKey in resourceCells)) {
                  resourceCells[rcKey] = { kind: load ?? 'pollen', depositedAt: now };
                }
              }
              resourceChanged = true;
              return { ...bee, foragerPhase: undefined, load: null, cellTarget: undefined,
                tx: COMB_W * (0.2 + Math.random() * 0.6), ty: COMB_H * (0.3 + Math.random() * 0.4),
                dwell: 300 + Math.random() * 400 };
            }
            return { ...bee, tx: cellTarget.cx, ty: cellTarget.cy };
          }

          // --- RETURNING: walked up to top box, hand off or deposit nectar ---
          if (foragerPhase === 'returning') {
            if (bee.y < COMB_H * 0.75) {
              if (load === 'pollen') {
                if (!isBottomBox && !isTopBox) {
                  vertTransits.push({ fromFk: fk, beeId: bee.id, direction: 'up' });
                  return bee;
                }
                const cell = findResourceDepositCell(fk, 'pollen', broodSnap, resourceCells);
                if (cell) return { ...bee, foragerPhase: 'depositing', cellTarget: cell, tx: cell.cx, ty: cell.cy };
                return { ...bee, foragerPhase: undefined, load: null, dwell: 300 };
              } else {
                // Nectar: travel to top box
                if (!isTopBox) {
                  vertTransits.push({ fromFk: fk, beeId: bee.id, direction: 'up' });
                  return bee;
                }
                // Handed off to a receiver in the pre-pass?
                if (handedForagers.has(bee.id)) {
                  return { ...bee, foragerPhase: undefined, load: null,
                    tx: COMB_W * (0.2 + Math.random() * 0.6), ty: COMB_H * 0.7, dwell: 400 };
                }
                // No receiver available — deposit cluster directly
                const cell = findResourceDepositCellAcrossHive(fk, 'nectar', broodSnap, resourceCells);
                if (cell) return { ...bee, foragerPhase: 'depositing', cellTarget: cell, tx: cell.cx, ty: cell.cy };
                return { ...bee, foragerPhase: undefined, load: null, dwell: 300 };
              }
            }
            return { ...bee, tx: bee.x, ty: 0 };
          }

          // --- SEEKING_EXIT: walk to bottom edge, transit down or exit ---
          if (foragerPhase === 'seeking_exit') {
            if (bee.y >= COMB_H - 2) {
              if (isBottomBox) {
                const tripReal = FORAGER_TRIP_MS / speed2;
                const tripLoad = Math.random() < 0.6 ? 'nectar' as const : 'pollen' as const;
                if (Math.random() < 0.05) console.log(`[forager] bee EXITS frame=${fk} carrying=${tripLoad} returns in ${(tripReal/1000).toFixed(1)}s real`);
                outsideForagers.push({
                  id: bee.id,
                  spawnTime: now,
                  returnTime: now + tripReal * (0.85 + Math.random() * 0.3),
                  homeFrame: fk, load: tripLoad,
                  bornAt: bee.bornAt, waxUnits: bee.waxUnits, isBuilder: bee.isBuilder,
                });
                foragerRosterChanged = true;
                toRemove.add(bee.id);
                return bee;
              }
              vertTransits.push({ fromFk: fk, beeId: bee.id, direction: 'down' });
              return bee;
            }
            return { ...bee, tx: bee.x, ty: COMB_H - 1 };
          }

          // --- Transition receiver-age house bees to accepting state ---
          const isReceiverAge = simAge >= RECEIVER_AGE_MIN_MS && simAge < RECEIVER_AGE_MAX_MS;
          if (isReceiverAge && !foragerPhase && !bee.receiverPhase && isTopBox) {
            if (Math.random() < Math.min(0.003 * speed2, 0.8)) {
              return { ...bee, receiverPhase: 'accepting',
                tx: COMB_W * (0.3 + Math.random() * 0.4), ty: COMB_H * (0.6 + Math.random() * 0.2), dwell: 300 };
            }
          }
          // Retire receiver role when bee ages out of receiver window
          if (bee.receiverPhase && (!isReceiverAge || isForagerAge)) {
            return { ...bee, receiverPhase: undefined, load: null, cellTarget: undefined };
          }

          // --- Initiate a foraging trip ---
          if (isForagerAge && !foragerPhase && !load) {
            const liveBees = Math.max(1, countLiveBees());
            const outsideCap = Math.max(3, Math.floor(liveBees * MAX_OUTSIDE_FORAGER_FRACTION));
            const probPerTick = FORAGER_TRIP_PROB_PER_S * (BEE_TICK_MS / 1000) * speed2;
            if (outsideForagers.length < outsideCap && Math.random() < probPerTick) {
              if (Math.random() < 0.05) console.log(`[forager] trip START bee=${bee.id} frame=${fk} isBottomBox=${isBottomBox} age=${(simAge/DAY_MS).toFixed(1)}d`);
              return { ...bee, foragerPhase: 'seeking_exit', tx: bee.x, ty: COMB_H - 1 };
            }
          }

          return bee;
        });

        if (toRemove.size > 0) {
          store.bees = store.bees.filter(b => !toRemove.has(b.id));
        }
      }

      // D) Process vertical box transits
      const transitedIds = new Map<string, number>(); // "fromFk:id" → new id in target frame
      for (const { fromFk, beeId, direction } of vertTransits) {
        const boxId = frameBoxOfGlobal(fromFk);
        if (!boxId) continue;
        const fromBoxIdx = globalBoxStack.indexOf(boxId);
        const targetBoxIdx = direction === 'down' ? fromBoxIdx + 1 : fromBoxIdx - 1;
        if (targetBoxIdx < 0 || targetBoxIdx >= globalBoxStack.length) continue;
        const targetBoxId = globalBoxStack[targetBoxIdx];
        const targetFrames = (globalBoxFrames[targetBoxId] ?? []).filter((x): x is string => x !== null);
        if (!targetFrames.length) continue;
        const targetFk = targetFrames[Math.floor(Math.random() * targetFrames.length)];
        const fromStore = frameBeeStore[fromFk];
        const toStore = frameBeeStore[targetFk];
        if (!fromStore || !toStore) continue;
        const bee = fromStore.bees.find(b => b.id === beeId);
        if (!bee) continue;
        const entryY = direction === 'down' ? 0 : COMB_H - 1;
        const continueY = direction === 'down' ? COMB_H - 1 : 0;
        toStore.bees = [...toStore.bees, { ...bee, y: entryY, ty: continueY }];
        transitedIds.set(`${fromFk}:${beeId}`, 1);
      }
      if (transitedIds.size > 0) {
        for (const [fk, store] of Object.entries(frameBeeStore)) {
          store.bees = store.bees.filter(b => !transitedIds.has(`${fk}:${b.id}`));
        }
      }

      if (resourceChanged && onResourceUpdate) onResourceUpdate();
      if (foragerRosterChanged) emitForagerUpdate();
    }
    // Update population counter once per second (~1000ms / 80ms = 12 ticks)
    if (_beeTickN % 12 === 0 && onBeeCountUpdate) {
      const total = Math.min(MAX_COLONY_SIZE,
        countLiveBees());
      onBeeCountUpdate(total);
      emitForagerUpdate();
    }
    for (const cb of beeTickListeners) cb();
  }, BEE_TICK_MS);
}

function getOrInitFrameStore(frameKey: string): FrameStore {
  if (!frameBeeStore[frameKey]) {
    const n = parseInt(frameKey);
    const fi = isNaN(n) ? 0 : n % 10;
    const seed = Math.floor(Math.random() * 999983);
    const count = frameBeeDensity(fi);
    const now = Date.now();
    const bees = makeFramePopulation(fi, seed, count);
    // Spread bornAt across 75% of the CURRENT effective lifespan so die-off is gradual.
    // When paused, use the pre-pause speed so new bees get realistic age spread.
    const effSpeed = globalPauseNow !== null ? globalLastActiveSpeed : Math.max(globalSimSpeed, 1);
    const effectiveLifespan = ADULT_LIFESPAN_MS / effSpeed;
    for (const bee of bees) {
      bee.bornAt = now - Math.random() * effectiveLifespan * 0.75;
    }
    frameBeeStore[frameKey] = {
      bees,
      rand: seeded(fi * 97 + 13 + seed),
    };
  }
  return frameBeeStore[frameKey];
}

function addEmergedBeeToStore(frameKey: string, r: number, c: number): void {
  const store = getOrInitFrameStore(frameKey);
  const n = parseInt(frameKey);
  const fi = isNaN(n) ? 0 : n % 10;
  if (store.bees.length >= frameBeeDensity(fi) * 2) return;
  const { cx, cy } = cellCoords(r, c);
  const isBuilder = Math.random() < 0.10;
  store.bees = [...store.bees, {
    id: allocateBeeId(),
    x: cx, y: cy, tx: cx, ty: cy,
    angle: Math.random() * Math.PI * 2,
    dwell: 200 + Math.random() * 400,
    greetCooldown: 0, greetedX: -1, greetedY: 0,
    waxUnits: isBuilder ? Math.random() * WAX_MAX_PER_BEE * 0.3 : 0,
    isBuilder, bornAt: Date.now(),
  }];
}

function torusDelta(ax: number, ay: number, bx: number, by: number) {
  let dx = bx - ax, dy = by - ay;
  if (dx >  COMB_W / 2) dx -= COMB_W;
  if (dx < -COMB_W / 2) dx += COMB_W;
  if (dy >  COMB_H / 2) dy -= COMB_H;
  if (dy < -COMB_H / 2) dy += COMB_H;
  return { dx, dy, d: Math.hypot(dx, dy) };
}

function tickBees(bees: SimBee[], rand: () => number, speed: number = 1, drawFrontierY?: number): SimBee[] {
  const pos = new Map<number, { x: number; y: number }>();
  bees.forEach(b => pos.set(b.id, { x: b.x, y: b.y }));

  return bees.map(bee => {
    let { x, y, tx, ty, angle, dwell, greetCooldown, greetedX, greetedY, waxUnits, isBuilder } = bee;

    // Passive wax production every tick (all bees, but only builders act on it)
    if (isBuilder) waxUnits = Math.min(WAX_MAX_PER_BEE, waxUnits + WAX_FILL_RATE);

    const { dx, dy, d: dist } = torusDelta(x, y, tx, ty);
    const step = BEE_SPEED * BEE_TICK_MS * Math.min(Math.max(speed, 0), 20);
    if (dist > step) {
      x += (dx / dist) * step;
      y += (dy / dist) * step;
      angle = Math.atan2(dy, dx);
    } else {
      x = tx; y = ty;
      dwell -= BEE_TICK_MS;
    }

    let repX = 0, repY = 0;
    for (const [otherId, op] of pos) {
      if (otherId === bee.id) continue;
      const { dx: odx, dy: ody, d } = torusDelta(op.x, op.y, x, y);
      if (d < MIN_DIST && d > 0.01) {
        const force = (MIN_DIST - d) / MIN_DIST;
        repX += (odx / d) * force * 1.5;
        repY += (ody / d) * force * 1.5;
      }
    }
    x += repX; y += repY;

    x = ((x % COMB_W) + COMB_W) % COMB_W;
    y = ((y % COMB_H) + COMB_H) % COMB_H;

    if (greetCooldown > 0) greetCooldown -= BEE_TICK_MS;

    if (dwell <= 0 && !bee.foragerPhase && !bee.receiverPhase) {
      // Forager and receiver bees have targets managed by the forager tick;
      // skip greeting/random-walk so their direction is not overridden.

      // Builder bees near an active drawing frontier: move to frontier and deposit wax
      if (isBuilder && drawFrontierY !== undefined && waxUnits > WAX_MAX_PER_BEE * 0.05) {
        const distToFrontier = Math.abs(y - drawFrontierY);
        if (distToFrontier < WAX_FRONTIER_BAND) {
          // At frontier — deposit wax, brief dwell, stay nearby
          waxUnits = Math.max(0, waxUnits - WAX_DEPOSIT_RATE);
          tx = Math.max(1, Math.min(COMB_W - 1, x + (rand() - 0.5) * 6));
          ty = Math.max(0, Math.min(COMB_H - 1, drawFrontierY + (rand() - 0.5) * WAX_FRONTIER_BAND));
          dwell = 120 + rand() * 200;
        } else {
          // Move toward frontier
          tx = Math.max(1, Math.min(COMB_W - 1, COMB_W * (0.2 + rand() * 0.6)));
          ty = Math.max(0, Math.min(COMB_H - 1, drawFrontierY + (rand() - 0.5) * WAX_FRONTIER_BAND * 0.5));
          dwell = 80 + rand() * 120;
        }
        return { ...bee, x, y, tx, ty, angle, dwell, greetCooldown, greetedX, greetedY, waxUnits, isBuilder };
      }
      // Builder out of wax: drift back toward centre to "reload" from honey stores
      if (isBuilder && drawFrontierY !== undefined && waxUnits < WAX_MAX_PER_BEE * 0.1) {
        tx = COMB_W * (0.25 + rand() * 0.5);
        ty = COMB_H * (0.35 + rand() * 0.3);
        dwell = 300 + rand() * 400;
        return { ...bee, x, y, tx, ty, angle, dwell, greetCooldown, greetedX, greetedY, waxUnits, isBuilder };
      }

      if (greetCooldown <= 0) {
        let greeted = false;
        for (const [otherId, op] of pos) {
          if (otherId === bee.id) continue;
          const { dx: gdx, dy: gdy, d } = torusDelta(x, y, op.x, op.y);
          if (d < GREET_DIST) {
            tx = ((x + gdx * 0.35) % COMB_W + COMB_W) % COMB_W;
            ty = ((y + gdy * 0.35) % COMB_H + COMB_H) % COMB_H;
            dwell = 520 + rand() * 400;
            greetCooldown = dwell + 600;
            greetedX = op.x; greetedY = op.y;
            greeted = true;
            break;
          }
        }
        if (!greeted) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const ntx = x + (rand() - 0.5) * 26 + (COMB_W * 0.50 - x) * 0.05;
            const nty = y + (rand() - 0.5) * 16 + (COMB_H * 0.54 - y) * 0.05;
            const cx = ((ntx % COMB_W) + COMB_W) % COMB_W;
            const cy = ((nty % COMB_H) + COMB_H) % COMB_H;
            let tooClose = false;
            for (const [otherId, op] of pos) {
              if (otherId === bee.id) continue;
              if (torusDelta(cx, cy, op.x, op.y).d < MIN_DIST) { tooClose = true; break; }
            }
            tx = cx; ty = cy;
            if (!tooClose) break;
          }
          dwell = rand() < 0.35 ? 700 + rand() * 1300 : 50 + rand() * 150;
        }
      } else if (greetedX >= 0) {
        const { dx: rdx, dy: rdy, d: rlen } = torusDelta(greetedX, greetedY, x, y);
        const safeLen = rlen > 0.01 ? rlen : 1;
        tx = ((x + (rdx / safeLen) * (GREET_DIST + 3)) % COMB_W + COMB_W) % COMB_W;
        ty = ((y + (rdy / safeLen) * (GREET_DIST + 3)) % COMB_H + COMB_H) % COMB_H;
        dwell = 200;
        greetedX = -1;
      } else {
        const ntx = x + (rand() - 0.5) * 26 + (COMB_W * 0.50 - x) * 0.05;
        const nty = y + (rand() - 0.5) * 16 + (COMB_H * 0.54 - y) * 0.05;
        tx = ((ntx % COMB_W) + COMB_W) % COMB_W;
        ty = ((nty % COMB_H) + COMB_H) % COMB_H;
        dwell = rand() < 0.35 ? 700 + rand() * 1300 : 50 + rand() * 150;
      }
    }

    return { ...bee, x, y, tx, ty, angle, dwell, greetCooldown, greetedX, greetedY, waxUnits, isBuilder };
  });
}

// ── Hive simulation hook ──────────────────────────────────────────────────────

function useHiveSimulation() {
  const queenLayTargetRef  = useRef<{r:number;c:number;cx:number;cy:number}|null>(null);
  const queenCrossingToRef = useRef<string | null>(null); // frameKey she's walking toward
  const queenRandRef       = useRef<() => number>(seeded(1));
  const queenDwellMsRef    = useRef(0);
  const queenRestUntilRef  = useRef(0);
  const queenBurstRemRef   = useRef(0);
  const queenRecentRef     = useRef<Set<string>>(new Set());
  // Permanently rejected cells: full key "frameKey:r:c" → wall-clock time of rejection.
  // Queen won't return until one full simulated brood cycle has elapsed.
  const queenSkippedRef    = useRef<Map<string, number>>(new Map());
  const queenRef  = useRef<QueenState>({
    frameKey: '4',
    x: COMB_W * 0.5, y: COMB_H * 0.56, angle: 0,
    txTarget: COMB_W * 0.5, tyTarget: COMB_H * 0.56,
    nextLayTime: Date.now() + LAY_INTERVAL_MS,
    layDirection: 1, layRow: 0,
  });
  const broodRef        = useRef<Record<string, number>>({});
  const stateRef        = useRef<HivePersistentState | null>(null);
  const lastCheckRef    = useRef(0);
  const drawnCellsRef   = useRef<Record<string, string[]>>({});
  const combProgressRef = useRef<Record<string, number>>({});
  const totalAdultBeesRef = useRef(0);
  const simSpeedRef         = useRef(1);
  const pauseStartRef       = useRef<number | null>(null);
  const lastActiveSpeedRef  = useRef(1); // speed just before last pause

  const [totalAdultBees, setTotalAdultBees] = useState(0);
  const [foragerStats, setForagerStats]     = useState({ outside: 0, stored: 0 });
  const [outsideForagersSnap, setOutsideForagersSnap] = useState<OutsideForager[]>([]);
  const [broodVersion, setBroodVersion]     = useState(0);
  const [resourceVersion, setResourceVersion] = useState(0);
  const [queenFrameKey, setQueenFrameKey]   = useState('4');
  const [layCount, setLayCount]             = useState(0);
  const [boxStack, setBoxStack]             = useState<string[]>(defaultBoxStack());
  const [boxFrames, setBoxFrames]           = useState<Record<string, (string | null)[]>>(defaultBoxFrames());
  const [drawnCells, setDrawnCells]         = useState<Record<string, string[]>>({});
  const [simSpeed,   setSimSpeedState]      = useState(1);

  // Refs for timer access without closure staleness
  const boxStackRef  = useRef<string[]>(defaultBoxStack());
  const boxFramesRef = useRef<Record<string, (string | null)[]>>(defaultBoxFrames());
  const newFrameCounter = useRef(0);
  const superCounter = useRef(0);

  useEffect(() => { boxStackRef.current  = boxStack;  globalBoxStack  = boxStack;  }, [boxStack]);
  useEffect(() => { boxFramesRef.current = boxFrames; globalBoxFrames = boxFrames; }, [boxFrames]);
  useEffect(() => { updateGlobalFrameAdjacency(boxFrames); }, [boxFrames]);

  // Find which box currently contains a given frame key
  const frameBoxOf = (fk: string, frames: Record<string, (string | null)[]>): string | null => {
    for (const [bid, flist] of Object.entries(frames)) {
      if (flist.includes(fk)) return bid;
    }
    return null;
  };

  // ── Frame management actions ────────────────────────────────────────────────

  const addBox = useCallback(() => {
    const newId = `super${++superCounter.current}`;
    // New box starts with 10 empty slots; beekeeper adds frames as needed
    const emptySlots: (string | null)[] = new Array(10).fill(null);
    setBoxStack(prev => [newId, ...prev]);
    setBoxFrames(prev => ({ ...prev, [newId]: emptySlots }));
  }, []);

  const removeBox = useCallback((boxId: string) => {
    const frames = (boxFramesRef.current[boxId] ?? []).filter((x): x is string => x !== null);
    // Migrate bees to the nearest remaining box (lower first, then upper)
    const boxIdx = boxStackRef.current.indexOf(boxId);
    const targetBoxId = boxIdx < boxStackRef.current.length - 1
      ? boxStackRef.current[boxIdx + 1]
      : boxIdx > 0 ? boxStackRef.current[boxIdx - 1] : null;
    if (targetBoxId) {
      const targetFrames = (boxFramesRef.current[targetBoxId] ?? []).filter((x): x is string => x !== null);
      if (targetFrames.length > 0) {
        const allBees: SimBee[] = frames.flatMap(fk => frameBeeStore[fk]?.bees ?? []);
        // Round-robin across target frames, skipping any at capacity
        for (let i = 0; i < allBees.length; i++) {
          const tfk = targetFrames[i % targetFrames.length];
          const toStore = getOrInitFrameStore(tfk);
          const tn = parseInt(tfk); const tfi = isNaN(tn) ? 0 : tn % 10;
          if (toStore.bees.length < frameBeeDensity(tfi) * 4) {
            toStore.bees = [...toStore.bees, { ...allBees[i] }];
          }
        }
      }
    }
    // Relocate queen if she was in this box
    if (frames.includes(queenRef.current.frameKey) ||
        (queenCrossingToRef.current !== null && frames.includes(queenCrossingToRef.current))) {
      queenCrossingToRef.current = null;
      const newFk = targetBoxId
        ? (boxFramesRef.current[targetBoxId] ?? []).find((x): x is string => x !== null) ?? null
        : null;
      if (newFk) {
        queenRef.current.frameKey = newFk;
        queenRef.current.x = COMB_W * 0.5; queenRef.current.y = COMB_H * 0.56;
        queenRef.current.txTarget = COMB_W * 0.5; queenRef.current.tyTarget = COMB_H * 0.56;
        setQueenFrameKey(newFk);
      }
    }
    // Clean up brood, resource, drawn-comb, and bee stores for removed box
    let drawnChanged = false;
    for (const fk of frames) {
      clearFrameStores(fk);
      const prefix = `${fk}:`;
      for (const k of Object.keys(broodRef.current)) {
        if (k.startsWith(prefix)) delete broodRef.current[k];
      }
      if (fk in drawnCellsRef.current) {
        delete drawnCellsRef.current[fk];
        drawnChanged = true;
      }
    }
    if (drawnChanged) setDrawnCells({ ...drawnCellsRef.current });
    onResourceUpdate?.();
    emitForagerUpdate();
    setBoxStack(prev => prev.filter(b => b !== boxId));
    setBoxFrames(prev => { const next = { ...prev }; delete next[boxId]; return next; });
  }, []);

  const addFrame = useCallback((boxId: string, slotIdx: number) => {
    const k = `n${++newFrameCounter.current}`;
    getOrInitFrameStore(k);
    setBoxFrames(prev => {
      const slots = [...(prev[boxId] ?? new Array(10).fill(null))] as (string | null)[];
      slots[slotIdx] = k;
      return { ...prev, [boxId]: slots };
    });
  }, []);

  const removeFrame = useCallback((boxId: string, slotIdx: number) => {
    const frames = boxFramesRef.current[boxId] ?? [];
    const removed = frames[slotIdx];
    if (!removed) return; // slot already empty
    // Find nearest occupied slot to migrate bees into
    let adjacentFk: string | null = null;
    for (let d = 1; d < frames.length; d++) {
      const r = slotIdx + d < frames.length ? frames[slotIdx + d] : null;
      const l = slotIdx - d >= 0 ? frames[slotIdx - d] : null;
      if (r) { adjacentFk = r; break; }
      if (l) { adjacentFk = l; break; }
    }
    // Migrate adult bees — nearest occupied slot first, any other frame as fallback
    const migrationTarget = adjacentFk ?? Object.keys(frameBeeStore).find(fk => fk !== removed) ?? null;
    if (migrationTarget && frameBeeStore[removed]) {
      const toStore = getOrInitFrameStore(migrationTarget);
      const tn = parseInt(migrationTarget); const tfi = isNaN(tn) ? 0 : tn % 10;
      const canAdd = Math.max(0, frameBeeDensity(tfi) * 4 - toStore.bees.length);
      const migrating = frameBeeStore[removed].bees.slice(0, canAdd)
        .map(bee => ({ ...bee }));
      toStore.bees = [...toStore.bees, ...migrating];
    }
    // Clean up removed frame
    clearFrameStores(removed);
    const prefix = `${removed}:`;
    for (const k of Object.keys(broodRef.current)) {
      if (k.startsWith(prefix)) delete broodRef.current[k];
    }
    // Relocate queen if she was on this frame
    if (queenRef.current.frameKey === removed || queenCrossingToRef.current === removed) {
      queenCrossingToRef.current = null;
      queenLayTargetRef.current = null;
      const newFk = migrationTarget ?? Object.keys(frameBeeStore).find(fk => fk !== removed) ?? null;
      if (newFk) {
        queenRef.current.frameKey = newFk;
        queenRef.current.x = COMB_W * 0.5; queenRef.current.y = COMB_H * 0.56;
        queenRef.current.txTarget = COMB_W * 0.5; queenRef.current.tyTarget = COMB_H * 0.56;
        setQueenFrameKey(newFk);
      }
    }
    // Clean up drawn cell records for the removed foundation frame
    if (removed in drawnCellsRef.current) {
      delete drawnCellsRef.current[removed];
      setDrawnCells({ ...drawnCellsRef.current });
    }
    onResourceUpdate?.();
    emitForagerUpdate();
    setBoxFrames(prev => {
      const slots = [...(prev[boxId] ?? [])] as (string | null)[];
      slots[slotIdx] = null;
      return { ...prev, [boxId]: slots };
    });
  }, []);

  const setSimSpeed = useCallback((newSpeed: number) => {
    const oldSpeed = simSpeedRef.current;
    if (oldSpeed === newSpeed) return;
    const now = Date.now();

    if (newSpeed === 0) {
      // Pausing — record when we paused, freeze speed
      pauseStartRef.current = now;
      lastActiveSpeedRef.current = oldSpeed; // remember speed for display during pause
      simSpeedRef.current = 0;
      globalSimSpeed = 0;
      globalPauseNow = now;
      globalLastActiveSpeed = oldSpeed; // freeze at pre-pause speed for rotation/role calcs
      setSimSpeedState(0);
      return;
    }

    if (oldSpeed === 0) {
      // Unpausing — shift all timestamps forward by pause duration so nothing ages while paused
      const pauseDuration = now - (pauseStartRef.current ?? now);
      const prePauseSpeed = lastActiveSpeedRef.current;
      pauseStartRef.current = null;
      const q = queenRef.current;
      q.nextLayTime += pauseDuration;
      if (queenRestUntilRef.current > 0) queenRestUntilRef.current += pauseDuration;
      for (const store of Object.values(frameBeeStore)) {
        for (const bee of store.bees) bee.bornAt += pauseDuration;
      }
      // Shift brood layTimes so the brood pattern doesn't change during pause
      const brood = broodRef.current;
      for (const key of Object.keys(brood)) brood[key] += pauseDuration;
      // Shift resource depositedAt so nectar doesn't cure during pause
      for (const key of Object.keys(resourceCells)) {
        resourceCells[key] = { ...resourceCells[key], depositedAt: resourceCells[key].depositedAt + pauseDuration };
      }
      // Shift forager returnTimes so they don't all flood back at once after a long pause
      for (const of_ of outsideForagers) {
        of_.spawnTime += pauseDuration;
        of_.returnTime += pauseDuration;
      }
      // If unpausing at a different speed than before the pause, also rescale timestamps
      if (prePauseSpeed !== newSpeed) {
        const ratio = prePauseSpeed / newSpeed;
        const rescaleFuture = (ts: number) => ts > now ? now + (ts - now) * ratio : ts;
        const rescalePast   = (ts: number) => now - (now - ts) * ratio;
        q.nextLayTime = rescaleFuture(q.nextLayTime);
        if (queenRestUntilRef.current > 0) queenRestUntilRef.current = rescaleFuture(queenRestUntilRef.current);
        if (queenDwellMsRef.current > 0) queenDwellMsRef.current *= ratio;
        for (const store of Object.values(frameBeeStore)) {
          for (const bee of store.bees) bee.bornAt = rescalePast(bee.bornAt);
        }
        for (const key of Object.keys(brood)) brood[key] = rescalePast(brood[key]);
        for (const key of Object.keys(resourceCells)) {
          resourceCells[key] = { ...resourceCells[key], depositedAt: rescalePast(resourceCells[key].depositedAt) };
        }
        for (const of_ of outsideForagers) {
          of_.spawnTime = rescalePast(of_.spawnTime);
          of_.returnTime = rescaleFuture(of_.returnTime);
        }
      }
      lastActiveSpeedRef.current = newSpeed;
      simSpeedRef.current = newSpeed;
      globalSimSpeed = newSpeed;
      globalPauseNow = null;
      globalLastActiveSpeed = newSpeed;
      setSimSpeedState(newSpeed);
      return;
    }

    // Normal speed change (both non-zero): rescale timestamps
    const ratio = oldSpeed / newSpeed;
    const rescaleFuture = (ts: number) => ts > now ? now + (ts - now) * ratio : ts;
    const rescalePast = (ts: number) => now - (now - ts) * ratio;
    const q = queenRef.current;
    q.nextLayTime = rescaleFuture(q.nextLayTime);
    queenRestUntilRef.current = rescaleFuture(queenRestUntilRef.current);
    if (queenDwellMsRef.current > 0) queenDwellMsRef.current *= ratio;
    // Rescale bee bornAt timestamps so remaining lifespan is preserved at new speed
    for (const store of Object.values(frameBeeStore)) {
      for (const bee of store.bees) bee.bornAt = rescalePast(bee.bornAt);
    }
    // Rescale brood layTimes so developmental stage is preserved visually
    const brood = broodRef.current;
    for (const key of Object.keys(brood)) {
      brood[key] = rescalePast(brood[key]);
    }
    // Rescale nectar depositedAt so curing time is preserved at the new speed
    for (const key of Object.keys(resourceCells)) {
      resourceCells[key] = { ...resourceCells[key], depositedAt: rescalePast(resourceCells[key].depositedAt) };
    }
    for (const of_ of outsideForagers) {
      of_.spawnTime = rescalePast(of_.spawnTime);
      of_.returnTime = rescaleFuture(of_.returnTime);
    }
    lastActiveSpeedRef.current = newSpeed;
    simSpeedRef.current = newSpeed;
    globalSimSpeed = newSpeed;
    globalLastActiveSpeed = newSpeed;
    setSimSpeedState(newSpeed);
  }, []);

  useEffect(() => {
    const state = loadHiveState() ?? initHiveState();
    stateRef.current  = state;
    broodRef.current  = { ...state.broodCells };
    Object.assign(queenRef.current, state.queen);
    setQueenFrameKey(state.queen.frameKey);
    const bs = state.boxStack ?? defaultBoxStack();
    const bf = state.boxFrames ?? defaultBoxFrames();
    const dc = state.drawnCells ?? {};

    // Clear stale bee stores from previous session (module-level singletons persist across hot reloads)
    for (const k of Object.keys(frameBeeStore)) delete frameBeeStore[k];
    for (const k of Object.keys(resourceCells)) delete resourceCells[k];
    outsideForagers.length = 0;
    nextBeeId = 1;
    recycledBeeIds.length = 0;
    setOutsideForagersSnap([]);
    // Load saved resources, validating each key against the current cell grid.
    // Old saves may have r:c values outside the current grid, or as floats — discard/normalize.
    if (state.resourceCells) {
      const validCellCache = new Map<string, Set<string>>(); // frameKey → Set of "r:c"
      let kept = 0, discarded = 0;
      for (const [key, rc] of Object.entries(state.resourceCells)) {
        const parts = key.split(':');
        if (parts.length !== 3) { discarded++; continue; }
        const [fk, rStr, cStr] = parts;
        const n = parseInt(fk);
        const r = parseInt(rStr), c = parseInt(cStr);
        if (isNaN(n) || isNaN(r) || isNaN(c)) { discarded++; continue; }
        if (!validCellCache.has(fk)) {
          const validCells = generateCells(COMB_W, COMB_H, n + 1);
          validCellCache.set(fk, new Set(validCells.map(cell => `${cell.r}:${cell.c}`)));
        }
        if (validCellCache.get(fk)!.has(`${r}:${c}`)) {
          resourceCells[`${fk}:${r}:${c}`] = rc; // use normalized integer key
          kept++;
        } else {
          discarded++;
        }
      }
      console.log(`[load] resourceCells: kept=${kept} discarded=${discarded} total=${kept+discarded}`);
    }

    // Pad any box frame array shorter than 10 (backward compat with pre-null-slot saves)
    for (const boxId of Object.keys(bf)) {
      while (bf[boxId].length < 10) (bf[boxId] as (string | null)[]).push(null);
    }

    // Seed counters to avoid ID collisions with loaded state
    superCounter.current = bs.filter(id => id.startsWith('super'))
      .reduce((max, id) => Math.max(max, parseInt(id.slice(5)) || 0), 0);
    const allLoadedFrameKeys = Object.values(bf).flat().filter((x): x is string => x !== null);
    newFrameCounter.current = allLoadedFrameKeys.filter(fk => fk.startsWith('n'))
      .reduce((max, fk) => Math.max(max, parseInt(fk.slice(1)) || 0), 0);

    setBoxStack(bs);
    setBoxFrames(bf);
    setDrawnCells(dc);
    boxStackRef.current   = bs;
    boxFramesRef.current  = bf;
    drawnCellsRef.current = dc;
    globalBoxStack  = bs;
    globalBoxFrames = bf;
    updateGlobalFrameAdjacency(bf);

    // Restore accumulated sim time so the clock doesn't reset on reload
    if (state.simTimeMs) globalSimTimeMs = state.simTimeMs;

    // Restore saved sim speed so brood layTime timestamps remain valid (they are calibrated to this speed)
    const savedSpeed = Math.max(1, state.simSpeed ?? 1);
    simSpeedRef.current      = savedSpeed;
    lastActiveSpeedRef.current = savedSpeed;
    globalSimSpeed           = savedSpeed;
    globalLastActiveSpeed    = savedSpeed;
    setSimSpeedState(savedSpeed);

    // Pre-initialize bee stores for all frames so they exist globally from the start
    for (const fk of Object.values(bf).flat().filter((x): x is string => x !== null)) getOrInitFrameStore(fk);
    // Seed the display with the actual bee count before the first tick fires
    const initialTotal = Math.min(MAX_COLONY_SIZE,
      countLiveBees());
    totalAdultBeesRef.current = initialTotal;
    setTotalAdultBees(initialTotal);
    if (stateRef.current) stateRef.current.totalAdultBees = initialTotal;
    // Register the population display callback and start the global tick
    onBeeCountUpdate = (n) => { totalAdultBeesRef.current = n; setTotalAdultBees(n); };
    onResourceUpdate = () => setResourceVersion(v => v + 1);
    onForagerUpdate = (outside, stored) => {
      setOutsideForagersSnap(outside);
      setForagerStats({ outside: outside.length, stored });
    };
    getBroodCells  = () => broodRef.current;
    getDrawnCells  = () => drawnCellsRef.current;
    startGlobalBeeTick();

    queenRandRef.current = seeded((state.queen.nextLayTime % 99983) + 1);
    queenBurstRemRef.current = BURST_EGGS_MIN + Math.floor(queenRandRef.current() * (BURST_EGGS_MAX - BURST_EGGS_MIN + 1));
    const initTarget = pickLevyTarget(queenRef.current, queenRecentRef.current, queenRandRef.current, drawnCellsRef.current);
    if (initTarget) {
      queenRef.current.txTarget = initTarget.cx;
      queenRef.current.tyTarget = initTarget.cy;
    }

    const timer = setInterval(() => {
      const now   = Date.now();
      const speed = simSpeedRef.current;
      if (speed === 0) return;
      const q   = queenRef.current;
      const dx   = q.txTarget - q.x;
      const dy   = q.tyTarget - q.y;
      const dist = Math.hypot(dx, dy);
      const step = QUEEN_SPEED_PX_PER_MS * BEE_TICK_MS * speed;

      if (queenRestUntilRef.current > 0) {
        if (now >= queenRestUntilRef.current) {
          queenRestUntilRef.current = 0;
          queenBurstRemRef.current = BURST_EGGS_MIN + Math.floor(queenRandRef.current() * (BURST_EGGS_MAX - BURST_EGGS_MIN + 1));
          q.nextLayTime = now + LAY_INTERVAL_ACTIVE_MS / speed;
          const next = pickLevyTarget(q, queenRecentRef.current, queenRandRef.current, drawnCellsRef.current);
          if (next) { q.txTarget = next.cx; q.tyTarget = next.cy; }
        }
      } else if (queenDwellMsRef.current > 0) {
        queenDwellMsRef.current -= BEE_TICK_MS * speed;
        if (now >= q.nextLayTime && !queenLayTargetRef.current && queenBurstRemRef.current > 0) {
          const target = findBestLayTarget(q, broodRef.current, now, drawnCellsRef.current, queenRecentRef.current, queenSkippedRef.current);
          if (target) {
            queenLayTargetRef.current = target;
            q.txTarget = target.cx; q.tyTarget = target.cy;
            queenDwellMsRef.current = 0;
          }
        }
      } else if (dist > step) {
        q.x += (dx / dist) * step; q.y += (dy / dist) * step;
        q.angle = Math.atan2(dy, dx);
        if (now >= q.nextLayTime && !queenLayTargetRef.current && queenBurstRemRef.current > 0) {
          const target = findBestLayTarget(q, broodRef.current, now, drawnCellsRef.current, queenRecentRef.current, queenSkippedRef.current);
          if (target) {
            queenLayTargetRef.current = target;
            q.txTarget = target.cx; q.tyTarget = target.cy;
          }
        }
      } else {
        q.x = q.txTarget; q.y = q.tyTarget;

        // ── Frame crossing: queen just reached the edge of her current frame ──
        if (queenCrossingToRef.current) {
          const nextFk = queenCrossingToRef.current;
          queenCrossingToRef.current = null;
          q.frameKey = nextFk;
          // Enter the new frame from the opposite edge
          q.x = q.layDirection > 0 ? 0 : COMB_W;
          q.txTarget = q.x; q.tyTarget = q.y;
          q.nextLayTime = now + LAY_INTERVAL_ACTIVE_MS / speed;
          queenRecentRef.current.clear();
          setQueenFrameKey(nextFk);
          const next = pickLevyTarget(q, queenRecentRef.current, queenRandRef.current, drawnCellsRef.current);
          if (next) { q.txTarget = next.cx; q.tyTarget = next.cy; }
        } else {
          const lt = queenLayTargetRef.current;
          if (lt) {
            // ~7% cell rejection: queen inspects and walks away without laying.
            // The cell is permanently skipped until one full brood cycle elapses —
            // matching real queen behaviour where rejected cells stay empty until
            // workers re-polish them after the surrounding brood emerges.
            if (queenRandRef.current() < 0.07) {
              queenSkippedRef.current.set(`${q.frameKey}:${lt.r}:${lt.c}`, now);
              queenLayTargetRef.current = null;
              q.nextLayTime = now + LAY_INTERVAL_ACTIVE_MS / speed;
              queenDwellMsRef.current = INSPECT_DWELL_MIN_MS + Math.floor(queenRandRef.current() * (INSPECT_DWELL_MAX_MS - INSPECT_DWELL_MIN_MS));
            } else {
              broodRef.current[`${q.frameKey}:${lt.r}:${lt.c}`] = now;
              queenBurstRemRef.current--;
              setLayCount(n => n + 1);
              queenLayTargetRef.current = null;
              if (queenBurstRemRef.current <= 0) {
                queenRestUntilRef.current = now + (REST_MIN_MS + queenRandRef.current() * (REST_MAX_MS - REST_MIN_MS)) / speed;
              } else {
                q.nextLayTime = now + LAY_INTERVAL_ACTIVE_MS / speed;
                queenDwellMsRef.current = INSPECT_DWELL_MIN_MS + Math.floor(queenRandRef.current() * (INSPECT_DWELL_MAX_MS - INSPECT_DWELL_MIN_MS));
              }
            }
            const next = pickLevyTarget(q, queenRecentRef.current, queenRandRef.current, drawnCellsRef.current);
            if (next) { q.txTarget = next.cx; q.tyTarget = next.cy; }
          } else if (now >= q.nextLayTime && queenBurstRemRef.current > 0) {
            const target = findBestLayTarget(q, broodRef.current, now, drawnCellsRef.current, queenRecentRef.current, queenSkippedRef.current);
            if (target) {
              queenLayTargetRef.current = target;
              q.txTarget = target.cx; q.tyTarget = target.cy;
            } else {
              // No empty cells — cross to the adjacent frame that keeps queen
              // closest to the centre of the box (brood nest preference).
              const currentBox = frameBoxOf(q.frameKey, boxFramesRef.current);
              if (currentBox) {
                const boxList = (boxFramesRef.current[currentBox] ?? []).filter((x): x is string => x !== null);
                const pos = boxList.indexOf(q.frameKey);
                const boxMid = (boxList.length - 1) / 2;
                // Prefer the direction toward the box centre; randomise when equidistant
                const rightPos = (pos + 1) % boxList.length;
                const leftPos  = (pos - 1 + boxList.length) % boxList.length;
                const towardCenter = Math.abs(rightPos - boxMid) <= Math.abs(leftPos - boxMid)
                  ? 1 : -1;
                q.layDirection = (queenRandRef.current() < 0.8 ? towardCenter : -towardCenter) as 1 | -1;
                const nextPos = ((pos + q.layDirection) + boxList.length) % boxList.length;
                const nextFk = boxList[nextPos] ?? q.frameKey;
                if (nextFk !== q.frameKey) {
                  queenCrossingToRef.current = nextFk;
                  q.txTarget = q.layDirection > 0 ? COMB_W : 0;
                  q.tyTarget = q.y;
                }
              }
            }
          } else {
            queenDwellMsRef.current = INSPECT_DWELL_MIN_MS + Math.floor(queenRandRef.current() * (INSPECT_DWELL_MAX_MS - INSPECT_DWELL_MIN_MS));
            const cells2 = q.frameKey.startsWith('n')
              ? (() => { const ds = new Set(drawnCellsRef.current[q.frameKey] ?? []); return BLANK_BROOD_ZONE.filter(c => ds.has(`${c.r}:${c.c}`)); })()
              : getFrameZoneCells(q.frameKey);
            if (cells2.length) {
              let nr = cells2[0]; let nd = Infinity;
              for (const c of cells2) {
                const d = Math.hypot(c.cx - q.x, c.cy - q.y);
                if (d < nd) { nd = d; nr = c; }
              }
              queenRecentRef.current.add(`${nr.r}:${nr.c}`);
              if (queenRecentRef.current.size > 25)
                queenRecentRef.current.delete(queenRecentRef.current.values().next().value!);
            }
            const next = pickLevyTarget(q, queenRecentRef.current, queenRandRef.current, drawnCellsRef.current);
            if (next) { q.txTarget = next.cx; q.tyTarget = next.cy; }
          }
        }
      }

      // 1Hz brood scan
      if (now - lastCheckRef.current >= BROOD_CHECK_MS) {
        lastCheckRef.current = now;
        // Expire permanently-skipped cells after one full simulated brood cycle
        for (const [key, rejectedAt] of queenSkippedRef.current) {
          if ((now - rejectedAt) * speed >= EMERGE_MS) queenSkippedRef.current.delete(key);
        }
        const brood = broodRef.current;
        const emerged: { frameKey: string; r: number; c: number }[] = [];
        for (const [key, layTime] of Object.entries(brood)) {
          if ((now - layTime) * speed >= EMERGE_MS) {
            delete brood[key];
            const parts = key.split(':');
            if (parts.length >= 3) {
              emerged.push({ frameKey: parts[0], r: Number(parts[1]), c: Number(parts[2]) });
            }
          }
        }
        if (emerged.length > 0) {
          for (const cell of emerged) addEmergedBeeToStore(cell.frameKey, cell.r, cell.c);
        }
        setBroodVersion(v => v + 1);

        // ── Comb drawing by worker bees ────────────────────────────────────
        // Colony-wide wax production drives drawing progress.
        // Rate scales with colony size; wax is split evenly across all blank
        // frames that still have undrawn cells.
        const elapsed = BROOD_CHECK_MS; // ms elapsed (this runs at 1 Hz)
        const allFrameKeys = Object.values(boxFramesRef.current).flat().filter((x): x is string => x !== null);
        const activeFrames = allFrameKeys.filter(fk =>
          fk.startsWith('n') &&
          (drawnCellsRef.current[fk]?.length ?? 0) < BLANK_FRAME_DRAW_ORDER.length
        );
        if (activeFrames.length > 0) {
          const waxPerFrame = (totalAdultBeesRef.current * WAX_RATE_PER_BEE_PER_MS * elapsed * speed)
                              / activeFrames.length;
          let drawnChanged = false;
          for (const fk of activeFrames) {
            const prev = drawnCellsRef.current[fk] ?? [];
            combProgressRef.current[fk] = (combProgressRef.current[fk] ?? 0) + waxPerFrame;
            const drawn = [...prev];
            while (combProgressRef.current[fk] >= WAX_PER_CELL && drawn.length < BLANK_FRAME_DRAW_ORDER.length) {
              combProgressRef.current[fk] -= WAX_PER_CELL;
              const next = BLANK_FRAME_DRAW_ORDER[drawn.length];
              drawn.push(`${next.r}:${next.c}`);
            }
            if (drawn.length !== prev.length) {
              drawnCellsRef.current[fk] = drawn;
              drawnChanged = true;
            }
          }
          if (drawnChanged) setDrawnCells({ ...drawnCellsRef.current });
        }
      }
    }, BEE_TICK_MS);

    const saveState = () => {
      const s = stateRef.current;
      if (!s) return;
      s.queen          = { ...queenRef.current };
      s.broodCells     = { ...broodRef.current };
      s.boxStack       = boxStackRef.current;
      s.boxFrames      = boxFramesRef.current;
      s.drawnCells     = { ...drawnCellsRef.current };
      s.totalAdultBees = totalAdultBeesRef.current;
      s.simSpeed       = simSpeedRef.current !== 0 ? simSpeedRef.current : lastActiveSpeedRef.current;
      s.resourceCells  = { ...resourceCells };
      s.simTimeMs      = globalSimTimeMs;
      saveHiveState(s);
    };
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', saveState);
    if (typeof window !== 'undefined')
      window.addEventListener('beforeunload', saveState);
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', saveState);
      if (typeof window !== 'undefined')
        window.removeEventListener('beforeunload', saveState);
    };
  }, []);

  const getCellOverrides = useCallback((frameKey: string): Map<string, CellOverride> => {
    const prefix = `${frameKey}:`;
    // When paused, freeze display at the moment of pause using last active speed
    const speed = simSpeedRef.current || lastActiveSpeedRef.current;
    const now   = simSpeedRef.current === 0 ? (pauseStartRef.current ?? Date.now()) : Date.now();
    const map = new Map<string, CellOverride>();
    for (const [key, layTime] of Object.entries(broodRef.current)) {
      if (!key.startsWith(prefix)) continue;
      const rest  = key.slice(prefix.length);
      const stage = getLifeStage(layTime, now, speed);
      if (!stage.emerged && stage.type !== 'empty') {
        const ov: CellOverride = { type: stage.type, larvalInstar: stage.larvalInstar };
        if (stage.type === 'larvae') ov.layTime = layTime;
        map.set(rest, ov);
      }
    }
    // Overlay live resource cells — wins over static cell fallback (all 'empty')
    for (const [key, rc] of Object.entries(resourceCells)) {
      if (!key.startsWith(prefix)) continue;
      const rcKey = key.slice(prefix.length); // "r:c"
      // Don't overwrite live brood (already in map from the top loop)
      const existing = map.get(rcKey);
      const isLiveBrood = existing && (existing.type === 'egg' || existing.type === 'larvae' || existing.type === 'capped_brood');
      if (!isLiveBrood) map.set(rcKey, { type: rc.kind });
    }
    return map;
  }, [broodVersion, resourceVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const getCellInfo = useCallback((frameKey: string, r: number, c: number): CellInfoResult => {
    const speed = simSpeedRef.current || lastActiveSpeedRef.current;
    const now   = simSpeedRef.current === 0 ? (pauseStartRef.current ?? Date.now()) : Date.now();
    const broodKey = `${frameKey}:${r}:${c}`;
    const layTime = broodRef.current[broodKey];
    if (layTime !== undefined) {
      const realAgoMs = now - layTime;
      const simAgoMs = realAgoMs * speed;
      const simRemMs = Math.max(0, EMERGE_MS - simAgoMs);
      const realRemMs = simRemMs / speed;
      const stage = getLifeStage(layTime, now, speed);
      return { kind: 'brood', r, c, frameKey, layTime, realAgoMs, simAgoMs, stage: stage.type, emerged: stage.emerged, realRemMs, simRemMs };
    }
    const isBlank = frameKey.startsWith('n');
    if (isBlank) {
      const drawn = drawnCellsRef.current[frameKey] ?? [];
      const isDrawn = new Set(drawn).has(`${r}:${c}`);
      return { kind: 'static', r, c, frameKey, cellType: isDrawn ? 'empty' : 'foundation' };
    }
    // Check live resource cells (honey/nectar/pollen deposited by bees)
    const rcKey = `${frameKey}:${r}:${c}`;
    const rc = resourceCells[rcKey];
    if (rc) return { kind: 'static', r, c, frameKey, cellType: rc.kind };
    return { kind: 'static', r, c, frameKey, cellType: 'empty' };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const boostPopulation = useCallback(() => {
    // Ensure all frames exist
    for (const fk of Object.values(boxFramesRef.current).flat().filter((x): x is string => x !== null)) getOrInitFrameStore(fk);
    const now = Date.now();
    // bornAt must respect current speed — at high speed, lifespan is much shorter.
    // When paused, use pre-pause speed so bees get realistic age spread.
    const effSpeed = globalPauseNow !== null ? globalLastActiveSpeed : Math.max(globalSimSpeed, 1);
    const effectiveLifespan = ADULT_LIFESPAN_MS / effSpeed;
    const frameKeys = Object.keys(frameBeeStore);
    // Distribute 1k bees evenly across frames; each frame can hold up to 4× normal density
    const addPerFrame = Math.ceil(1_000 / Math.max(frameKeys.length, 1));
    for (const fk of frameKeys) {
      const store = frameBeeStore[fk];
      const n = parseInt(fk);
      const fi = isNaN(n) ? 0 : n % 10;
      const cap = frameBeeDensity(fi) * 4;
      const toAdd = Math.min(addPerFrame, Math.max(0, cap - store.bees.length));
      if (toAdd === 0) continue;
      const additions: SimBee[] = [];
      for (let i = 0; i < toAdd; i++) {
        const x = 2 + Math.random() * (COMB_W - 4);
        const y = 1 + Math.random() * (COMB_H - 2);
        const isBuilder = Math.random() < 0.10;
        additions.push({
          id: allocateBeeId(), x, y, tx: x, ty: y,
          angle: Math.random() * Math.PI * 2,
          dwell: 200 + Math.random() * 400,
          greetCooldown: 0, greetedX: -1, greetedY: 0,
          waxUnits: isBuilder ? Math.random() * WAX_MAX_PER_BEE * 0.3 : 0,
          isBuilder, bornAt: now - Math.random() * effectiveLifespan * 0.5,
        });
      }
      store.bees = [...store.bees, ...additions];
    }
    // Immediately update the display count
    const total = Math.min(MAX_COLONY_SIZE,
      countLiveBees());
    totalAdultBeesRef.current = total;
    setTotalAdultBees(total);
  }, []);

  const killPopulation = useCallback(() => {
    // Ensure all frames exist
    for (const fk of Object.values(boxFramesRef.current).flat().filter((x): x is string => x !== null)) getOrInitFrameStore(fk);
    // Collect all bees across all frames, sorted oldest-first
    const allEntries: Array<{ fk: string; idx: number; bornAt: number }> = [];
    for (const fk of Object.keys(frameBeeStore)) {
      frameBeeStore[fk].bees.forEach((b, idx) => allEntries.push({ fk, idx, bornAt: b.bornAt }));
    }
    allEntries.sort((a, b) => a.bornAt - b.bornAt); // oldest first
    // Mark 1,000 of them for removal
    const toRemove = new Map<string, Set<number>>(); // frameKey → set of indices
    for (let i = 0; i < Math.min(1_000, allEntries.length); i++) {
      const { fk, idx } = allEntries[i];
      if (!toRemove.has(fk)) toRemove.set(fk, new Set());
      toRemove.get(fk)!.add(idx);
    }
    // Remove from each frame store
    for (const [fk, indices] of toRemove) {
      const removed = frameBeeStore[fk].bees.filter((_, i) => indices.has(i));
      releaseBeeIds(removed);
      frameBeeStore[fk].bees = frameBeeStore[fk].bees.filter((_, i) => !indices.has(i));
    }
    // Immediately update the display count
    const total = Math.min(MAX_COLONY_SIZE,
      countLiveBees());
    totalAdultBeesRef.current = total;
    setTotalAdultBees(total);
  }, []);

  return {
    queenRef, queenFrameKey, totalAdultBees, foragerStats, outsideForagersSnap, layCount, getCellOverrides,
    boxStack, boxFrames, drawnCells,
    simSpeed, setSimSpeed, boostPopulation, killPopulation,
    getCellInfo,
    addBox, removeBox, addFrame, removeFrame,
  };
}

// ── Frame bee layer ───────────────────────────────────────────────────────────


function FrameBeeLayer({ frameKey, drawFrontierY, beesExternalRef }: {
  frameKey?: string; drawFrontierY?: number;
  beesExternalRef?: React.MutableRefObject<SimBee[]>;
}) {
  const [, forceUpdate] = useState(0);

  // Ensure this frame's store exists (idempotent)
  const store = frameKey ? getOrInitFrameStore(frameKey) : null;

  // Keep frontier updated in store so the global tick can use it
  useEffect(() => { if (store) store.frontierY = drawFrontierY; });

  // Subscribe to global tick for re-renders
  useEffect(() => {
    const cb = () => forceUpdate(n => n + 1);
    beeTickListeners.add(cb);
    return () => { beeTickListeners.delete(cb); };
  }, []);

  const bees = store?.bees ?? [];
  if (beesExternalRef) beesExternalRef.current = bees;

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, width: COMB_W, height: COMB_H }} pointerEvents="none">
      <Svg width={COMB_W} height={COMB_H}>
        {bees.map(bee => {
          const deg = ((bee.angle * 180) / Math.PI).toFixed(1);
          return (
            <G key={bee.id} transform={`translate(${bee.x.toFixed(1)},${bee.y.toFixed(1)}) rotate(${deg})`}>
              {/* Legs — 3 pairs, drawn first so body covers roots */}
              <Path d="M -0.5,-0.72 L -1.1,-1.42 M 0.3,-0.76 L 0.0,-1.42 M 1.0,-0.66 L 1.3,-1.16" stroke="#2A1200" strokeWidth={0.22} fill="none" />
              <Path d="M -0.5,0.72 L -1.1,1.42 M 0.3,0.76 L 0.0,1.42 M 1.0,0.66 L 1.3,1.16" stroke="#2A1200" strokeWidth={0.22} fill="none" />
              {/* Abdomen — amber base with two dark bands */}
              <Ellipse cx={-0.95} cy={0} rx={1.45} ry={0.88} fill="#E8930A" />
              <Ellipse cx={-0.42} cy={0} rx={0.23} ry={0.87} fill="rgba(18,8,0,0.72)" />
              <Ellipse cx={-1.12} cy={0} rx={0.21} ry={0.67} fill="rgba(18,8,0,0.72)" />
              {/* Thorax — dark brownish oval */}
              <Ellipse cx={0.45} cy={0} rx={0.82} ry={0.76} fill="#3D1E08" />
              {/* Wings — closed, folded on dorsal surface (rendered on top of body) */}
              <Ellipse cx={-0.52} cy={-0.36} rx={1.28} ry={0.42} fill="rgba(195,225,255,0.52)" stroke="rgba(120,160,210,0.38)" strokeWidth={0.10} />
              <Ellipse cx={-0.52} cy={0.36} rx={1.28} ry={0.42} fill="rgba(195,225,255,0.52)" stroke="rgba(120,160,210,0.38)" strokeWidth={0.10} />
              {/* Head */}
              <Ellipse cx={1.62} cy={0} rx={0.52} ry={0.42} fill="#221000" />
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

// ── Queen bee layer ───────────────────────────────────────────────────────────

function QueenBeeLayer({ queenRef }: { queenRef: React.MutableRefObject<QueenState> }) {
  const isMounted       = useRef(true);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    isMounted.current = true;
    const timer = setInterval(() => {
      if (!isMounted.current) return;
      forceUpdate(n => n + 1);
    }, BEE_TICK_MS);
    return () => { isMounted.current = false; clearInterval(timer); };
  }, []);

  const q = queenRef.current;
  if (!q) return null;

  const deg = (q.angle * 180) / Math.PI;

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, width: COMB_W, height: COMB_H }} pointerEvents="none">
      <Svg width={COMB_W} height={COMB_H}>
        <G transform={`translate(${q.x.toFixed(1)},${q.y.toFixed(1)}) rotate(${deg.toFixed(1)})`}>
          {/* Legs */}
          <Path d="M -0.5,-0.72 L -1.1,-1.42 M 0.3,-0.76 L 0.0,-1.42 M 1.0,-0.66 L 1.3,-1.16" stroke="#2A1200" strokeWidth={0.22} fill="none" />
          <Path d="M -0.5,0.72 L -1.1,1.42 M 0.3,0.76 L 0.0,1.42 M 1.0,0.66 L 1.3,1.16" stroke="#2A1200" strokeWidth={0.22} fill="none" />
          {/* Abdomen */}
          <Ellipse cx={-0.95} cy={0} rx={1.45} ry={0.88} fill="#E8930A" />
          <Ellipse cx={-0.42} cy={0} rx={0.23} ry={0.87} fill="rgba(18,8,0,0.72)" />
          <Ellipse cx={-1.12} cy={0} rx={0.21} ry={0.67} fill="rgba(18,8,0,0.72)" />
          {/* Thorax */}
          <Ellipse cx={0.45} cy={0} rx={0.82} ry={0.76} fill="#3D1E08" />
          {/* Wings — closed, folded on dorsal surface */}
          <Ellipse cx={-0.52} cy={-0.36} rx={1.28} ry={0.42} fill="rgba(195,225,255,0.52)" stroke="rgba(120,160,210,0.38)" strokeWidth={0.10} />
          <Ellipse cx={-0.52} cy={0.36} rx={1.28} ry={0.42} fill="rgba(195,225,255,0.52)" stroke="rgba(120,160,210,0.38)" strokeWidth={0.10} />
          {/* Head */}
          <Ellipse cx={1.62} cy={0} rx={0.52} ry={0.42} fill="#221000" />
          {/* Year-dot on thorax: 2026 = lime green */}
          <Ellipse cx={0.45} cy={0} rx={0.35} ry={0.35} fill="#90EE30" />
        </G>
      </Svg>
    </View>
  );
}

// ── Bezier / bee helpers ─────────────────────────────────────────────────────

function bez(t: number, p0: number, p1: number, p2: number, p3: number) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function makePath(
  x0: number, y0: number, cx1: number, cy1: number,
  cx2: number, cy2: number, x1: number, y1: number, steps = 30,
) {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    xs.push(bez(t, x0, cx1, cx2, x1));
    ys.push(bez(t, y0, cy1, cy2, y1));
  }
  return { xs, ys };
}

type ForagerFlightPlan = {
  id: number;
  outXs: number[]; outYs: number[];
  inXs: number[]; inYs: number[];
  outFlyDuration: number;
  inFlyDuration: number;
  landX: number;
  walkDuration: number;
  size: number;
  load: 'nectar' | 'pollen';
  wobbleAmp: number; wobblePeriod: number;
};

function seeded(seed: number) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

// ── Cloud data ────────────────────────────────────────────────────────────────

type CloudOval  = { t: number; l: number; w: number; h: number; r: number };
type CloudShape = { ovals: CloudOval[]; cw: number; ch: number };

const CLOUD_SHAPES: CloudShape[] = [
  { cw: 100, ch: 45, ovals: [
    { t: 23, l:  0, w: 100, h: 22, r: 11 },
    { t:  3, l:  8, w:  42, h: 38, r: 20 },
    { t:  0, l: 40, w:  35, h: 35, r: 18 },
    { t: 10, l: 68, w:  28, h: 24, r: 12 },
  ]},
  { cw: 120, ch: 35, ovals: [
    { t: 17, l:   0, w: 120, h: 18, r:  9 },
    { t:  2, l:  10, w:  35, h: 28, r: 14 },
    { t:  0, l:  45, w:  30, h: 30, r: 15 },
    { t:  5, l:  78, w:  32, h: 24, r: 12 },
    { t: 10, l: 100, w:  20, h: 16, r:  8 },
  ]},
  { cw: 60, ch: 32, ovals: [
    { t: 16, l:  0, w: 60, h: 16, r: 8 },
    { t:  0, l:  8, w: 30, h: 28, r: 14 },
    { t:  5, l: 32, w: 22, h: 20, r: 10 },
  ]},
  { cw: 130, ch: 30, ovals: [
    { t: 12, l:   0, w: 130, h: 18, r:  9 },
    { t:  0, l:   5, w:  28, h: 24, r: 12 },
    { t:  2, l:  42, w:  32, h: 22, r: 11 },
    { t:  4, l:  90, w:  26, h: 18, r:  9 },
    { t:  8, l: 108, w:  22, h: 14, r:  7 },
  ]},
];

interface CloudDatum {
  y: number; s: number; speed: number; alpha: number;
  initX: number; type: number; bobAmp: number; bobPeriod: number; bobDelay: number;
}

const CLOUD_DATA: CloudDatum[] = (() => {
  const rand = seeded(31);
  const mkLayer = (
    count: number,
    sLo: number,  sHi: number,
    spLo: number, spHi: number,
    aLo: number,  aHi: number,
    yLo: number,  yHi: number,
    baLo: number, baHi: number,
    bpLo: number, bpHi: number,
  ): CloudDatum[] => Array.from({ length: count }, () => ({
    s:         sLo  + rand() * (sHi  - sLo),
    speed:     spLo + rand() * (spHi - spLo),
    alpha:     aLo  + rand() * (aHi  - aLo),
    y:         H * (yLo + rand() * (yHi - yLo)),
    initX:     rand() * W,
    type:      Math.floor(rand() * CLOUD_SHAPES.length),
    bobAmp:    baLo + rand() * (baHi - baLo),
    bobPeriod: bpLo + rand() * (bpHi - bpLo),
    bobDelay:  rand() * 15000,
  }));
  return [
    ...mkLayer(4, 0.25, 0.45, 1.5, 3.5, 0.40, 0.65, 0.03, 0.15, 1.0, 2.5, 18000, 28000),
    ...mkLayer(4, 0.60, 1.00, 3.5,   7, 0.78, 0.95, 0.04, 0.20, 2.0, 4.5, 12000, 20000),
  ];
})();

function makeForagerFlightPlan(forager: OutsideForager): ForagerFlightPlan {
  const rand = seeded(forager.id * 97 + 17);
  const boardHalf = (HIVE_W + 14) / 2;
  const entHalf   = ENTRANCE_W / 2;
  const side = rand() > 0.5 ? 1 : -1;
  const landX = ENT_X + side * (entHalf + 5 + rand() * (boardHalf - entHalf - 8));
  const offTop = rand() > 0.3;
  const farX = offTop ? ENT_X + side * (50 + rand() * W * 0.38) : (side > 0 ? W + 60 : -60);
  const farY = offTop ? -(25 + rand() * 60) : LAND_Y - (70 + rand() * H * 0.28);
  const outPath = makePath(landX, LAND_Y, landX + side * 20, LAND_Y - 35, farX - side * 45, farY + 65, farX, farY);
  const inPath = makePath(farX, farY, farX - side * 45, farY + 65, landX + side * 20, LAND_Y - 35, landX, LAND_Y);
  return {
    id: forager.id, outXs: outPath.xs, outYs: outPath.ys, inXs: inPath.xs, inYs: inPath.ys,
    outFlyDuration: 1800 + rand() * 1200,
    inFlyDuration: 2800 + rand() * 1800,
    landX, walkDuration: Math.abs(landX - ENT_X) * 14,
    size: 1.5 + rand() * 0.7,
    load: forager.load,
    wobbleAmp: 1 + rand() * 1, wobblePeriod: 220 + rand() * 130,
  };
}

// ── Bee component ────────────────────────────────────────────────────────────

function samplePath(xs: number[], ys: number[], t: number) {
  const clamped = Math.max(0, Math.min(1, t));
  const idx = clamped * (xs.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(xs.length - 1, lo + 1);
  const frac = idx - lo;
  return {
    x: xs[lo] + (xs[hi] - xs[lo]) * frac,
    y: ys[lo] + (ys[hi] - ys[lo]) * frac,
  };
}

function ForagerBee({ forager, now }: { forager: OutsideForager; now: number }) {
  const data = useMemo(() => makeForagerFlightPlan(forager), [forager.id]);
  const wingAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(wingAnim, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(wingAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ])).start();
  }, []);

  const t = globalPauseNow ?? now;
  const outWalkEnd = forager.spawnTime + data.walkDuration;
  const outFlyEnd = outWalkEnd + data.outFlyDuration;
  const inWalkStart = forager.returnTime - data.walkDuration;
  const inFlyStart = inWalkStart - data.inFlyDuration;

  let x = 0, y = 0, opacity = 1;
  if (t < forager.spawnTime || t >= forager.returnTime) return null;
  if (t < outWalkEnd) {
    const p = (t - forager.spawnTime) / data.walkDuration;
    x = ENT_X + (data.landX - ENT_X) * p;
    y = LAND_Y;
    opacity = Math.min(1, Math.max(0, p / 0.12));
  } else if (t < outFlyEnd) {
    const p = (t - outWalkEnd) / data.outFlyDuration;
    const eased = p * p;
    const pt = samplePath(data.outXs, data.outYs, eased);
    x = pt.x; y = pt.y;
  } else if (t >= inFlyStart && t < inWalkStart) {
    const p = (t - inFlyStart) / data.inFlyDuration;
    const eased = 1 - Math.pow(1 - p, 3);
    const pt = samplePath(data.inXs, data.inYs, eased);
    x = pt.x; y = pt.y;
  } else if (t >= inWalkStart) {
    const p = (t - inWalkStart) / data.walkDuration;
    x = data.landX + (ENT_X - data.landX) * p;
    y = LAND_Y;
    opacity = Math.max(0, Math.min(1, (1 - p) / 0.12));
  } else {
    return null;
  }

  const wobT = (t / data.wobblePeriod) + data.id * 0.37;
  x += Math.sin(wobT) * data.wobbleAmp;
  y += Math.cos(wobT * 0.77) * data.wobbleAmp * 0.6;

  const wingScaleY = wingAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.12] });
  const bw = data.size * 3.5, bh = data.size;
  const bodyColor = data.load === 'pollen' ? '#B36B06' : '#E8960A';
  return (
    <Animated.View style={{ position: 'absolute', top: 0, left: 0, opacity, transform: [{ translateX: x }, { translateY: y }] }}>
      <Animated.View style={{ position: 'absolute', top: -bh * 0.9, left: 0, flexDirection: 'row', transform: [{ scaleY: wingScaleY }] }}>
        <View style={{ width: bw * 0.44, height: bh * 1.2, borderRadius: bh, backgroundColor: 'rgba(210,238,255,0.75)', marginRight: 1 }} />
        <View style={{ width: bw * 0.44, height: bh * 1.2, borderRadius: bh, backgroundColor: 'rgba(210,238,255,0.75)' }} />
      </Animated.View>
      <View style={{ width: bw, height: bh, borderRadius: bh / 2, backgroundColor: bodyColor }}>
        {data.load === 'pollen' && (
          <View style={{ position: 'absolute', right: bw * 0.18, top: -bh * 0.18, width: bh * 0.65, height: bh * 0.65, borderRadius: bh, backgroundColor: '#F4D03F' }} />
        )}
      </View>
    </Animated.View>
  );
}

// ── Hive piece visual ────────────────────────────────────────────────────────

function PieceView({ id, highlighted }: { id: string; highlighted: boolean }) {
  const highlight: object = highlighted ? { borderColor: '#FFD700', borderWidth: 2 } : {};
  if (id === 'lid')
    return <View style={[{ width: LID_W, height: LID_H, backgroundColor: '#7A7A7A', borderRadius: 3 }, highlight]} />;
  if (id === 'inner')
    return <View style={[{ width: LID_W - 4, height: INNER_H, backgroundColor: '#C8B88A', borderWidth: 1, borderColor: '#A8987A' }, highlight]} />;
  // Box (brood box or super)
  const isSuperColor = id.startsWith('super');
  return (
    <View style={[{ width: HIVE_W, height: BOX_H, backgroundColor: isSuperColor ? '#FFFBE8' : '#F8F8F0', borderWidth: 1.5, borderColor: isSuperColor ? '#C8B840' : '#C4C4BC' }, highlight]}>
      {[0.33, 0.66].map((p, i) => (
        <View key={i} style={{ position: 'absolute', top: BOX_H * p, left: 5, right: 5, height: 1, backgroundColor: isSuperColor ? '#E8D860' : '#D4D4CC' }} />
      ))}
    </View>
  );
}

function HivePiece({ id, pile, boxStack, onPress }: { id: string; pile: string[]; boxStack: string[]; onPress: () => void }) {
  const home = useMemo(() => homePos(id, boxStack), [boxStack.length, boxStack.join(','), id]);
  const pos = useRef(new Animated.ValueXY(home)).current;

  const inPile = pile.includes(id);
  const pieces = allPieces(boxStack);
  const isTopHive = !inPile && pieces.find(p => !pile.includes(p)) === id;
  const isTopPile = inPile && pile[pile.length - 1] === id;
  const isClickable = isTopHive || isTopPile;

  const target = inPile ? pilePos(id, pile) : home;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(pos.x, { toValue: target.x, bounciness: 4, speed: 12, useNativeDriver: true }),
      Animated.spring(pos.y, { toValue: target.y, bounciness: 4, speed: 12, useNativeDriver: true }),
    ]).start();
  }, [target.x, target.y]);

  const isFlipped = inPile && id === 'lid';

  return (
    <Animated.View style={{ position: 'absolute', left: 0, top: 0, transform: pos.getTranslateTransform() }}>
      <View style={isFlipped ? { transform: [{ scaleY: -1 }] } : undefined}>
        <TouchableOpacity onPress={isClickable ? onPress : undefined} activeOpacity={isClickable ? 0.75 : 1}>
          <PieceView id={id} highlighted={!!isClickable} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

// ── Cloud ─────────────────────────────────────────────────────────────────────

function SkyCloud({ y, s, speed, alpha, initX, type, bobAmp, bobPeriod, bobDelay }: CloudDatum) {
  const isMounted = useRef(true);
  const shape  = CLOUD_SHAPES[type % CLOUD_SHAPES.length];
  const cloudW = shape.cw * s;
  const cloudH = shape.ch * s;
  const startX = -cloudW - W * 3;
  const endX   = W + W * 3;
  const totalDur = ((endX - startX) / speed) * 1000;
  const dx = useRef(new Animated.Value(initX)).current;
  const dy = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    isMounted.current = true;

    const firstDur = Math.max(50, (endX - initX) / speed * 1000);
    Animated.timing(dx, { toValue: endX, duration: firstDur, easing: Easing.linear, useNativeDriver: true })
      .start(({ finished }) => {
        if (!finished || !isMounted.current) return;
        dx.setValue(startX);
        Animated.loop(
          Animated.timing(dx, { toValue: endX, duration: totalDur, easing: Easing.linear, useNativeDriver: true })
        ).start();
      });

    const t = setTimeout(() => {
      if (!isMounted.current) return;
      Animated.loop(Animated.sequence([
        Animated.timing(dy, { toValue:  bobAmp, duration: bobPeriod / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(dy, { toValue: -bobAmp, duration: bobPeriod / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])).start();
    }, bobDelay);

    return () => { isMounted.current = false; clearTimeout(t); };
  }, []);

  return (
    <Animated.View style={{
      position: 'absolute', top: y, left: 0,
      width: cloudW, height: cloudH,
      opacity: alpha,
      transform: [{ translateX: dx }, { translateY: dy }],
    }}>
      {shape.ovals.map((o, i) => (
        <View key={i} style={{
          position: 'absolute',
          top: o.t * s, left: o.l * s,
          width: o.w * s, height: o.h * s,
          borderRadius: o.r * s,
          backgroundColor: '#fff',
        }} />
      ))}
    </Animated.View>
  );
}

// ── Population display ────────────────────────────────────────────────────────

function SimClock({ simSpeed }: { simSpeed: number }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceUpdate(n => n + 1), 200);
    return () => clearInterval(id);
  }, []);
  const t = globalSimTimeMs;
  const days = Math.floor(t / DAY_MS);
  const hrs  = Math.floor((t % DAY_MS) / HOUR_MS);
  const mins = Math.floor((t % HOUR_MS) / 60_000);
  const secs = Math.floor((t % 60_000) / 1000);
  const f2 = (n: number) => String(n).padStart(2, '0');
  const paused = globalPauseNow !== null;
  return (
    <Text style={{ color: paused ? '#FF8888' : '#88CCFF', fontSize: 11, marginTop: 3 }}>
      {paused ? '⏸' : '🕐'}{` Day ${days} ${f2(hrs)}:${f2(mins)}:${f2(secs)} (${simSpeed}x${paused ? ' paused' : ''})`}
    </Text>
  );
}

function PopulationDisplay({ total, layCount, foragerOutside, resourceStored, simSpeed }: {
  total: number; layCount: number; foragerOutside: number; resourceStored: number; simSpeed: number;
}) {
  return (
    <View style={{
      position: 'absolute', top: 36, right: 16, zIndex: 200,
      backgroundColor: 'rgba(20,10,0,0.72)',
      paddingHorizontal: 12, paddingVertical: 6,
      borderRadius: 16,
      pointerEvents: 'none' as any,
    }}>
      <Text style={{ color: '#FFBB33', fontSize: 13, fontWeight: '600' }}>
        {'🐝'} {total.toLocaleString()} workers
      </Text>
      <Text style={{ color: '#90EE30', fontSize: 11, marginTop: 2 }}>
        {'🥚'} {layCount} eggs laid this session
      </Text>
      {foragerOutside > 0 && (
        <Text style={{ color: '#FFD700', fontSize: 11, marginTop: 2 }}>
          {'🌸'} {foragerOutside} foraging
        </Text>
      )}
      {resourceStored > 0 && (
        <Text style={{ color: '#FFA500', fontSize: 11, marginTop: 1 }}>
          {'🍯'} {resourceStored} cells stored
        </Text>
      )}
      <SimClock simSpeed={simSpeed} />
    </View>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

type Viewport = { zoom: number; x: number; y: number };

type CellInfoResult =
  | { kind: 'brood'; r: number; c: number; frameKey: string; layTime: number; realAgoMs: number; simAgoMs: number; stage: string; emerged: boolean; realRemMs: number; simRemMs: number; }
  | { kind: 'static'; r: number; c: number; frameKey: string; cellType: string; }
  | { kind: 'bee'; id: number; bornAt: number; isBuilder: boolean; waxUnits: number; foragerPhase?: string; receiverPhase?: string; load?: string | null; activity: string; };

// Worker bee behavioral maturation schedule (Seeley 1985, Winston 1987).
// Each worker progresses through roles as glands develop with age.
function getBeeRole(bornAt: number): string {
  const now   = globalPauseNow ?? Date.now();
  const speed = globalPauseNow !== null ? globalLastActiveSpeed : Math.max(globalSimSpeed, 1);
  const simDays = (now - bornAt) * speed / DAY_MS;
  if (simDays < 3)  return 'Cell Cleaner';   // cleans own cell + neighbors; hypopharyngeal glands maturing
  if (simDays < 12) return 'Nurse Bee';       // feeds larvae with royal jelly & pollen; peak brood-food gland activity
  if (simDays < 18) return 'Wax Builder';     // wax glands peak; builds comb, processes nectar, fans
  if (simDays < 21) return 'Guard';           // guards entrance; alarm pheromone response peaks
  return 'Forager';                            // collects pollen, nectar, water, propolis
}

function fmtDuration(ms: number): string {
  if (ms < 0) return '0s';
  if (ms < 2000) return `${Math.round(ms)}ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 7_200_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 172_800_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function Crosshair() {
  const SIZE = 30, THICK = 2, GAP = 5;
  const bar: any = { position: 'absolute', backgroundColor: 'rgba(255,252,200,0.82)' };
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: W / 2 - SIZE / 2, top: H / 2 - SIZE / 2, width: SIZE, height: SIZE, zIndex: 500 }}>
      <View style={[bar, { left: 0, top: (SIZE - THICK) / 2, width: SIZE / 2 - GAP, height: THICK }]} />
      <View style={[bar, { right: 0, top: (SIZE - THICK) / 2, width: SIZE / 2 - GAP, height: THICK }]} />
      <View style={[bar, { left: (SIZE - THICK) / 2, top: 0, width: THICK, height: SIZE / 2 - GAP }]} />
      <View style={[bar, { left: (SIZE - THICK) / 2, bottom: 0, width: THICK, height: SIZE / 2 - GAP }]} />
    </View>
  );
}


type BeeDebugRow = {
  id: number;
  location: string;
  role: string;
  activity: string;
  age: string;
  carrying: string;
  wax: string;
};

function getBeeActivity(bee: Pick<SimBee, 'foragerPhase' | 'receiverPhase' | 'cellTarget' | 'dwell' | 'isBuilder'>): string {
  if (bee.foragerPhase === 'seeking_exit') return 'Walking to hive entrance';
  if (bee.foragerPhase === 'returning') return 'Returning from forage';
  if (bee.foragerPhase === 'depositing') return 'Depositing forage load';
  if (bee.receiverPhase === 'accepting') return 'Waiting to receive nectar';
  if (bee.receiverPhase === 'processing') return 'Processing nectar';
  if (bee.cellTarget) return 'Working target cell';
  if (bee.isBuilder) return bee.dwell > 0 ? 'Builder resting' : 'Building / patrolling comb';
  return bee.dwell > 0 ? 'Resting on comb' : 'Walking on comb';
}

function getBeeDebugRows(limit = 2000): BeeDebugRow[] {
  const now = globalPauseNow ?? Date.now();
  const speed = globalPauseNow !== null ? globalLastActiveSpeed : Math.max(globalSimSpeed, 1);
  const rows: BeeDebugRow[] = [];
  for (const [frameKey, store] of Object.entries(frameBeeStore)) {
    for (const bee of store.bees) {
      rows.push({
        id: bee.id,
        location: `Frame ${frameKey}`,
        role: getBeeRole(bee.bornAt),
        activity: getBeeActivity(bee),
        age: fmtDuration((now - bee.bornAt) * speed),
        carrying: bee.load ?? '—',
        wax: bee.isBuilder ? `${bee.waxUnits.toFixed(1)}/${WAX_MAX_PER_BEE}` : '—',
      });
    }
  }
  for (const bee of outsideForagers) {
    rows.push({
      id: bee.id,
      location: 'Outside',
      role: getBeeRole(bee.bornAt),
      activity: 'Flying / foraging',
      age: fmtDuration((now - bee.bornAt) * speed),
      carrying: bee.load,
      wax: bee.isBuilder ? `${bee.waxUnits.toFixed(1)}/${WAX_MAX_PER_BEE}` : '—',
    });
  }
  return rows.sort((a, b) => a.id - b.id).slice(0, limit);
}

function BeeDebugWindow({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<BeeDebugRow[]>(() => getBeeDebugRows());
  useEffect(() => {
    const id = setInterval(() => setRows(getBeeDebugRows()), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <View style={{ position: 'absolute', top: 72, right: 16, width: Math.min(560, W - 32), maxHeight: H - 120, zIndex: 950,
      backgroundColor: 'rgba(12,7,1,0.96)', borderWidth: 1, borderColor: '#6B4A12', borderRadius: 10, padding: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text style={{ color: '#FFD36A', fontWeight: '800', fontSize: 14 }}>Bee Debug List ({rows.length}/{countLiveBees()})</Text>
        <TouchableOpacity onPress={onClose}><Text style={{ color: '#FFB0A0', fontWeight: '800' }}>Close</Text></TouchableOpacity>
      </View>
      <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: '#3A2808', paddingBottom: 4 }}>
        {['ID', 'Location', 'Role', 'Doing', 'Age', 'Load', 'Wax'].map((h, i) => (
          <Text key={h} style={{ color: '#B89040', fontSize: 10, fontWeight: '700', flex: [0.45, 0.9, 1.1, 1.6, 0.8, 0.6, 0.7][i] }}>{h}</Text>
        ))}
      </View>
      <ScrollView style={{ maxHeight: H - 190 }} contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator>
        {rows.map(row => (
          <View key={`${row.location}-${row.id}`} style={{ flexDirection: 'row', paddingVertical: 3, borderBottomWidth: 1, borderColor: 'rgba(80,55,15,0.35)' }}>
            {[`#${row.id}`, row.location, row.role, row.activity, row.age, row.carrying, row.wax].map((v, i) => (
              <Text key={i} numberOfLines={1} style={{ color: '#F5E0A0', fontSize: 10, flex: [0.45, 0.9, 1.1, 1.6, 0.8, 0.6, 0.7][i] }}>{v}</Text>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function DevHUD({ info }: { info: CellInfoResult | null }) {
  const fs = IS_MOBILE ? 11 : 9;
  const fsV = IS_MOBILE ? 12 : 10;
  const LABEL: any = { color: '#A89060', fontSize: fs };
  const VALUE: any = { color: '#F5E0A0', fontSize: fsV, fontWeight: '600', marginRight: 12 };
  const now = Date.now();
  return (
    <View style={{
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 900,
      backgroundColor: 'rgba(8,4,0,0.90)',
      borderBottomWidth: 1, borderColor: '#3A2808',
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 10, paddingVertical: 5, minHeight: 30,
    }} pointerEvents="none">
      {!info && (
        <Text style={{ color: '#604830', fontSize: IS_MOBILE ? 11 : 9 }}>
          {IS_MOBILE ? 'Pan crosshair over a pulled frame to inspect' : 'Hover over cells or bees to inspect'}
        </Text>
      )}
      {info && info.kind === 'brood' && (
        <>
          <Text style={LABEL}>Cell [{info.r},{info.c}]{'  '}</Text>
          <Text style={VALUE}>{info.stage.replace('_', ' ')}</Text>
          <Text style={LABEL}>laid </Text>
          <Text style={VALUE}>{fmtDuration(info.realAgoMs)} real / {fmtDuration(info.simAgoMs)} sim ago</Text>
          {!info.emerged && <>
            <Text style={LABEL}>emerges in </Text>
            <Text style={VALUE}>{fmtDuration(info.realRemMs)} real / {fmtDuration(info.simRemMs)} sim</Text>
          </>}
          {info.emerged && <Text style={{ color: '#90EE30', fontSize: 9 }}>emerged, awaiting cleanup</Text>}
        </>
      )}
      {info && info.kind === 'static' && (
        <>
          <Text style={LABEL}>Cell [{(info as any).r},{(info as any).c}]{'  '}</Text>
          <Text style={VALUE}>{info.cellType.replace('_', ' ')}</Text>
          <Text style={{ color: '#806040', fontSize: 9 }}>fixed cell content</Text>
        </>
      )}
      {info && info.kind === 'bee' && (
        <>
          <Text style={LABEL}>Bee </Text>
          <Text style={VALUE}>#{info.id}</Text>
          <Text style={LABEL}>role </Text>
          <Text style={VALUE}>{getBeeRole(info.bornAt)}</Text>
          <Text style={LABEL}>doing </Text>
          <Text style={VALUE}>{info.activity}</Text>
          <Text style={LABEL}>sim age </Text>
          <Text style={VALUE}>{
            (() => {
              const spd = globalPauseNow !== null ? globalLastActiveSpeed : Math.max(globalSimSpeed, 1);
              const effNow = globalPauseNow ?? now;
              const simMs = (effNow - info.bornAt) * spd;
              return fmtDuration(simMs);
            })()
          }</Text>
          {info.isBuilder && <>
            <Text style={LABEL}>wax </Text>
            <Text style={VALUE}>{info.waxUnits.toFixed(1)}/{WAX_MAX_PER_BEE}</Text>
          </>}
          {info.foragerPhase && <>
            <Text style={LABEL}>state </Text>
            <Text style={VALUE}>{info.foragerPhase.replace('_', ' ')}</Text>
          </>}
          {info.load && <>
            <Text style={LABEL}>carrying </Text>
            <Text style={{ color: info.load === 'pollen' ? '#E8A000' : '#FDFAD8', fontSize: 10, fontWeight: '600', marginRight: 12 }}>{info.load}</Text>
          </>}
        </>
      )}
    </View>
  );
}

const SPEED_STEPS = [0, 1, 10, 100, 1000, 10000];

function SpeedControl({ speed, onSelect }: { speed: number; onSelect: (s: number) => void }) {
  return (
    <View style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 300, flexDirection: 'row', gap: 4 }}>
      {SPEED_STEPS.map(s => {
        const active = speed === s;
        return (
          <TouchableOpacity
            key={s}
            onPress={() => onSelect(s)}
            style={{
              backgroundColor: active ? '#F0C050' : 'rgba(20,10,0,0.72)',
              paddingHorizontal: 8, paddingVertical: 5, borderRadius: 7,
              borderWidth: active ? 0 : 1, borderColor: '#F0C05044',
            }}
          >
            <Text style={{ color: active ? '#1A0800' : '#F0C050', fontSize: 11, fontWeight: '700' }}>
              {s === 0 ? '⏸' : `${s}×`}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function MobileControls({ speed, onSelect, onBoost, onKill }: {
  speed: number; onSelect: (s: number) => void; onBoost: () => void; onKill: () => void;
}) {
  const [open, setOpen] = useState(false);
  const BTN: any = { backgroundColor: 'rgba(14,7,0,0.88)', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11, borderWidth: 1, borderColor: '#F0C05033' };
  const LABEL: any = { fontSize: 15, fontWeight: '700' };
  return (
    <View style={{ position: 'absolute', bottom: 28, right: 16, zIndex: 400, alignItems: 'flex-end' }}>
      {open && (
        <View style={{ marginBottom: 10, alignItems: 'flex-end', gap: 10 }}>
          {/* Population buttons */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={() => { onBoost(); }} style={[BTN, { borderColor: '#F0C05066' }]}>
              <Text style={[LABEL, { color: '#F0C050' }]}>+1k bees</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { onKill(); }} style={[BTN, { borderColor: '#FF606066' }]}>
              <Text style={[LABEL, { color: '#FF6060' }]}>−1k bees</Text>
            </TouchableOpacity>
          </View>
          {/* Speed row */}
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {SPEED_STEPS.map(s => {
              const active = speed === s;
              return (
                <TouchableOpacity
                  key={s}
                  onPress={() => { onSelect(s); setOpen(false); }}
                  style={{
                    backgroundColor: active ? '#F0C050' : 'rgba(14,7,0,0.88)',
                    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 9,
                    borderWidth: active ? 0 : 1, borderColor: '#F0C05044',
                  }}
                >
                  <Text style={{ color: active ? '#1A0800' : '#F0C050', fontSize: 15, fontWeight: '700' }}>
                    {s === 0 ? '⏸' : `${s}×`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}
      {/* Toggle FAB — shows current speed */}
      <TouchableOpacity
        onPress={() => setOpen(o => !o)}
        style={{
          backgroundColor: open ? '#F0C050' : 'rgba(14,7,0,0.92)',
          paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12,
          borderWidth: open ? 0 : 1, borderColor: '#F0C05066',
          flexDirection: 'row', alignItems: 'center', gap: 8,
        }}
      >
        <Text style={{ color: open ? '#1A0800' : '#F0C050', fontSize: 15, fontWeight: '700' }}>
          {speed === 0 ? '⏸' : `${speed}×`}
        </Text>
        <Text style={{ color: open ? '#1A0800' : '#F0C05099', fontSize: 13 }}>{open ? '✕' : '⚙'}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function App() {
  const [pile, setPile]               = useState<string[]>([]);
  const [settledPile, setSettledPile] = useState<string[]>([]);
  const [pulledFrame, setPulledFrame] = useState<PulledFrame>(null);

  const {
    queenRef, queenFrameKey, totalAdultBees, foragerStats, outsideForagersSnap, layCount, getCellOverrides,
    boxStack, boxFrames, drawnCells,
    simSpeed, setSimSpeed, boostPopulation, killPopulation,
    getCellInfo,
    addBox, removeBox, addFrame, removeFrame,
  } = useHiveSimulation();

  const [devHoverInfo, setDevHoverInfo] = useState<CellInfoResult | null>(null);
  const [sceneNow, setSceneNow] = useState(Date.now());
  const [showBeeDebug, setShowBeeDebug] = useState(false);

  const [vp, setVpState] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
  // On mobile, screen center in world coords is the crosshair inspect point
  const crosshairWorld = IS_MOBILE
    ? { x: W / 2 - vp.x / vp.zoom, y: H / 2 - vp.y / vp.zoom }
    : null;
  const vpRef   = useRef<Viewport>({ zoom: 1, x: 0, y: 0 });
  const rootRef = useRef<any>(null);
  const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, lastX: 0, lastY: 0 });
  const pinchRef = useRef({ active: false, lastDist: 0, midX: 0, midY: 0 });

  const setVp = (v: Viewport) => { vpRef.current = v; setVpState(v); };
  const zoomAt = (factor: number, mx: number, my: number) => {
    const v = vpRef.current;
    const nz = Math.max(0.2, Math.min(150, v.zoom * factor));
    const r  = nz / v.zoom;
    setVp({ zoom: nz, x: mx * (1 - r) + v.x * r, y: my * (1 - r) + v.y * r });
  };

  useEffect(() => {
    const id = setInterval(() => setSceneNow(Date.now()), BEE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el?.addEventListener) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left - W / 2, e.clientY - rect.top - H / 2);
    };
    // Prevent browser-native pinch zoom and scroll on touch devices
    const preventTouch = (e: TouchEvent) => e.preventDefault();
    el.addEventListener('wheel', handler, { passive: false });
    el.addEventListener('touchmove', preventTouch, { passive: false });
    return () => {
      el.removeEventListener('wheel', handler);
      el.removeEventListener('touchmove', preventTouch);
    };
  }, []);

  const onMouseDown  = (e: any) => { dragRef.current = { active: true, moved: false, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY }; };
  const onMouseMove  = (e: any) => {
    const d = dragRef.current;
    if (!d.active) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    d.moved = true;
    const v = vpRef.current;
    setVp({ ...v, x: v.x + e.clientX - d.lastX, y: v.y + e.clientY - d.lastY });
    d.lastX = e.clientX; d.lastY = e.clientY;
  };
  const onMouseUp    = () => { dragRef.current.active = false; };
  const onTouchStart = (e: any) => {
    if (e.touches.length === 2) {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const rect = rootRef.current?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
      pinchRef.current = { active: true, lastDist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY), midX: (t1.clientX + t2.clientX) / 2 - rect.left - W / 2, midY: (t1.clientY + t2.clientY) / 2 - rect.top - H / 2 };
      dragRef.current.active = false;
    } else {
      const t = e.touches[0];
      dragRef.current = { active: true, moved: false, startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastY: t.clientY };
    }
  };
  const onTouchMove  = (e: any) => {
    if (e.touches.length === 2 && pinchRef.current.active) {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      if (pinchRef.current.lastDist > 0) zoomAt(dist / pinchRef.current.lastDist, pinchRef.current.midX, pinchRef.current.midY);
      pinchRef.current.lastDist = dist;
    } else if (e.touches.length === 1 && dragRef.current.active) {
      const d = dragRef.current, t = e.touches[0];
      if (!d.moved && Math.hypot(t.clientX - d.startX, t.clientY - d.startY) < 4) return;
      d.moved = true;
      const v = vpRef.current;
      setVp({ ...v, x: v.x + t.clientX - d.lastX, y: v.y + t.clientY - d.lastY });
      d.lastX = t.clientX; d.lastY = t.clientY;
    }
  };
  const onTouchEnd    = () => { dragRef.current.active = false; pinchRef.current.active = false; };
  const onDoubleClick = () => setVp({ zoom: 1, x: 0, y: 0 });

  useEffect(() => {
    const t = setTimeout(() => setSettledPile(pile), 700);
    return () => clearTimeout(t);
  }, [pile]);

  // First box in boxStack that isn't in the pile (once lid+inner are removed)
  const exposedBox = useMemo<string | null>(() => {
    if (!settledPile.includes('lid') || !settledPile.includes('inner')) return null;
    return boxStack.find(b => !settledPile.includes(b)) ?? null;
  }, [settledPile, boxStack]);

  useEffect(() => {
    if (pulledFrame && exposedBox !== pulledFrame.box) setPulledFrame(null);
  }, [exposedBox]);

  const handlePress = (id: string) => {
    setPile(prev => {
      const inPile = prev.includes(id);
      if (inPile) {
        if (prev[prev.length - 1] !== id) return prev;
        return prev.slice(0, -1);
      } else {
        if (allPieces(boxStack).find(p => !prev.includes(p)) !== id) return prev;
        return [...prev, id];
      }
    });
  };

  const handlePullFrame = (box: string, idx: number) =>
    setPulledFrame(prev => ({ box, idx, instant: prev !== null }));

  const webProps = {
    onMouseDown, onMouseMove, onMouseUp, onMouseLeave: onMouseUp,
    onTouchStart, onTouchMove, onTouchEnd, onDoubleClick,
  } as any;

  const pulledFrameKey = pulledFrame ? (boxFrames[pulledFrame.box]?.[pulledFrame.idx] ?? null) : null;
  const showQueen = pulledFrameKey !== null && queenFrameKey === pulledFrameKey;

  const bbLeft  = W / 2 - (HIVE_W + 14) / 2;
  const bbTop   = GROUND_Y - STAND_H - BB_H;
  const standTop = GROUND_Y - STAND_H;
  return (
    <View ref={rootRef} style={[styles.root, { overflow: 'hidden', cursor: IS_MOBILE ? 'default' : 'grab' } as any]} {...webProps}>
      <DevHUD info={devHoverInfo} />
      {IS_MOBILE && <Crosshair />}
      <PopulationDisplay total={totalAdultBees} layCount={layCount} foragerOutside={foragerStats.outside} resourceStored={foragerStats.stored} simSpeed={simSpeed} />
      <TouchableOpacity
        onPress={() => setShowBeeDebug(v => !v)}
        style={{ position: 'absolute', top: 92, right: 16, zIndex: 300, backgroundColor: 'rgba(20,10,0,0.86)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#6B4A12' }}
      >
        <Text style={{ color: '#FFD36A', fontSize: 11, fontWeight: '800' }}>{showBeeDebug ? 'Hide bee list' : 'Show bee list'}</Text>
      </TouchableOpacity>
      {showBeeDebug && <BeeDebugWindow onClose={() => setShowBeeDebug(false)} />}
      {IS_MOBILE
        ? <MobileControls speed={simSpeed} onSelect={setSimSpeed} onBoost={boostPopulation} onKill={killPopulation} />
        : <>
            <SpeedControl speed={simSpeed} onSelect={setSimSpeed} />
            <TouchableOpacity
              onPress={boostPopulation}
              style={{ position: 'absolute', bottom: 16, right: 16, zIndex: 300, backgroundColor: 'rgba(20,10,0,0.82)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}
            >
              <Text style={{ color: '#F0C050', fontSize: 11, fontWeight: '700' }}>+1k bees</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={killPopulation}
              style={{ position: 'absolute', bottom: 16, right: 88, zIndex: 300, backgroundColor: 'rgba(20,10,0,0.82)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}
            >
              <Text style={{ color: '#FF6060', fontSize: 11, fontWeight: '700' }}>-1k bees</Text>
            </TouchableOpacity>
          </>
      }

      {/* Box management buttons — shown when hive is open */}
      {exposedBox && (
        <View style={{ position: 'absolute', top: 36, left: 16, zIndex: 200, flexDirection: 'row', gap: 8 }}>
          {boxStack.length < 5 && (
            <TouchableOpacity
              onPress={addBox}
              style={{ backgroundColor: 'rgba(20,10,0,0.82)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}
            >
              <Text style={{ color: '#F0C050', fontSize: 11, fontWeight: '700' }}>+ Add Box</Text>
            </TouchableOpacity>
          )}
          {boxStack.length > 1 && (
            <TouchableOpacity
              onPress={() => removeBox(exposedBox)}
              style={{ backgroundColor: 'rgba(40,8,8,0.88)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}
            >
              <Text style={{ color: '#FF8080', fontSize: 11, fontWeight: '700' }}>
                {`- Remove ${exposedBox.startsWith('super') ? `Super ${exposedBox.slice(5)}` : exposedBox === 'box1' ? 'Box 1' : 'Box 2'}`}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <View style={{
        position: 'absolute', left: 0, top: 0, width: W, height: H,
        transform: [{ translateX: vp.x }, { translateY: vp.y }, { scale: vp.zoom }],
      }}>
        <StatusBar style="dark" />
        <View style={{ position: 'absolute', top: -H * 3, left: -W * 3, width: W * 7, height: H * 3 + GROUND_Y, backgroundColor: '#85C7E8' }} />
        <View style={{ position: 'absolute', top: -H * 3, left: -W * 3, width: W * 7, height: H * 3 + H * 0.4, backgroundColor: 'rgba(200,235,255,0.28)' }} />
        <View style={{ position: 'absolute', top: H * 0.07, right: W * 0.10, width: 54, height: 54, borderRadius: 27, backgroundColor: '#FFE44D', shadowColor: '#FFE44D', shadowRadius: 14, shadowOpacity: 0.55, elevation: 4 }} />
        {CLOUD_DATA.map((c, i) => <SkyCloud key={i} {...c} />)}
        <View style={{ position: 'absolute', top: GROUND_Y, left: -W * 3, width: W * 7, height: H * 4, backgroundColor: '#5C9E3A' }} />
        <View style={{ position: 'absolute', top: GROUND_Y, left: -W * 3, width: W * 7, height: 7, backgroundColor: '#4A8A2B' }} />
        <View style={{ position: 'absolute', top: bbTop, left: bbLeft, width: HIVE_W + 14, height: BB_H, backgroundColor: '#8B7355', alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 2 }}>
          <View style={{ width: ENTRANCE_W, height: ENTRANCE_H, backgroundColor: '#111', borderRadius: 1 }} />
        </View>
        <View style={{ position: 'absolute', top: standTop, left: bbLeft, width: HIVE_W + 14, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 10 }}>
          <View style={{ width: 14, height: STAND_H, backgroundColor: '#6B5433' }} />
          <View style={{ width: 14, height: STAND_H, backgroundColor: '#6B5433' }} />
        </View>
        {allPieces(boxStack).map(id => (
          <HivePiece key={id} id={id} pile={pile} boxStack={boxStack} onPress={() => handlePress(id)} />
        ))}
        {exposedBox && (
          <FrameTops
            box={exposedBox}
            frames={boxFrames[exposedBox] ?? []}
            pulledIdx={pulledFrame?.box === exposedBox ? pulledFrame.idx : null}
            onPull={(idx) => handlePullFrame(exposedBox, idx)}
            onAddFrame={(slotIdx) => addFrame(exposedBox, slotIdx)}
            boxStack={boxStack}
            drawnCells={drawnCells}
          />
        )}
        {pulledFrame && pulledFrameKey !== null && (
          <PulledFrameView
            key={pulledFrame.box + ':' + pulledFrame.idx + ':' + pulledFrameKey}
            box={pulledFrame.box}
            idx={pulledFrame.idx}
            frameKey={pulledFrameKey}
            instant={pulledFrame.instant}
            onReturn={() => setPulledFrame(null)}
            boxStack={boxStack}
            boxFrames={boxFrames}
            overrides={getCellOverrides(pulledFrameKey)}
            showQueen={showQueen}
            queenRef={queenRef}
            onRemove={() => removeFrame(pulledFrame.box, pulledFrame.idx)}
            drawnCells={drawnCells}
            getCellInfo={getCellInfo}
            onHoverInfo={setDevHoverInfo}
            crosshairWorld={crosshairWorld}
          />
        )}
        <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
          {outsideForagersSnap.map(forager => <ForagerBee key={forager.id} forager={forager} now={sceneNow} />)}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
