import { context, requestExpandedMode } from '@devvit/web/client';

/**
 * Inline feed-preview splash for Meowcert posts. Mirrors the VisitPost
 * in-game scene's layout:
 *   - top band: captured cat-stage screenshot from the post owner's
 *               last visit to Decorate (or branded fallback if missing)
 *   - middle:   author / song / play count / top 3 leaderboard / your best
 *   - bottom:   TAP TO PLAY button → requestExpandedMode('game') →
 *               fullscreen modal loads game.html → Phaser → VisitPost
 *
 * Per-post fetch on load (/api/preview-image + /api/social/leaderboard
 * fired in parallel). After the first load, the leaderboard re-polls
 * every LB_POLL_MS so the splash stays honest as other visitors play;
 * the "Updated Xs ago" stamp ticks every second so the player can SEE
 * the data is live (Tim: "will the leaderboard even update in real
 * time because if it doesnt update then it defeats the whole purpose").
 */

const LB_POLL_MS = 10_000;

const splashBg = document.getElementById('splash-bg') as HTMLDivElement | null;
const stage = document.getElementById('stage') as HTMLDivElement | null;
const marqueeFallback = document.getElementById('marquee-fallback') as HTMLDivElement | null;
const infoPanel = document.getElementById('info') as HTMLDivElement | null;
const authorEl = document.getElementById('author') as HTMLDivElement | null;
const songEl = document.getElementById('song') as HTMLDivElement | null;
const lbEls = [
  document.getElementById('lb-1') as HTMLLIElement | null,
  document.getElementById('lb-2') as HTMLLIElement | null,
  document.getElementById('lb-3') as HTMLLIElement | null,
];
const yourBestEl = document.getElementById('your-best') as HTMLDivElement | null;
const updatedEl = document.getElementById('lb-updated') as HTMLDivElement | null;
const playsBannerEl = document.getElementById('plays-banner') as HTMLDivElement | null;
const playsBannerCountEl = document.getElementById('plays-banner-count') as HTMLSpanElement | null;
const playsBannerLabelEl = document.getElementById('plays-banner-label') as HTMLSpanElement | null;
const startButton = document.getElementById('start-button') as HTMLButtonElement | null;

startButton?.addEventListener('click', (e) => {
  try { requestExpandedMode(e, 'game'); }
  catch (err) { console.warn('[splash] requestExpandedMode threw:', err); }
});

const postId = context.postId;

interface VisitData {
  ownerUsername?: string;
  previewImage?: string | null;
  /** Post's stage background id (e.g. 'saloon', 'cathedral') — splash
   *  applies the matching theme PNG as a full-page background layer
   *  so the inline preview reads like the in-game stage. */
  activeBackground?: string | null;
  song?: { title?: string; vibe?: string; difficulty?: string };
  /** True when the post's chart has any taps / holds / slides /
   *  slide-returns. False = default seeded post or an accidental empty
   *  publish; splash swaps to the loading-screen composition (logo +
   *  PLAY NOW, no info panel, no plays banner). */
  hasChart?: boolean;
}

interface LeaderboardData {
  top?: Array<{ visitor: string; score: number; accuracy?: number; playedAt?: number }>;
  yourRank?: number | null;
  yourScore?: number | null;
  /** Total play submissions for this post (server-incremented on
   *  every play, not derived from leaderboard size which is PB-only). */
  totalPlays?: number;
}

/** Wall-clock of the last successful leaderboard load — used to render
 *  the "Updated Xs ago" stamp. null until the first poll lands. */
let lastUpdatedAt: number | null = null;

/** Populated by the preview fetch. null = fetch hasn't landed / failed,
 *  false = post has no chart notes (seeded default or empty publish) so
 *  splash is in the empty-chart mode and renderLeaderboard should skip
 *  unhiding the plays banner. true = normal splash. */
let hasChart: boolean | null = null;

if (postId) {
  // Visit data only needs to fetch once — owner / song / preview image
  // don't change after publish. Leaderboard re-polls on a timer.
  void fetch(`/api/preview-image?postId=${encodeURIComponent(postId)}`)
    .then((r) => {
      if (r.ok) return r.json();
      // 404 = no owner mapping (default seeded post or otherwise
      // unmapped). Same visual treatment as an empty published chart —
      // no author to render, no song, no leaderboard-worthy stakes.
      if (r.status === 404) applyEmptyChartMode();
      return null;
    })
    .then((visit) => { if (visit) renderVisit(visit as VisitData); })
    .catch((err) => { console.warn('[splash] preview-image fetch failed:', err); });

  void loadLeaderboard();
  setInterval(() => { void loadLeaderboard(); }, LB_POLL_MS);
  // Tick the "Updated Xs ago" stamp every second so the player can see
  // the freshness of the number, not just the poll cadence.
  setInterval(renderUpdatedStamp, 1000);
}

