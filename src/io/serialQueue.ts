// Tiny serial queue: runs at most one task at a time, in submit order.
// Used by TunnelClient to serialise sendCemi() calls — the sequence counter
// and 1-second ACK window mean the gateway can only handle one in flight.

export class SerialQueue {
  private _tail: Promise<unknown> = Promise.resolve();
  private _depth = 0;

  /** Run `task` after all currently queued tasks. Returns its result. */
  run<T>(task: () => Promise<T>): Promise<T> {
    this._depth += 1;
    const next = this._tail.then(task, task);
    // Catch to avoid unhandled-rejection on the chain itself; per-call result
    // still rejects normally because we return `next`.
    this._tail = next.catch(() => undefined);
    next.finally(() => {
      this._depth -= 1;
    });
    return next;
  }

  /** Number of tasks currently queued or running. */
  get depth(): number {
    return this._depth;
  }
}
