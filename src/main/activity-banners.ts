import type { Activity } from "../shared/model";

// An OS timeout can leave a delivered alert in Notification Center. Retain its
// object until read so close() can remove it there as well.
export class ActivityBanners<T extends { close(): void }> {
  private entries = new Map<T, string | undefined>();
  track(banner: T, activityId?: string) {
    if (this.entries.size >= 500) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
      oldest.close();
    }
    this.entries.set(banner, activityId);
  }
  delete(banner: T) {
    this.entries.delete(banner);
  }
  sync(items: Activity[]) {
    const unread = new Set(
      items.filter((item) => !item.read).map((item) => item.id),
    );
    for (const [banner, id] of this.entries) {
      if (id && !unread.has(id)) {
        this.entries.delete(banner);
        banner.close();
      }
    }
  }
  close() {
    const entries = [...this.entries.keys()];
    this.entries.clear();
    for (const banner of entries) banner.close();
  }
}
