/**
 * Tutorial dialogue script — keyed by TutorialStepId. Strings are
 * what Whiskers-the-host says at each beat; arrays cover multi-line
 * sequences (e.g. dressing-walkthrough has 2 lines, play-tutorial has
 * one per chart section).
 *
 * Multi-line beats are advanced by the consuming scene — Decorate in
 * tutorial mode advances `dressing-walkthrough` from line 1 to line 2
 * when the cat is tapped; Game in tutorial mode advances the
 * `play-tutorial` lines at chart-section boundaries.
 *
 * Voice: cute + brief. "Pspspsing" framing per Tim ("cats prefer ps
 * over loud claps"). Keep lines under ~140 chars so the speech bubble
 * doesn't drag.
 *
 * NB: Personalized substitutions (e.g. "<poster>'s show" in
 * route-b-outro) are done at render time with simple string replace —
 * the script holds the template.
 */

import type { TutorialStepId } from './tutorial-types';

export const TUTORIAL_DIALOGUE: Record<TutorialStepId, string | string[]> = {
  'intro':
    "hey, I'm Butters. I noticed you're new here, so let me show you the ropes before we put on a Meowcert.",
  'pick-stage':
    "first, let's pick a venue for your show. don't worry — there will be cooler venues for you to perform at later, but for now pick one of the 3 available.",
  'pick-cat':
    "next, pick your first bandmember. you'll be able to hire more bandmembers as you earn rewards from hosting and attending shows.",
  'merch-intro':
    "welcome to the band, <catname>! let's check the merch table to spice up your new bandmember.",
  'box-cosmetic':
    "first, let's open up a cosmetic box — that's where you'll find hats, bows, and other accessories for your cats.",
  'box-effect':
    "next, let's open up an effects box — that's where you'll find sparkles, flames, and particle flair that make your cats stand out.",
  'stage-set-confirm':
    "your stage is set! this is what you'll see when you practice or when you put on a show for others. you can always come back here with this tab on the menu.",
  'rehearsal-intro':
    "now let's get to practicing. you'll find REHEARSE in here whenever you want to head to the stage for some practice.",
  'play-tutorial-intro':
    "for each show you attend or when you're practicing with your band, we'll be pspspsing the performers — they prefer being cheered on that way over loud claps. you'll see fuzzy balls fall down — that's the optimal time for a lil ps for the kitties. tap them as they get inside the circle.",
  'play-tutorial': [
    // 0 — taps + chord intro (drops chord notes after first tap-only round)
    "nice! those are taps — the basic note. two or three lanes at once? both work, it's just a chord.",
    // 1 — lane styling explainer (no notes, Continue advances)
    "your cat lives in the middle for now, but the side lanes still work — they're ready for when you hire more bandmembers. who you put on stage affects how your lanes look in-game. since i'm here you'll see my lane is set to match me — let me get out my butter effect for you too.",
    // 2 — holds
    "holds are tap-and-hold — keep your finger down until it ends.",
    // 3 — slides (1 lane)
    "slides next! tap and drag to the next lane.",
    // 4 — slides (2 lanes)
    "you can slide across 2 lanes too — same gesture, longer drag.",
    // 5 — double slide
    "and the double slide ◀▶ — drag out, then drag back. takes practice.",
    // 6 — insane chart (5s timer)
    "ok! you're ready for an insane run!",
    // 7 — outro + menu mock w/ PUT ON A SHOW highlighted
    "...just kidding 😼. you've got a long way to go before that. now i'll show you how to put on a show — let's first head to this tab.",
  ],
  'editor-tour-intro':
    "now let's check out the editor — that's where you'll create your own shows.",
  'editor-tour':
    "tap a cell to place a note. drag down in one lane for a hold. drag across lanes for a slide. drag out and back for the ◀▶ one. you can come back to the editor any time to keep tweaking — and when you're happy, you have to REHEARSE and PASS the chart before you can post it for others to play.",
  'visit-pointer':
    "when you want to catch other people's shows, head here.",
  'route-a-outro':
    "you're all set! go run wild — your show, your rules.",
  'route-b-outro':
    "now that you know the lay of the land, let's get you back to <poster>'s show!",
};

/** Always-array view of the dialogue for a given step. Callers that
 *  only care about single-line beats can use `getTutorialDialogue(step)[0]`. */
export function getTutorialDialogue(step: TutorialStepId): string[] {
  const d = TUTORIAL_DIALOGUE[step];
  return Array.isArray(d) ? d : [d];
}

/** Substitute template placeholders:
 *   - `<poster>` → the deep-link poster's username (route-b-outro)
 *   - `<catname>` → the player's seated starter cat name (merch-intro)
 *  Returns the line unchanged where a placeholder isn't present.
 *  Missing values get sensible fallbacks. */
export function personalize(
  line: string,
  posterUsername: string | undefined,
  catName?: string,
): string {
  let out = posterUsername
    ? line.replace('<poster>', `u/${posterUsername}`)
    : line.replace('<poster>', 'your friend');
  if (catName) {
    out = out.replace('<catname>', catName);
  } else {
    out = out.replace('<catname>', 'your new bandmember');
  }
  return out;
}
