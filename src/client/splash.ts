import { requestExpandedMode } from '@devvit/web/client';

/**
 * Feed-preview splash for Meowcert posts. This is the static surface
 * Reddit shows in the feed BEFORE the user expands the post into the
 * game webview. Kept intentionally lightweight (no network calls, no
 * Phaser) so the feed scroll stays fast.
 *
 * The post title (set in publish.ts → "🎵 {owner}'s show") already
 * carries the owner attribution above the embed, so this splash
 * focuses on the call-to-action.
 */

const startButton = document.getElementById('start-button') as HTMLButtonElement | null;

startButton?.addEventListener('click', (e) => {
  // 'game' is the entrypoint key registered in devvit.json — this swaps
  // the splash for the full Phaser game webview. The VisitPost scene
  // takes over from there (visitor detection happens in the Preloader).
  requestExpandedMode(e, 'game');
});
