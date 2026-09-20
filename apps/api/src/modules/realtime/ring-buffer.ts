/** A fixed-capacity FIFO that overwrites its oldest entry; entries carry increasing sequence numbers. */
export class RingBuffer<Entry extends { readonly seq: number }> {
  private readonly entries: (Entry | undefined)[];
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("A ring buffer needs a positive integer capacity");
    }
    this.entries = new Array<Entry | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** The oldest buffered sequence number, or undefined when empty. */
  get oldestSeq(): number | undefined {
    return this.count === 0 ? undefined : this.entries[this.start]?.seq;
  }

  push(entry: Entry): void {
    const newest = this.count === 0 ? undefined : this.at(this.count - 1);
    if (newest && entry.seq <= newest.seq) {
      throw new RangeError("Ring buffer entries must have increasing sequence numbers");
    }
    const index = (this.start + this.count) % this.capacity;
    this.entries[index] = entry;
    if (this.count < this.capacity) {
      this.count += 1;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /**
   * Whether a client that applied everything up to `cursor` can catch up from the buffer alone, given
   * the topic's latest sequence number: the cursor is not ahead of the topic and nothing after it has
   * been overwritten.
   */
  canReplayAfter(cursor: number, latestSeq: number): boolean {
    if (!Number.isSafeInteger(cursor) || cursor > latestSeq) return false;
    if (cursor === latestSeq) return true;
    const oldest = this.oldestSeq;
    return oldest !== undefined && cursor >= oldest - 1;
  }

  /** Entries with a sequence number greater than `cursor`, oldest first. */
  after(cursor: number): Entry[] {
    const result: Entry[] = [];
    for (let offset = 0; offset < this.count; offset += 1) {
      const entry = this.at(offset);
      if (entry && entry.seq > cursor) result.push(entry);
    }
    return result;
  }

  /** Entries with a sequence number at most `seq`, oldest first. */
  upTo(seq: number): Entry[] {
    const result: Entry[] = [];
    for (let offset = 0; offset < this.count; offset += 1) {
      const entry = this.at(offset);
      if (entry && entry.seq <= seq) result.push(entry);
    }
    return result;
  }

  clear(): void {
    this.entries.fill(undefined);
    this.start = 0;
    this.count = 0;
  }

  private at(offset: number): Entry | undefined {
    return this.entries[(this.start + offset) % this.capacity];
  }
}
