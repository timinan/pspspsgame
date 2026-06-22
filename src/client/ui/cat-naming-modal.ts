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
    panel.style.cssText = [
      'background:#1a0a2e',
      'border:2px solid #ffd34d',
      'border-radius:10px',
      'padding:28px 24px 20px',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:12px',
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
    // Intentionally no maxLength — we WANT users to be able to type past
    // the limit so they see the "max length" error instead of having the
    // browser silently swallow keystrokes.
    input.placeholder = 'Enter a name…';
    input.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'background:#0b041a',
      'border:2px solid #c0a0e6',
      'border-radius:6px',
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
      'border:none',
      'border-radius:6px',
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
    btn.addEventListener('click', confirm);

    panel.append(title, input, charCount, errorLine, btn);
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
