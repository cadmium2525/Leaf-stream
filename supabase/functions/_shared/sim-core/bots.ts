// 自動生成：packages/sim-core/src からコピー（npm run sync:sim）。直接編集しないこと。
/** 練習用の相手（ランク戦の対象外） */
import { defaultLeaf, normalizePolygon, splitPolygonByPath, area, type Polygon, type Vec2 } from './geometry.ts';

export interface BotLeaf {
  id: string;
  name: string;
  polygon: Polygon;
}

function cutKeepLargest(p: Polygon, path: Vec2[]): Polygon {
  const pieces = splitPolygonByPath(p, path);
  let best = pieces[0];
  for (const q of pieces) if (area(q) > area(best)) best = q;
  return normalizePolygon(best);
}

function cuts(paths: Vec2[][]): Polygon {
  let p = defaultLeaf();
  for (const path of paths) p = cutKeepLargest(p, path);
  return p;
}

export const BOT_LEAVES: BotLeaf[] = [
  { id: 'bot-plain', name: 'そのままの葉', polygon: defaultLeaf() },
  { id: 'bot-slim', name: '細身の笹舟', polygon: cuts([[[1.4, -6], [1.4, 6]], [[-1.4, 6], [-1.4, -6]]]) },
  { id: 'bot-diamond', name: 'ひし形', polygon: cuts([[[-0.8, 5.4], [3.2, -0.6]], [[3.2, 0.6], [-0.8, -5.4]], [[0.8, -5.4], [-3.2, 0.6]], [[-3.2, -0.6], [0.8, 5.4]]]) },
  { id: 'bot-short', name: 'ずんぐり', polygon: cuts([[[-4, 2.4], [4, 2.4]], [[4, -2.6], [-4, -2.6]]]) },
  { id: 'bot-arrow', name: 'やじり', polygon: cuts([[[-3.4, 0.5], [-0.3, -5]], [[0.3, -5], [3.4, 0.5]]]) },
  { id: 'bot-notch', name: '切れ込み', polygon: cuts([[[-4, 2.2], [-0.9, 0.6], [-4, -0.6]], [[4, -0.4], [1, -1.6], [4, -2.8]]]) },
];
