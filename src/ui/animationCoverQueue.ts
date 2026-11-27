import type { PreviewLoader } from "./previewLoader";

export type AnimationCoverTarget = {
  assetId: string;
  modelPath: string;
  skeletonPath?: string;
  skeletalMeshPath?: string;
};

export class AnimationCoverQueue {
  private cards = new Map<Element, { target: AnimationCoverTarget; unsubscribe?: () => void }>();
  private observer?: IntersectionObserver;
  private listeners = new Set<() => void>();
  private retryAfter = new Map<string, number>();
  private current: AnimationCoverTarget | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private enabled = false;

  constructor(private loader: PreviewLoader, private rig: Pick<AnimationCoverTarget, "skeletonPath" | "skeletalMeshPath">) {}

  getSnapshot = () => this.current;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  observe(element: Element, target: AnimationCoverTarget) {
    this.observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        const card = this.cards.get(entry.target);
        if (!card) continue;
        if (entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0) {
          card.unsubscribe ??= this.loader.subscribe(card.target.modelPath, this.schedule);
        } else {
          card.unsubscribe?.();
          card.unsubscribe = undefined;
        }
      }
      this.schedule();
    });
    this.cards.set(element, { target: {
      ...target,
      skeletonPath: target.skeletonPath || this.rig.skeletonPath,
      skeletalMeshPath: target.skeletalMeshPath || this.rig.skeletalMeshPath
    } });
    this.observer.observe(element);
    return () => {
      this.cards.get(element)?.unsubscribe?.();
      this.cards.delete(element);
      this.observer?.unobserve(element);
      if (!this.cards.size) {
        this.observer?.disconnect();
        this.observer = undefined;
      }
      this.schedule();
    };
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) this.schedule();
    else {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.setCurrent(null);
    }
  }

  finish(target: AnimationCoverTarget) {
    if (this.current !== target) return;
    if (this.loader.get(target.modelPath) === target.modelPath) {
      this.retryAfter.set(target.modelPath, Date.now() + 60_000);
      if (this.retryAfter.size > 2048) this.retryAfter.delete(this.retryAfter.keys().next().value!);
    }
    this.setCurrent(null);
    this.schedule();
  }

  private schedule = () => {
    if (!this.enabled || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const visible = [...this.cards.values()].filter(card => card.unsubscribe).map(card => card.target);
      if (this.current && visible.some(target => target.modelPath === this.current?.modelPath)) return;
      const next = visible.find(({ modelPath }) => this.loader.get(modelPath) === modelPath
        && (this.retryAfter.get(modelPath) || 0) <= Date.now());
      this.setCurrent(next ? { ...next } : null);
    }, 160);
  };

  private setCurrent(target: AnimationCoverTarget | null) {
    if (this.current === target) return;
    this.current = target;
    this.listeners.forEach(listener => listener());
  }
}
