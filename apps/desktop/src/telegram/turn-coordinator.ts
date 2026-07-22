/** Bound independent turns without sharing an Agent. Each admitted callback is
 * a stateless contract worker; the limit protects the model/runtime rather
 * than imposing global serialization. */
export function createTurnCoordinator(maxParallel = 4) {
  const limit = Math.max(1, Math.floor(maxParallel));
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async () => {
    if (active < limit) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
  };

  const release = () => {
    active--;
    waiting.shift()?.();
  };

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return (async () => {
        await acquire();
        try {
          return await fn();
        } finally {
          release();
        }
      })();
    },
    get active() {
      return active;
    },
  };
}

export type TurnCoordinator = ReturnType<typeof createTurnCoordinator>;
