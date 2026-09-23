/**
 * The scene's frame listeners (OfficeScene.onFrame), apart from Pixi so they can be tested: called
 * right after a render to the screen with the canvas just drawn — the only moment a WebGL canvas can
 * be read. A render into a texture leaves the canvas as it was, so it calls nobody.
 */
export class FrameListeners {
  private readonly listeners = new Set<(canvas: HTMLCanvasElement) => void>();

  add(cb: (canvas: HTMLCanvasElement) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(canvas: HTMLCanvasElement, toScreen: boolean): void {
    if (!toScreen) return;
    for (const cb of this.listeners) {
      try {
        cb(canvas);
      } catch {
        /* a failing share must never stop the city from drawing */
      }
    }
  }
}
