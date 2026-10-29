export class PerJunctionSerialProcessor {
  private readonly pending = new Map<string, Promise<void>>();

  run<T>(junctionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(junctionId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(() => undefined, () => undefined);
    this.pending.set(junctionId, settled);
    void settled.then(() => {
      if (this.pending.get(junctionId) === settled) this.pending.delete(junctionId);
    });
    return current;
  }
}
