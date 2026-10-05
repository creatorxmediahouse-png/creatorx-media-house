/** Runs one ExtendScript tool body inside After Effects and returns its result. */
export interface AeBridge {
  readonly name: string;
  run(body: string, args: unknown, options?: RunOptions): Promise<unknown>;
}

export interface RunOptions {
  /** How long to wait for After Effects to finish the script. */
  timeoutMs?: number;
}

/** The script ran but threw inside After Effects (bad comp name, invalid value, ...). */
export class AeScriptError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "AeScriptError";
  }
}

/** The script never produced a result: After Effects is missing, closed, busy or blocked. */
export class AeBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AeBridgeError";
  }
}

/**
 * After Effects executes one script at a time, so calls are queued rather
 * than fired concurrently.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
