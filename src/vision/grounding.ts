export interface GroundTarget {
  text?: string;
  type?: string;
  bbox: [number, number, number, number];
  confidence: number;
  source: 'uia' | 'ocr' | 'vision';
  timestamp: number;
  screenHash: string;
}

/** Select only targets grounded in the exact current frame. */
export function chooseGroundTarget(
  targets: GroundTarget[],
  query: string,
  maxAgeMs = 10_000,
  screenHash?: string,
  minConfidence = 0.45,
  point?: [number, number],
): GroundTarget | null {
  const now = Date.now();
  const q = query.trim().toLowerCase();
  return targets
    .filter((t) => now - t.timestamp >= 0 && now - t.timestamp <= maxAgeMs)
    .filter((t) => t.confidence >= minConfidence)
    .filter((t) => !screenHash || t.screenHash === screenHash)
    .filter((t) => !q || (t.text ?? '').toLowerCase().includes(q) || (t.type ?? '').toLowerCase().includes(q))
    .filter((t) => {
      if (!point) return true;
      const [x, y] = point; const [bx, by, bw, bh] = t.bbox;
      return x >= bx && y >= by && x <= bx + bw && y <= by + bh;
    })
    .sort((a, b) => {
      const am = q && ((a.text ?? '').toLowerCase().includes(q) || (a.type ?? '').toLowerCase().includes(q)) ? 1 : 0;
      const bm = q && ((b.text ?? '').toLowerCase().includes(q) || (b.type ?? '').toLowerCase().includes(q)) ? 1 : 0;
      return bm - am || b.confidence - a.confidence || b.timestamp - a.timestamp;
    })[0] ?? null;
}
