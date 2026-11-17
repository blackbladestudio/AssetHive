type Listener = () => void;

// One queue survives scrolling. Only mounted cards subscribe to results, so a
// completed thumbnail does not rerender the whole application or resource list.
export class PreviewLoader {
  private cache = new Map<string, string>();
  private listeners = new Map<string, Set<Listener>>();
  private inFlight = new Set<string>();
  private prefetch: string[] = [];
  private viewport: string[] = [];
  private scheduled = false;
  private versions = new Map<string, number>();

  invalidate(paths: string[]) {
    const wanted = new Set(paths.map(path => path.replaceAll('\\', '/').toLowerCase()));
    const matches = (path: string) => wanted.has(path.replaceAll('\\', '/').toLowerCase());
    for (const path of new Set([...this.cache.keys(), ...this.listeners.keys(), ...this.inFlight])) if (matches(path)) {
      this.versions.set(path, (this.versions.get(path) || 0) + 1);
      this.cache.delete(path);
      this.listeners.delete(path);
    }
    this.prefetch = this.prefetch.filter(path => !matches(path));
    this.viewport = this.viewport.filter(path => !matches(path));
  }

  constructor(
    private resolve: (path: string) => Promise<string>,
    private concurrency = 6,
    private capacity = 2048
  ) {}

  get(path: string): string {
    return this.cache.get(path) || "";
  }

  subscribe(path: string, listener: Listener): () => void {
    if (!path) return () => {};
    let group = this.listeners.get(path);
    if (!group) {
      group = new Set();
      this.listeners.set(path, group);
    }
    group.add(listener);
    const cached = this.cache.get(path);
    if (cached) {
      this.cache.delete(path);
      this.cache.set(path, cached);
    }
    this.schedule();
    return () => {
      group.delete(listener);
      if (group.size === 0 && this.listeners.get(path) === group) this.listeners.delete(path);
      this.trim();
    };
  }

  setPrefetch(paths: string[]) {
    // Drop obsolete queued work immediately; retain useful work already running.
    this.prefetch = [...new Set(paths.filter(Boolean))];
    this.schedule();
  }

  setViewport(paths: string[]) {
    this.viewport = [...new Set(paths.filter(Boolean))];
    this.schedule();
  }

  private trim() {
    for (const path of this.cache.keys()) {
      if (this.cache.size <= this.capacity) break;
      if (!this.listeners.has(path)) this.cache.delete(path);
    }
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump() {
    // Overscan mounts rows above the viewport too. The cards actually on screen
    // must precede those rows, especially after a large scroll jump.
    const visible = this.viewport.filter(path => this.listeners.has(path));
    for (const path of new Set([...visible, ...this.listeners.keys(), ...this.prefetch])) {
      if (this.inFlight.size >= this.concurrency) break;
      if (this.cache.has(path) || this.inFlight.has(path)) continue;
      this.inFlight.add(path);
      const version = this.versions.get(path) || 0;
      // Consume a speculative request once, even if its cache entry is evicted.
      this.prefetch = this.prefetch.filter((candidate) => candidate !== path);
      void Promise.resolve().then(() => this.resolve(path)).catch(() => path).then((result) => {
        if ((this.versions.get(path) || 0) === version) this.cache.set(path, result || path);
        this.inFlight.delete(path);
        this.trim();
        this.listeners.get(path)?.forEach((listener) => listener());
        this.schedule();
      });
    }
  }
}
