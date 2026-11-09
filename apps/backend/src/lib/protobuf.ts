/**
 * 够用就好的 protobuf 读写：只给 CloudDrive2 的几个 gRPC 报文用（字符串、布尔、整数、嵌套报文），不引 protobufjs。
 *
 * 写：按字段号拼 tag + 值，调用方自己按 proto 的字段号组装。
 * 读：把一条报文解成「字段号 → 出现过的值」，嵌套报文留成字节由调用方再解一层；分组（wire type 3 / 4）早就废弃，碰到直接抛。
 */

export type ProtoValue =
  | { wireType: 0; value: bigint }
  | { wireType: 1 | 5; bytes: Uint8Array }
  | { wireType: 2; bytes: Uint8Array };

export type ProtoMessage = Map<number, ProtoValue[]>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeVarint(value: number | bigint): Uint8Array {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError("varint 不能是负数");
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const tag = (field: number, wireType: number): Uint8Array => encodeVarint((field << 3) | wireType);

/** 字符串字段（wire type 2）；proto3 里空串和没填一样，不发 */
export function encodeString(field: number, value: string): Uint8Array {
  if (!value) return new Uint8Array(0);
  const bytes = encoder.encode(value);
  return concatBytes(tag(field, 2), encodeVarint(bytes.length), bytes);
}

/** 嵌套报文 / 字节字段（wire type 2） */
export function encodeBytes(field: number, bytes: Uint8Array): Uint8Array {
  return concatBytes(tag(field, 2), encodeVarint(bytes.length), bytes);
}

/** 布尔字段（varint）；false 和没填一样，不发 */
export function encodeBool(field: number, value: boolean): Uint8Array {
  return value ? concatBytes(tag(field, 0), Uint8Array.of(1)) : new Uint8Array(0);
}

/** 无符号整数 / 枚举字段（varint）；0 不发 */
export function encodeUint(field: number, value: number | bigint): Uint8Array {
  return BigInt(value) === 0n ? new Uint8Array(0) : concatBytes(tag(field, 0), encodeVarint(value));
}

function readVarint(buf: Uint8Array, at: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let i = at;
  for (;;) {
    if (i >= buf.length) throw new RangeError("varint 读到了报文末尾");
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
    if (shift > 63n) throw new RangeError("varint 超过 64 位");
  }
}

export function decodeMessage(buf: Uint8Array): ProtoMessage {
  const out: ProtoMessage = new Map();
  let at = 0;
  while (at < buf.length) {
    const key = readVarint(buf, at);
    at = key.next;
    const field = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    let value: ProtoValue;
    if (wireType === 0) {
      const v = readVarint(buf, at);
      at = v.next;
      value = { wireType: 0, value: v.value };
    } else if (wireType === 1 || wireType === 5) {
      const len = wireType === 1 ? 8 : 4;
      if (at + len > buf.length) throw new RangeError("定长字段读到了报文末尾");
      value = { wireType, bytes: buf.subarray(at, at + len) };
      at += len;
    } else if (wireType === 2) {
      const len = readVarint(buf, at);
      at = len.next;
      const n = Number(len.value);
      if (at + n > buf.length) throw new RangeError("变长字段读到了报文末尾");
      value = { wireType: 2, bytes: buf.subarray(at, at + n) };
      at += n;
    } else {
      throw new RangeError(`不支持的 wire type ${wireType}`);
    }
    const list = out.get(field);
    if (list) list.push(value);
    else out.set(field, [value]);
  }
  return out;
}

const last = (m: ProtoMessage, field: number): ProtoValue | undefined => m.get(field)?.at(-1);

export function readString(m: ProtoMessage, field: number): string | undefined {
  const v = last(m, field);
  return v?.wireType === 2 ? decoder.decode(v.bytes) : undefined;
}

export function readBool(m: ProtoMessage, field: number): boolean | undefined {
  const v = last(m, field);
  return v?.wireType === 0 ? v.value !== 0n : undefined;
}

export function readUint(m: ProtoMessage, field: number): bigint | undefined {
  const v = last(m, field);
  return v?.wireType === 0 ? v.value : undefined;
}

/** 重复的嵌套报文：按出现顺序给字节，调用方再 decodeMessage */
export function readMessages(m: ProtoMessage, field: number): Uint8Array[] {
  return (m.get(field) ?? []).flatMap((v) => (v.wireType === 2 ? [v.bytes] : []));
}

/** 重复的字符串 */
export function readStrings(m: ProtoMessage, field: number): string[] {
  return readMessages(m, field).map((b) => decoder.decode(b));
}
