/**
 * Layer 0.5: Cross-platform Buffer abstraction
 *
 * VS Code needs consistent binary operations across Node.js (Buffer) and browsers (Uint8Array).
 * VSBuffer is a thin wrapper around Uint8Array that provides a consistent read/write interface.
 *
 * This is the foundation for the serialization and transport layers.
 */

export class VSBuffer {
  readonly buffer: Uint8Array;
  readonly byteLength: number;

  private constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.byteLength = buffer.byteLength;
  }

  /** Allocate an empty buffer of the specified size. */
  static alloc(byteLength: number): VSBuffer {
    return new VSBuffer(new Uint8Array(byteLength));
  }

  /** Wrap an existing Uint8Array. */
  static wrap(buffer: Uint8Array): VSBuffer {
    return new VSBuffer(buffer);
  }

  /** Create a buffer from a string (UTF-8). */
  static fromString(str: string): VSBuffer {
    const encoder = new TextEncoder();
    return new VSBuffer(encoder.encode(str));
  }

  /** Concatenate multiple buffers. */
  static concat(buffers: VSBuffer[], totalLength?: number): VSBuffer {
    const len = totalLength ?? buffers.reduce((sum, b) => sum + b.byteLength, 0);
    const result = VSBuffer.alloc(len);
    let offset = 0;
    for (const buf of buffers) {
      result.set(buf, offset);
      offset += buf.byteLength;
    }
    return result;
  }

  /** Convert to a UTF-8 string. */
  toString(): string {
    const decoder = new TextDecoder();
    return decoder.decode(this.buffer);
  }

  /** Slice the buffer. */
  slice(start: number, end?: number): VSBuffer {
    return new VSBuffer(this.buffer.slice(start, end));
  }

  /** Copy data to the specified offset in this buffer. */
  set(source: VSBuffer | Uint8Array, offset = 0): void {
    const raw = source instanceof VSBuffer ? source.buffer : source;
    this.buffer.set(raw, offset);
  }

  readUInt8(offset: number): number {
    return this.buffer[offset];
  }

  writeUInt8(value: number, offset: number): void {
    this.buffer[offset] = value;
  }

  readUInt32BE(offset: number): number {
    return (
      ((this.buffer[offset] << 24) |
        (this.buffer[offset + 1] << 16) |
        (this.buffer[offset + 2] << 8) |
        this.buffer[offset + 3]) >>>
      0
    );
  }

  writeUInt32BE(value: number, offset: number): void {
    this.buffer[offset] = (value >>> 24) & 0xff;
    this.buffer[offset + 1] = (value >>> 16) & 0xff;
    this.buffer[offset + 2] = (value >>> 8) & 0xff;
    this.buffer[offset + 3] = value & 0xff;
  }
}
