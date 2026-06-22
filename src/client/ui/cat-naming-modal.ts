import { Scene } from 'phaser';

export interface CatNamingModalOpts {
  /** Default name pre-filled in the input (e.g. the catalog breed name). */
  defaultName: string;
  /** Called with the final name when the player confirms. */
  onSubmit: (name: string) => void;
}

/**
 * A centered modal panel with an HTML text input for naming a new cat.
 *
 * Rendered using an overlay HTML <input> element (same pattern as the Welcome
 * scene) since Phaser's text objects don't support editable input. The modal
 * sits on top of whatever scene is active.
 *
 * Usage:
 *   const modal = new CatNamingModal(scene, { defaultName: 'Mochi', onSubmit });
 *   // To remove:
 *   modal.destroy();
 */
export class CatNamingModal {
  private overlay: HTMLDivElement;
  private destroyed = false;

  constructor(scene: Scene, opts: CatNamingModalOpts) {
    const { width } = scene.scale;

    // Build a full-screen semi-transparent HTML overlay so we can embed a
    // native <input> without fighting Phaser's canvas input handling.
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

    // Panel
    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:#1a0a2e',
      'border:2px solid #ffd34d',
      'border-radius:10px',
      'padding:28px 24px 20px',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:14px',
      `max-width:${Math.min(width - 32, 320)}px`,
      'width:90%',
    ].join(';');

    // Title
    const title = document.createElement('div');
    title.textContent = 'Name your new cat!';
    title.style.cssText = [
      'color:#ffd34d',
      'font-family:"Pixeloid Sans",monospace',
      'font-weight:bold',
      'font-size:15px',
      'text-align:center',
    ].join(';');

    // Input
    const input = document.createElement('input');
    input.type = 'text';
    input.value = opts.defaultName;
    input.maxLength = 20;
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

    // Select all on focus so the default name is easy to replace.
    input.addEventListener('focus', () => input.select());
    // Enter key confirms.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirm();
    });

    // Confirm button
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
    ].join(';');

    // Skip link
    const skip = document.createElement('a');
    skip.textContent = 'Skip (keep default name)';
    skip.href = '#';
    skip.style.cssText = [
      'color:#c0a0e6',
      'font-family:"Pixeloid Sans",monospace',
      'font-size:11px',
      'text-decoration:underline',
      'cursor:pointer',
    ].join(';');

    const confirm = (): void => {
      if (this.destroyed) return;
      const name = (input.value || '').trim() || opts.defaultName;
      this.destroy();
      opts.onSubmit(name);
    };

    const cancel = (e: Event): void => {
      e.preventDefault();
      if (this.destroyed) return;
      this.destroy();
      opts.onSubmit(opts.defaultName);
    };

    btn.addEventListener('click', confirm);
    skip.addEventListener('click', cancel);

    panel.append(title, input, btn, skip);
    overlay.append(panel);
    document.body.append(overlay);

    this.overlay = overlay;

    // Focus the input after a brief tick so virtual keyboards open correctly.
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