/** Swap the splash to the loading-screen composition — hide the
 *  plays banner + info panel (via body class in CSS), swap marquee
 *  for the V21 logo. Idempotent: safe to call from both the 404
 *  branch and the hasChart=false branch of renderVisit. */
function applyEmptyChartMode(): void {
  hasChart = false;
  document.body.classList.add('empty-chart');
  // Belt-and-suspenders — hide the plays banner explicitly in case
  // renderLeaderboard already flipped it visible before the empty-
  // chart signal landed.
  if (playsBannerEl) playsBannerEl.style.display = 'none';
  if (infoPanel) infoPanel.style.display = 'none';
}

async function loadLeaderboard(): Promise<void> {
  if (!postId) return;
  try {
    const r = await fetch(`/api/social/leaderboard?postId=${encodeURIComponent(postId)}`);
    if (!r.ok) return;
    const lb = (await r.json()) as LeaderboardData;
    renderLeaderboard(lb);
    lastUpdatedAt = Date.now();
    renderUpdatedStamp();
  } catch (err) {
    console.warn('[splash] leaderboard fetch failed:', err);
  }
}

function renderVisit(d: VisitData): void {
  // Empty-chart posts (default seed + accidental empty publish) drop
  // straight into the loading-screen composition and skip the rest of
  // the visit rendering — bg / preview / author / song are all noise
  // when there's nothing to play.
  if (d.hasChart === false) {
    applyEmptyChartMode();
    return;
  }
  // Full-page bg layer — Preloader.ts loads theme bgs from
  // /assets/themes/<id>-bg.png; we use the same path here so splash
  // and in-game show the same source asset for any given post.
  if (d.activeBackground && splashBg) {
    splashBg.style.backgroundImage = `url(/assets/themes/${d.activeBackground}-bg.png)`;
    splashBg.style.display = '';
  }
  if (d.previewImage && stage && marqueeFallback) {
    stage.style.backgroundImage = `url(${d.previewImage})`;
    marqueeFallback.style.display = 'none';
  }
  if (d.ownerUsername && authorEl) {
    authorEl.textContent = `Created by u/${d.ownerUsername}`;
  }
  if (d.song && songEl) {
    const parts = [d.song.title ?? 'a rhythm show'];
    if (d.song.vibe) parts.push(d.song.vibe);
    if (d.song.difficulty) parts.push(d.song.difficulty);
    songEl.textContent = `🎶 ${parts.join(' · ')}`;
  }
  // Only show the info panel once we have a real owner — scaffold /
  // unmapped posts (like the original 'Meowcert' moderator-test post)
  // get just the MEOWCERT marquee + PLAY button, no half-filled
  // 'Created by u/—' / empty leaderboard noise.
  if (d.ownerUsername && infoPanel) {
    infoPanel.style.display = '';
  }
}

function renderLeaderboard(d: LeaderboardData): void {
  const top = d.top ?? [];
  // Plays count moved to the prominent banner above the play CTA — used
  // to be a small caption in the leaderboard header, Tim wanted it more
  // visible as social proof. Prefer server-counted total plays (every
  // submission counts) over top.length (unique players, PB-only).
  const plays = d.totalPlays ?? top.length;
  if (playsBannerEl && playsBannerCountEl && playsBannerLabelEl && hasChart !== false) {
    playsBannerCountEl.textContent = plays.toLocaleString();
    playsBannerLabelEl.textContent = plays === 1 ? 'play' : 'plays';
    playsBannerEl.style.display = '';
  }
  for (let i = 0; i < 3; i++) {
    const li = lbEls[i];
    if (!li) continue;
    const e = top[i];
    if (!e) {
      li.textContent = `${i + 1}. —`;
      continue;
    }
    // Backend field is `visitor` (the username string), not `username`
    // — this was the missing-score bug.
    const u = e.visitor;
    const name = u.length > 16 ? u.slice(0, 14) + '…' : u;
    li.textContent = `${i + 1}. ${name.padEnd(18)} ${e.score.toLocaleString()}`;
  }
  if (yourBestEl && d.yourRank != null && d.yourScore != null) {
    yourBestEl.textContent = `Your best: #${d.yourRank} · ${d.yourScore.toLocaleString()}`;
  }
}

function renderUpdatedStamp(): void {
  if (!updatedEl) return;
  if (lastUpdatedAt == null) {
    updatedEl.textContent = '';
    return;
  }
  const ageS = Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 1000));
  if (ageS < 2) updatedEl.textContent = 'Updated just now';
  else if (ageS < 60) updatedEl.textContent = `Updated ${ageS}s ago`;
  else updatedEl.textContent = `Updated ${Math.floor(ageS / 60)}m ago`;
}
