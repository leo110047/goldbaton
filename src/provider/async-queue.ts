interface QueueWaiter<T> {
  reject: (error: Error) => void;
  resolve: (result: IteratorResult<T>) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private closed = false;
  private failure: Error | undefined;
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];

  push(value: T): void {
    if (this.closed || this.failure) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed || this.failure) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.closed || this.failure) {
      return;
    }
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const result = await this.next();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ reject, resolve });
    });
  }
}
