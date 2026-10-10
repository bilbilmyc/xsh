// Keep terminal logging useful without allowing every open tab to retain an
// unbounded transcript in addition to xterm's independently bounded scrollback.
export const DEFAULT_SESSION_LOG_MAX_BYTES = 4 * 1024 * 1024;

export const SESSION_LOG_TRUNCATION_MARKER =
  "\n[XSH] Earlier terminal output was truncated to limit in-memory log usage.\n";

interface LogChunk {
  text: string;
  bytes: number;
}

export class BoundedSessionLogBuffer {
  private readonly maxBytes: number;
  private readonly markerBytes = utf8ByteLength(SESSION_LOG_TRUNCATION_MARKER);
  private header = "";
  private headerBytes = 0;
  private chunks: Array<LogChunk | undefined> = [];
  private chunkHead = 0;
  private outputBytes = 0;
  private trimmed = false;

  constructor(maxBytes = DEFAULT_SESSION_LOG_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= this.markerBytes) {
      throw new RangeError("session log byte limit is too small");
    }
    this.maxBytes = maxBytes;
  }

  reset(header: string): void {
    const headerBytes = utf8ByteLength(header);
    if (headerBytes + this.markerBytes > this.maxBytes) {
      throw new RangeError("session log header exceeds the byte limit");
    }
    this.header = header;
    this.headerBytes = headerBytes;
    this.chunks = [];
    this.chunkHead = 0;
    this.outputBytes = 0;
    this.trimmed = false;
  }

  /**
   * `byteLength` lets hot callers (the terminal output path) pass the source
   * chunk's known UTF-8 length instead of re-walking every code point here.
   */
  append(output: string, byteLength = utf8ByteLength(output)): void {
    if (!output) return;
    const bytes = byteLength;
    if (bytes === 0) return;
    this.chunks.push({ text: output, bytes });
    this.outputBytes += bytes;

    const untrimmedCapacity = this.maxBytes - this.headerBytes;
    if (!this.trimmed && this.outputBytes <= untrimmedCapacity) return;

    this.trimmed = true;
    this.trimOutputTo(this.maxBytes - this.headerBytes - this.markerBytes);
  }

  toString(): string {
    const output = this.chunks
      .slice(this.chunkHead)
      .filter((chunk): chunk is LogChunk => chunk !== undefined)
      .map((chunk) => chunk.text)
      .join("");
    return `${this.header}${this.trimmed ? SESSION_LOG_TRUNCATION_MARKER : ""}${output}`;
  }

  get byteLength(): number {
    return this.headerBytes + (this.trimmed ? this.markerBytes : 0) + this.outputBytes;
  }

  get wasTrimmed(): boolean {
    return this.trimmed;
  }

  private trimOutputTo(capacity: number): void {
    while (this.outputBytes > capacity && this.chunkHead < this.chunks.length) {
      const first = this.chunks[this.chunkHead];
      if (!first) {
        this.chunkHead += 1;
        continue;
      }

      const excess = this.outputBytes - capacity;
      if (first.bytes <= excess) {
        this.outputBytes -= first.bytes;
        this.chunks[this.chunkHead] = undefined;
        this.chunkHead += 1;
        continue;
      }

      const retained = trimUtf8Prefix(first.text, first.bytes, excess);
      this.outputBytes += retained.bytes - first.bytes;
      if (retained.text) {
        this.chunks[this.chunkHead] = retained;
      } else {
        this.chunks[this.chunkHead] = undefined;
        this.chunkHead += 1;
      }
    }

    if (this.chunkHead >= 64 && this.chunkHead * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.chunkHead);
      this.chunkHead = 0;
    }
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const codeUnit = value.charCodeAt(index);
    const width = utf16CodePointWidth(value, index);
    bytes += utf8SequenceByteLength(codeUnit, width);
    index += width;
  }
  return bytes;
}

function trimUtf8Prefix(value: string, totalBytes: number, minimumBytes: number): LogChunk {
  let end = 0;
  let removedBytes = 0;

  while (end < value.length && removedBytes < minimumBytes) {
    const codeUnit = value.charCodeAt(end);
    const width = utf16CodePointWidth(value, end);
    removedBytes += utf8SequenceByteLength(codeUnit, width);
    end += width;
  }

  return { text: value.slice(end), bytes: totalBytes - removedBytes };
}

function utf8SequenceByteLength(codeUnit: number, width: 1 | 2): number {
  if (width === 2) return 4;
  if (codeUnit <= 0x7f) return 1;
  if (codeUnit <= 0x7ff) return 2;
  // TextEncoder replaces unpaired surrogates with U+FFFD, which is 3 bytes.
  return 3;
}

function utf16CodePointWidth(value: string, index: number): 1 | 2 {
  const codeUnit = value.charCodeAt(index);
  const nextCodeUnit = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
    && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff
    ? 2
    : 1;
}
