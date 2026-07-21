export interface BatchMarker {
  reviewSetId: string;
  batchIndex: number;
  batchCount: number;
  digest: string;
}

const MARKER_RE =
  /<!--\s*pr-review-swarm:review_set_id=([^;]+);batch=(\d+)\/(\d+);digest=(\S+?)\s*-->/;

export function encodeBatchMarker(marker: BatchMarker): string {
  return `<!-- pr-review-swarm:review_set_id=${marker.reviewSetId};batch=${marker.batchIndex}/${marker.batchCount};digest=${marker.digest} -->`;
}

export function decodeBatchMarker(body: string | null | undefined): BatchMarker | undefined {
  if (!body) return undefined;
  const match = MARKER_RE.exec(body);
  if (!match) return undefined;

  const [, reviewSetId, batchIndexRaw, batchCountRaw, digest] = match;
  const batchIndex = Number(batchIndexRaw);
  const batchCount = Number(batchCountRaw);
  if (!reviewSetId || !digest || Number.isNaN(batchIndex) || Number.isNaN(batchCount)) {
    return undefined;
  }

  return { reviewSetId, batchIndex, batchCount, digest };
}

export function isOwnedByThisBot(review: { body: string | null }): boolean {
  return decodeBatchMarker(review.body) !== undefined;
}
