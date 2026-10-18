/**
 * 葉っぱの種類（最初に選べる元の形）。ここから切って自分の葉を作る。
 * 座標はリテラルで持ち、どの環境でも同じ形になるようにする（読み込み時に正規化）。
 */
import { defaultLeaf, normalizePolygon, type Polygon, type Vec2 } from './geometry.ts';

export type SpeciesId = 'sakura' | 'yanagi' | 'nasturtium' | 'momiji';

export interface Species {
  id: SpeciesId;
  name: string;
  /** 形の特徴（エディタに表示） */
  description: string;
  polygon: Polygon;
}

const YANAGI: Vec2[] = [[0, -5.3], [0.2, -4.64], [0.39, -3.97], [0.56, -3.31], [0.7, -2.65], [0.81, -1.99], [0.88, -1.33], [0.92, -0.66], [0.93, 0], [0.89, 0.66], [0.83, 1.33], [0.73, 1.99], [0.61, 2.65], [0.47, 3.31], [0.32, 3.98], [0, 5.3], [-0.32, 3.98], [-0.47, 3.31], [-0.61, 2.65], [-0.73, 1.99], [-0.83, 1.33], [-0.89, 0.66], [-0.93, 0], [-0.92, -0.66], [-0.88, -1.33], [-0.81, -1.99], [-0.7, -2.65], [-0.56, -3.31], [-0.39, -3.97], [-0.2, -4.64]];
const NASTURTIUM: Vec2[] = [[3.1, 0], [3.17, 0.56], [2.91, 1.06], [2.58, 1.49], [2.37, 1.99], [2.07, 2.47], [1.55, 2.68], [1.02, 2.8], [0.54, 3.05], [0, 3.22], [-0.54, 3.05], [-1.02, 2.8], [-1.55, 2.68], [-2.07, 2.47], [-2.37, 1.99], [-2.58, 1.49], [-2.91, 1.06], [-3.17, 0.56], [-3.1, 0], [-2.93, -0.52], [-2.91, -1.06], [-2.79, -1.61], [-2.37, -1.99], [-1.92, -2.28], [-1.55, -2.68], [-1.1, -3.03], [-0.54, -3.05], [0, -2.98], [0.54, -3.05], [1.1, -3.03], [1.55, -2.68], [1.92, -2.28], [2.37, -1.99], [2.79, -1.61], [2.91, -1.06], [2.93, -0.52]];
const MOMIJI: Vec2[] = [[0, 3.27], [-0.76, 1.36], [-2.48, 1.78], [-1.71, 0.11], [-2.6, -0.92], [-1.37, -1.45], [-0.98, -2.44], [0, -2.14], [0.98, -2.44], [1.37, -1.45], [2.6, -0.92], [1.71, 0.11], [2.48, 1.78], [0.76, 1.36]];

export const SPECIES: Species[] = [
  { id: 'sakura', name: 'サクラ', description: 'くせのない卵形。どのコースでもそこそこ。', polygon: defaultLeaf() },
  { id: 'yanagi', name: 'ヤナギ', description: '細長く軽い。追い風の田んぼで速いが、向かい風に弱い。', polygon: normalizePolygon(YANAGI) },
  { id: 'nasturtium', name: 'ナスタチウム', description: '丸く大きい。向かい風や段差に強いが、追い風では重い。', polygon: normalizePolygon(NASTURTIUM) },
  { id: 'momiji', name: 'モミジ', description: '手のひら形で縁が長い。風をはらみ、田んぼと山里が得意。', polygon: normalizePolygon(MOMIJI) },
];

export const SPECIES_IDS: SpeciesId[] = SPECIES.map((s) => s.id);

export function getSpecies(id: string | null | undefined): Species {
  return SPECIES.find((s) => s.id === id) ?? SPECIES[0];
}

export function isSpeciesId(id: unknown): id is SpeciesId {
  return typeof id === 'string' && (SPECIES_IDS as string[]).includes(id);
}
