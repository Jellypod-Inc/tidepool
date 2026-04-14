type PendingEntry = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class PendingRegistry {
  private entries = new Map<string, PendingEntry>();

  register(taskId: string, timeoutMs: number): Promise<string> {
    if (this.entries.has(taskId)) {
      throw new Error(`duplicate taskId: ${taskId}`);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.entries.delete(taskId)) {
          reject(new Error(`reply timeout for task ${taskId}`));
        }
      }, timeoutMs);
      this.entries.set(taskId, { resolve, reject, timer });
    });
  }

  resolve(taskId: string, text: string): boolean {
    const entry = this.entries.get(taskId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(taskId);
    entry.resolve(text);
    return true;
  }

  reject(taskId: string, err: Error): boolean {
    const entry = this.entries.get(taskId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(taskId);
    entry.reject(err);
    return true;
  }

  closeAll(err: Error): void {
    for (const [, entry] of this.entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
