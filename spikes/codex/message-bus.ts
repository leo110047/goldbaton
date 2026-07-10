export type WireMessage = Record<string, unknown>;
export type Predicate = (message: WireMessage) => boolean;

interface Waiter {
  predicate: Predicate;
  reject: (error: Error) => void;
  resolve: (message: WireMessage) => void;
}

export class MessageBus {
  private failure?: Error;
  private readonly messages: WireMessage[] = [];
  private readonly waiters = new Set<Waiter>();

  fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const waiter of this.waiters) {
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  push(message: WireMessage): void {
    this.messages.push(message);
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) {
        waiter.resolve(message);
      }
    }
  }

  waitFor(predicate: Predicate, label: string): Promise<WireMessage> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return this.createWaiter(predicate, label);
  }

  private createWaiter(
    predicate: Predicate,
    label: string,
  ): Promise<WireMessage> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter: Waiter = {
        predicate,
        reject: (error) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          reject(error);
        },
        resolve: (message) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(message);
        },
      };
      timer = setTimeout(
        () => waiter.reject(new Error(`Timed out waiting for ${label}`)),
        120_000,
      );
      this.waiters.add(waiter);
    });
  }
}
