import { Scene } from 'phaser';
import { validateCatName, NAME_MAX_LENGTH } from './name-validation';

export interface CatNamingModalOpts {
  /** Default name pre-filled in the input (e.g. the catalog breed name). */
  defaultName: string;
  /** Existing owned cats (so we can reject duplicate names). */
  existingCats: Array<{ id: string; name: string }>;
  /** Called with the validated final name when the player confirms. */
  onSubmit: (name: string) => void;
}

/**
 * Centered modal panel with a native <input> for naming a new cat.
 *
 * The player MUST provide a valid name — there is no skip / cancel path.
 * Validation runs on every keystroke; the Save button stays disabled until
 * the name passes (non-empty, ≤ NAME_MAX_LENGTH, no profanity, not a
 * duplicate of an existing owned cat's name). Errors render in a small
 * red line directly above the Save button.
 */
export class CatNamingModal {
  private overlay: HTMLDivElement;
  private destroyed = false;

  constructor(scene: Scene, opts: CatNamingModalOpts) {
    const { width } = scene.scale;

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.6)',
      'z-index:9999',
    ].join(';');

    const panel = document.createElement('div');
    // Pixel-style sharp corners (Image 30) + deep #1a0a2e panel
    // matching TemplateOrScratchModal / SongPickerModal outer panels.
    // Image 31 follow-up: "color is off for this one" — #2c1856 was
    // too light against the rest of the UI; #1a0a2e is the common
    // outer-panel color in this codebase.
    panel.style.cssText = [
      'background:#1a0a2e',
      'border:2px solid #ffd34d',
      'border-radius:0',
      'padding:28px 24px 20px',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:10px',
      `max-width:${Math.min(width - 32, 320)}px`,
      'width:90%',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Name your new cat!';
    title.style.cssText = [
      'color:#ffd34d',
      'font-family:"Pixeloid Sans",monospace',
      'font-weight:bold',
      'font-size:15px',
      'text-align:center',
    ].join(';');

    const input = document.createElement('input');
    input.type = 'text';
    input.value = opts.defaultName;
    // Hard cap typing at the limit; when the player tries to type more,
    // the beforeinput listener below surfaces a "max length" error so the
    // block isn't silent.
    input.maxLength = NAME_MAX_LENGTH;
    input.placeholder = 'Enter a name…';
    input.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'background:#0b041a',
      'border:2px solid #c0a0e6',
      'border-radius:0',
      'color:#ffffff',
      'font-family:"Pixeloid Sans",monospace',
      'font-size:15px',
      'padding:8px 10px',
      'text-align:center',
      'outline:none',
    ].join(';');

    // Error line — hidden until validation reports a problem.
    const errorLine = document.createElement('div');
    errorLine.style.cssText = [
      'color:#ff7a7a',
      'font-family:"Pixeloid Sans",monospace',
      'font-size:11px',
      'text-align:center',
      'min-height:14px',
      'line-height:14px',
    ].join(';');

    // Char count helper so the player can see they're getting close to the
    // limit before they hit it.
    const charCount = document.createElement('div');
    charCount.style.cssText = [
      'color:#8a78b8',
      'font-family:"Pixeloid Sans",monospace',
      'font-size:10px',
      'text-align:right',
      'width:100%',
    ].join(';');

    const btn = document.createElement('button');
    btn.textContent = 'Save name';
    btn.style.cssText = [
      'background:#ffd34d',
      'color:#1a0a2e',
      'border:2px solid #1a0a2e',
      'border-radius:0',
      'padding:10px 28px',
      'font-family:"Pixeloid Sans",monospace',
      'font-weight:bold',
      'font-size:14px',
      'cursor:pointer',
      'transition:opacity 0.15s',
    ].join(';');

    const updateButtonState = (enabled: boolean): void => {
      if (enabled) {
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        btn.disabled = false;
      } else {
        btn.style.opacity = '0.45';
        btn.style.cursor = 'not-allowed';
        btn.disabled = true;
      }
    };

    const runValidation = (): boolean => {
      const v = validateCatName(input.value, opts.existingCats);
      errorLine.textContent = v.error;
      charCount.textContent = `${input.value.length} / ${NAME_MAX_LENGTH}`;
      updateButtonState(v.ok);
      // Border color cue too — red on error, accent on valid.
      input.style.borderColor = v.ok ? '#c0a0e6' : '#ff7a7a';
      return v.ok;
    };

    const confirm = (): void => {
      if (this.destroyed) return;
      if (!runValidation()) return;
      const name = input.value.trim();
      this.destroy();
      opts.onSubmit(name);
    };

    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => runValidation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirm();
    });
    // Show the "max length" error the moment the player attempts to type
    // past the limit, even though the browser silently blocks the keystroke
    // because of maxLength. Without this listener the block is invisible.
    input.addEventListener('beforeinput', (e) => {
      const ev = e as InputEvent;
      const insertingChar = ev.inputType?.startsWith('insert');
      const atLimit = input.value.length >= NAME_MAX_LENGTH;
      const noSelection = input.selectionStart === input.selectionEnd;
      if (insertingChar && atLimit && noSelection) {
        errorLine.textContent = `You are at the max length (${NAME_MAX_LENGTH} characters).`;
        input.style.borderColor = '#ff7a7a';
      }
    });
    btn.addEventListener('click', confirm);

    // Layout order: title → input → counter → Save → error.
    // Error sits BELOW the button so the gap between the input and the
    // primary action reads as a clean stack, and the error is right where
    // the player will look after a failed click.
    panel.append(title, input, charCount, btn, errorLine);
    overlay.append(panel);
    document.body.append(overlay);

    this.overlay = overlay;

    // Run validation once for the initial default name (mostly to set the
    // char counter and button state).
    runValidation();

    scene.time.delayedCall(80, () => {
      if (!this.destroyed) input.focus();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.overlay.remove();
  }
}
