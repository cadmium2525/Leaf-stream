/** 端末内に保存する設定・下書き（localStorage）。サーバーの値ではない */
import { getSpecies, isSpeciesId, normalizePolygon, validateLeaf, type Polygon, type SpeciesId } from '../../packages/sim-core/src/index.ts';

export type Quality = 'auto' | 'high' | 'standard' | 'eco';

export interface Settings {
  quality: Quality;
  sound: boolean;
  volume: number;
}

export interface LeafDraft {
  polygon: Polygon;
  cuts: number;
  species: SpeciesId;
}

const KEY_SETTINGS = 'leafstream.settings.v1';
const KEY_DRAFT = 'leafstream.draft.v1';
/** どこまでもモード用の葉はレース用とは別に保存する */
const KEY_DRAFT_ENDLESS = 'leafstream.draft.endless.v1';
const KEY_ENDLESS = 'leafstream.endless.v1';

/** 葉っぱの用途：レース用／どこまでもモード用 */
export type DraftKind = 'race' | 'endless';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 容量不足などは無視 */
  }
}

const listeners = new Set<() => void>();

export const settings: Settings = load<Settings>(KEY_SETTINGS, { quality: 'auto', sound: true, volume: 0.6 });

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  save(KEY_SETTINGS, settings);
  for (const l of listeners) l();
}

export function onSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function loadDraft(kind: DraftKind = 'race'): LeafDraft {
  const d = load<Partial<LeafDraft>>(kind === 'endless' ? KEY_DRAFT_ENDLESS : KEY_DRAFT, {});
  const species = isSpeciesId(d.species) ? d.species : 'sakura';
  const fresh = { polygon: getSpecies(species).polygon, cuts: 0, species };
  if (!d.polygon) return fresh;
  // 壊れた下書きは元の形に戻す
  const p = normalizePolygon(d.polygon);
  if (p.length < 3 || !validateLeaf(p).errors.every((e) => e === 'too_thin' || e === 'too_small')) return fresh;
  return { polygon: p, cuts: Math.max(0, Math.min(99, (d.cuts ?? 0) | 0)), species };
}

export function saveDraft(d: LeafDraft, kind: DraftKind = 'race'): void {
  save(kind === 'endless' ? KEY_DRAFT_ENDLESS : KEY_DRAFT, d);
}

/** どこまでもモードの端末内の記録：流す位置と、週ごとの自己ベスト（cm） */
export interface EndlessLocal {
  lane: number;
  week: string;
  best: number;
}

export function loadEndlessLocal(): EndlessLocal {
  return load<EndlessLocal>(KEY_ENDLESS, { lane: 0, week: '', best: 0 });
}

export function saveEndlessLocal(v: EndlessLocal): void {
  save(KEY_ENDLESS, v);
}

export function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.matchMedia('(pointer: coarse)').matches;
}
