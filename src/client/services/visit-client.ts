import type { OwnedCat, SeatId } from '@/../shared/state';

/**
 * Wrapper for the visitor-splash data endpoint. Single call returns
 * the owner's stage configuration; chart + leaderboard are fetched
 * separately so the client can fire all three in parallel.
 */

export interface VisitData {
  postId: string;
  ownerUsername: string;
  /** True when the requester is the post owner — visit-mode UI is
   *  suppressed in that case so an owner clicking their own post URL
   *  doesn't see a "play your own show" splash. */
  isOwner: boolean;
  stage: {
    seatedCats: Record<SeatId, string | null>;
    activeBackground: string;
    ownedCats: OwnedCat[];
    equippedCosmetics: Record<string, Record<string, string>>;
    // FLAT cosInstanceId → typeId, matching PlayerState shape. The
    // previous nested type was the source of the cosmetics-not-rendering
    // bug — kept the type honest to prevent regressions.
    equippedCosmeticTypes: Record<string, string>;
  };
}

export async function fetchVisit(postId: string): Promise<VisitData | null> {
  try {
    const res = await fetch(`/api/visit?postId=${encodeURIComponent(postId)}`);
    if (!res.ok) {
      console.warn('[fetchVisit] non-OK response:', res.status);
      return null;
    }
    return (await res.json()) as VisitData;
  } catch (err) {
    console.warn('[fetchVisit] threw:', err);
    return null;
  }
}
