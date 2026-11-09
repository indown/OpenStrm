/**
 * 手拼的 protobuf 读写（lib/protobuf.ts）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { concatBytes, decodeMessage, encodeBool, encodeBytes, encodeString, encodeUint, encodeVarint, readBool, readMessages, readString, readStrings, readUint } from "./protobuf.js";

test("varint：边界值", () => {
  assert.deepEqual([...encodeVarint(0)], [0]);
  assert.deepEqual([...encodeVarint(127)], [127]);
  assert.deepEqual([...encodeVarint(128)], [128, 1]);
  assert.deepEqual([...encodeVarint(300)], [172, 2]);
  assert.deepEqual([...encodeVarint(2n ** 32n + 1n)], [129, 128, 128, 128, 16]);
  assert.throws(() => encodeVarint(-1), RangeError);
});

test("proto3 的默认值不发：空串、false、0", () => {
  assert.equal(encodeString(1, "").length, 0);
  assert.equal(encodeBool(2, false).length, 0);
  assert.equal(encodeUint(3, 0).length, 0);
  assert.deepEqual([...encodeBool(2, true)], [0x10, 1]);
  assert.deepEqual([...encodeString(1, "a")], [0x0a, 1, 0x61]);
});

test("编一条带嵌套的报文再解回来：字符串、布尔、整数、重复的嵌套报文、UTF-8", () => {
  const sub = (name: string, dir: boolean) => encodeBytes(1, concatBytes(encodeString(2, name), encodeBool(30, dir)));
  const msg = concatBytes(encodeBool(8, true), encodeString(3, "令牌 token"), encodeUint(4, 1_800_000_000), sub("Season 1 ", true), sub("E01.mkv", false), encodeBytes(9, encodeUint(1, 42)));
  const m = decodeMessage(msg);
  assert.equal(readBool(m, 8), true);
  assert.equal(readString(m, 3), "令牌 token");
  assert.equal(readUint(m, 4), 1_800_000_000n);
  const subs = readMessages(m, 1).map((b) => decodeMessage(b));
  assert.deepEqual(subs.map((s) => [readString(s, 2), readBool(s, 30) ?? false]), [["Season 1 ", true], ["E01.mkv", false]]);
  assert.equal(readUint(decodeMessage(readMessages(m, 9)[0]), 1), 42n);
  assert.equal(readString(m, 7), undefined, "没有的字段");
  assert.deepEqual(readStrings(m, 3), ["令牌 token"]);
});

test("读的时候：定长字段跳得过去，截断和分组报错", () => {
  // field 5 wire type 1（fixed64）+ field 6 wire type 5（fixed32）+ field 1 varint
  const buf = Uint8Array.from([0x29, 1, 2, 3, 4, 5, 6, 7, 8, 0x35, 9, 10, 11, 12, 0x08, 1]);
  const m = decodeMessage(buf);
  assert.equal(readBool(m, 1), true);
  assert.equal(m.get(5)?.[0]?.wireType, 1);
  assert.throws(() => decodeMessage(Uint8Array.from([0x0a, 5, 0x61])), RangeError, "长度超过剩余字节");
  assert.throws(() => decodeMessage(Uint8Array.from([0x0b])), RangeError, "分组（wire type 3）");
});
