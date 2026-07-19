import { Component, ReactNode } from 'react';

// Error boundary around lazy-loaded route chunks. The common failure is a
// STALE chunk after a deploy: the hashed file the running tab references was
// removed server-side, so a dynamic import rejects. A hard reload fetches the
// fresh index.html (with the new chunk names) and fixes it. We auto-reload
// exactly once per session (a sessionStorage guard prevents a reload loop if a
// build is genuinely broken); after that, or for non-chunk errors, we show a
// recoverable message instead of a white screen.
const CHUNK_ERR = /dynamically imported module|Loading chunk|error loading dynamically|importing a module script|Failed to fetch/i;
const RELOAD_FLAG = 'st-chunk-reloaded';

export class ChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    if (!CHUNK_ERR.test(msg)) return;
    let alreadyReloaded = false;
    try {
      alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) === '1';
      sessionStorage.setItem(RELOAD_FLAG, '1');
    } catch {
      /* storage blocked — fall through to the manual Reload button */
    }
    if (!alreadyReloaded) window.location.reload();
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="fullpage-center">
          <div className="empty-state">
            Something went wrong loading this page.
            <br />
            <button className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
