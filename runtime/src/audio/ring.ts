/** Fixed-capacity ring buffer of numbers, oldest-first when read out. */
export class RingBuffer {
  readonly capacity: number;
  private readonly values: Float32Array;
  private write = 0;
  private filled = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.values = new Float32Array(this.capacity);
  }

  get length(): number {
    return this.filled;
  }

  push(value: number): void {
    this.values[this.write] = value;
    this.write = (this.write + 1) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + 1);
  }

  /** Value `age` entries back from the newest, or 0 when out of range. */
  fromEnd(age: number): number {
    if (age < 0 || age >= this.filled) {
      return 0;
    }
    return this.values[(this.write - 1 - age + this.capacity * 2) % this.capacity];
  }

  /** Copies the contents oldest-first into a new array. */
  toArray(): Float32Array {
    const output = new Float32Array(this.filled);
    for (let index = 0; index < this.filled; index += 1) {
      output[index] = this.values[(this.write - this.filled + index + this.capacity * 2) % this.capacity];
    }
    return output;
  }

  clear(): void {
    this.write = 0;
    this.filled = 0;
    this.values.fill(0);
  }
}

/** Ring buffer of fixed-width rows, used for per-beat and per-bar features. */
export class RingMatrix {
  readonly capacity: number;
  readonly width: number;
  private readonly values: Float32Array;
  private write = 0;
  private filled = 0;

  constructor(capacity: number, width: number) {
    this.capacity = Math.max(1, capacity);
    this.width = width;
    this.values = new Float32Array(this.capacity * width);
  }

  get length(): number {
    return this.filled;
  }

  push(row: Float32Array | number[]): void {
    const base = this.write * this.width;
    for (let column = 0; column < this.width; column += 1) {
      this.values[base + column] = row[column] ?? 0;
    }
    this.write = (this.write + 1) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + 1);
  }

  /** Row offset in the backing store for the row `age` entries back. */
  offsetFromEnd(age: number): number {
    const index = (this.write - 1 - age + this.capacity * 2) % this.capacity;
    return index * this.width;
  }

  get data(): Float32Array {
    return this.values;
  }

  clear(): void {
    this.write = 0;
    this.filled = 0;
    this.values.fill(0);
  }
}
