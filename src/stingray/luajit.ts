import { InvalidFormatError } from "../errors.js";

const ESC = 0x1b;
const HEAD_L = 0x4c;
const HEAD_J = 0x4a;
const FLAG_BE = 0x01;
const FLAG_STRIP = 0x02;
const FLAG_FR2 = 0x08;
const BIAS_J = 0x8000;
const KGC_CHILD = 0;
const KGC_TAB = 1;
const KGC_I64 = 2;
const KGC_U64 = 3;
const KGC_COMPLEX = 4;
const KGC_STR = 5;
const KTAB_NIL = 0;
const KTAB_FALSE = 1;
const KTAB_TRUE = 2;
const KTAB_INT = 3;
const KTAB_NUM = 4;
const KTAB_STR = 5;

const OPCODES_V2 = [
  "ISLT", "ISGE", "ISLE", "ISGT", "ISEQV", "ISNEV", "ISEQS", "ISNES", "ISEQN", "ISNEN",
  "ISEQP", "ISNEP", "ISTC", "ISFC", "IST", "ISF", "ISTYPE", "ISNUM", "MOV", "NOT",
  "UNM", "LEN", "ADDVN", "SUBVN", "MULVN", "DIVVN", "MODVN", "ADDNV", "SUBNV", "MULNV",
  "DIVNV", "MODNV", "ADDVV", "SUBVV", "MULVV", "DIVVV", "MODVV", "POW", "CAT", "KSTR",
  "KCDATA", "KSHORT", "KNUM", "KPRI", "KNIL", "UGET", "USETV", "USETS", "USETN", "USETP",
  "UCLO", "FNEW", "TNEW", "TDUP", "GGET", "GSET", "TGETV", "TGETS", "TGETB", "TGETR",
  "TSETV", "TSETS", "TSETB", "TSETM", "TSETR", "CALLM", "CALL", "CALLMT", "CALLT", "ITERC",
  "ITERN", "VARG", "ISNEXT", "RETM", "RET", "RET0", "RET1", "FORI", "JFORI", "FORL",
  "IFORL", "JFORL", "ITERL", "IITERL", "JITERL", "LOOP", "ILOOP", "JLOOP", "JMP", "BNOT",
  "BAND", "BOR", "BXOR", "BSHL", "BSHR", "BSAR",
] as const;

const OPCODES_V1 = [
  "ISLT", "ISGE", "ISLE", "ISGT", "ISEQV", "ISNEV", "ISEQS", "ISNES", "ISEQN", "ISNEN",
  "ISEQP", "ISNEP", "ISTC", "ISFC", "IST", "ISF", "MOV", "NOT", "UNM", "LEN",
  "ADDVN", "SUBVN", "MULVN", "DIVVN", "MODVN", "ADDNV", "SUBNV", "MULNV", "DIVNV", "MODNV",
  "ADDVV", "SUBVV", "MULVV", "DIVVV", "MODVV", "POW", "CAT", "KSTR", "KCDATA", "KSHORT",
  "KNUM", "KPRI", "KNIL", "UGET", "USETV", "USETS", "USETN", "USETP", "UCLO", "FNEW",
  "TNEW", "TDUP", "GGET", "GSET", "TGETV", "TGETS", "TGETB", "TSETV", "TSETS", "TSETB",
  "TSETM", "CALLM", "CALL", "CALLMT", "CALLT", "ITERC", "ITERN", "VARG", "ISNEXT", "RETM",
  "RET", "RET0", "RET1", "FORI", "JFORI", "FORL", "IFORL", "JFORL", "ITERL", "IITERL",
  "JITERL", "LOOP", "ILOOP", "JLOOP", "JMP",
] as const;

const LUA_KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto",
  "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until",
  "while",
]);

const COMPARE_GOTO = {
  ISLT: ">=",
  ISGE: "<",
  ISLE: ">",
  ISGT: "<=",
  ISEQV: "~=",
  ISNEV: "==",
  ISEQS: "~=",
  ISNES: "==",
  ISEQN: "~=",
  ISNEN: "==",
  ISEQP: "~=",
  ISNEP: "==",
} as const;

type OpcodeName = string;

interface Instruction {
  op: OpcodeName;
  a: number;
  b: number;
  c: number;
  d: number;
}

type GcConst =
  | { kind: "str"; value: string }
  | { kind: "tab"; array: LuaValue[]; hash: Array<{ key: LuaValue; value: LuaValue }> }
  | { kind: "proto"; proto: Proto }
  | { kind: "cdata"; label: string };

type LuaValue = string | number | boolean | null | GcConst;

interface Proto {
  id: number;
  flags: number;
  numparams: number;
  framesize: number;
  uv: number[];
  kgc: GcConst[];
  kn: number[];
  ins: Instruction[];
}

interface Dump {
  version: number;
  flags: number;
  chunkname: string;
  root: Proto;
}

class DumpReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  offset = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  private require(size: number): void {
    if (this.offset + size > this.bytes.length) {
      throw new InvalidFormatError(
        `LuaJIT dump truncated: need ${size} bytes at ${this.offset}, size ${this.bytes.length}`,
      );
    }
  }

  readU8(): number {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  peekU8(): number {
    this.require(1);
    return this.view.getUint8(this.offset);
  }

  readU16(littleEndian: boolean): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, littleEndian);
    this.offset += 2;
    return value;
  }

  readU32(littleEndian: boolean): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, littleEndian);
    this.offset += 4;
    return value;
  }

  readBytes(size: number): Uint8Array {
    this.require(size);
    const slice = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return slice;
  }

  readUleb128(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.readU8();
      value |= (byte & 0x7f) << shift;
      if (byte < 0x80) {
        return value >>> 0;
      }
      shift += 7;
      if (shift > 28) {
        throw new InvalidFormatError("LuaJIT ULEB128 overflow");
      }
    }
  }

  readUleb128_33(): { isNum: boolean; lo: number } {
    const first = this.readU8();
    const isNum = (first & 1) !== 0;
    let value = first >>> 1;
    if (value >= 0x40) {
      value &= 0x3f;
      let shift = -1;
      for (;;) {
        const byte = this.readU8();
        shift += 7;
        value |= (byte & 0x7f) << shift;
        if (byte < 0x80) {
          break;
        }
        if (shift > 28) {
          throw new InvalidFormatError("LuaJIT ULEB128_33 overflow");
        }
      }
    }
    return { isNum, lo: value >>> 0 };
  }

  readUtf8(size: number): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(this.readBytes(size));
  }

  readLatin1(size: number): string {
    return new TextDecoder("latin1").decode(this.readBytes(size));
  }
}

function opcodesFor(version: number): readonly string[] {
  return version === 1 ? OPCODES_V1 : OPCODES_V2;
}

function decodeIns(word: number, names: readonly string[]): Instruction {
  const op = word & 0xff;
  return {
    op: names[op] ?? `OP_${op}`,
    a: (word >>> 8) & 0xff,
    c: (word >>> 16) & 0xff,
    b: (word >>> 24) & 0xff,
    d: (word >>> 16) & 0xffff,
  };
}

function jumpTarget(pc: number, d: number): number {
  return pc + 1 + (d - BIAS_J);
}

function signedKshort(d: number): number {
  return d > 0x7fff ? d - 0x10000 : d;
}

function bitsToNumber(lo: number, hi: number): number {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, lo, true);
  view.setUint32(4, hi, true);
  return view.getFloat64(0, true);
}

function readKnum(reader: DumpReader): number {
  const { isNum, lo } = reader.readUleb128_33();
  if (!isNum) {
    return lo | 0;
  }
  return bitsToNumber(lo, reader.readUleb128());
}

function readKtabk(reader: DumpReader): LuaValue {
  const tp = reader.readUleb128();
  if (tp >= KTAB_STR) {
    return reader.readLatin1(tp - KTAB_STR);
  }
  if (tp === KTAB_INT) {
    return reader.readUleb128() | 0;
  }
  if (tp === KTAB_NUM) {
    return bitsToNumber(reader.readUleb128(), reader.readUleb128());
  }
  if (tp === KTAB_NIL) {
    return null;
  }
  if (tp === KTAB_FALSE) {
    return false;
  }
  if (tp === KTAB_TRUE) {
    return true;
  }
  throw new InvalidFormatError(`bad LuaJIT ktab type ${tp}`);
}

function readKtab(reader: DumpReader): Extract<GcConst, { kind: "tab" }> {
  const narray = reader.readUleb128();
  const nhash = reader.readUleb128();
  const array: LuaValue[] = [];
  for (let i = 0; i < narray; i++) {
    array.push(readKtabk(reader));
  }
  const hash: Array<{ key: LuaValue; value: LuaValue }> = [];
  for (let i = 0; i < nhash; i++) {
    hash.push({ key: readKtabk(reader), value: readKtabk(reader) });
  }
  return { kind: "tab", array, hash };
}

function parseProto(
  reader: DumpReader,
  ctx: { stack: Proto[]; version: number; littleEndian: boolean; stripped: boolean },
): Proto {
  const flags = reader.readU8();
  const numparams = reader.readU8();
  const framesize = reader.readU8();
  const sizeuv = reader.readU8();
  const sizekgc = reader.readUleb128();
  const sizekn = reader.readUleb128();
  const sizebc = reader.readUleb128();
  const names = opcodesFor(ctx.version);

  if (!ctx.stripped) {
    const sizedbg = reader.readUleb128();
    if (sizedbg !== 0) {
      reader.readUleb128();
      reader.readUleb128();
    }
  }

  const ins: Instruction[] = [];
  for (let i = 0; i < sizebc; i++) {
    ins.push(decodeIns(reader.readU32(ctx.littleEndian), names));
  }

  const uv: number[] = [];
  for (let i = 0; i < sizeuv; i++) {
    uv.push(reader.readU16(ctx.littleEndian));
  }

  const kgc: GcConst[] = [];
  for (let i = 0; i < sizekgc; i++) {
    const tp = reader.readUleb128();
    if (tp >= KGC_STR) {
      kgc.push({ kind: "str", value: reader.readLatin1(tp - KGC_STR) });
      continue;
    }
    if (tp === KGC_TAB) {
      kgc.push(readKtab(reader));
      continue;
    }
    if (tp === KGC_CHILD) {
      const child = ctx.stack.pop();
      if (!child) {
        throw new InvalidFormatError("LuaJIT child prototype stack underflow");
      }
      kgc.push({ kind: "proto", proto: child });
      continue;
    }
    const lo = reader.readUleb128();
    const hi = reader.readUleb128();
    if (tp === KGC_COMPLEX) {
      reader.readUleb128();
      reader.readUleb128();
      kgc.push({ kind: "cdata", label: "complex" });
      continue;
    }
    if (tp === KGC_I64 || tp === KGC_U64) {
      kgc.push({ kind: "cdata", label: `${tp === KGC_I64 ? "i64" : "u64"}(${hi}:${lo})` });
      continue;
    }
    throw new InvalidFormatError(`bad LuaJIT kgc type ${tp}`);
  }

  const kn: number[] = [];
  for (let i = 0; i < sizekn; i++) {
    kn.push(readKnum(reader));
  }

  if (reader.remaining() > 0) {
    reader.readBytes(reader.remaining());
  }

  const proto: Proto = {
    id: 0,
    flags,
    numparams,
    framesize,
    uv,
    kgc,
    kn,
    ins,
  };
  return proto;
}

function parseDump(data: Uint8Array): Dump {
  const reader = new DumpReader(data);
  if (reader.readU8() !== ESC || reader.readU8() !== HEAD_L || reader.readU8() !== HEAD_J) {
    throw new InvalidFormatError("not a LuaJIT bytecode dump");
  }
  const version = reader.readU8();
  if (version !== 1 && version !== 2) {
    throw new InvalidFormatError(`unsupported LuaJIT dump version ${version}`);
  }
  const flags = reader.readUleb128();
  const littleEndian = (flags & FLAG_BE) === 0;
  let chunkname = "";
  if ((flags & FLAG_STRIP) === 0) {
    chunkname = reader.readUtf8(reader.readUleb128());
  }

  const ctx = {
    stack: [] as Proto[],
    version,
    littleEndian,
    stripped: (flags & FLAG_STRIP) !== 0,
  };
  while (reader.remaining() > 0) {
    if (reader.peekU8() === 0) {
      reader.readU8();
      break;
    }
    const len = reader.readUleb128();
    if (len === 0) {
      break;
    }
    const slice = reader.readBytes(len);
    const protoReader = new DumpReader(slice);
    const proto = parseProto(protoReader, ctx);
    ctx.stack.push(proto);
  }

  const root = ctx.stack.pop();
  if (!root || ctx.stack.length !== 0) {
    throw new InvalidFormatError("LuaJIT dump did not end with a single root prototype");
  }
  assignProtoIds(root);
  return { version, flags, chunkname, root };
}

/**
 * Returns true when `data` starts with a LuaJIT bytecode dump header (`ESC LJ`).
 * @param data - Bytes to inspect as `Uint8Array`.
 * @returns True if the buffer looks like a LuaJIT dump, as `boolean`.
 */
export function isLuaJitDump(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === ESC && data[1] === HEAD_L && data[2] === HEAD_J;
}

function isIdent(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !LUA_KEYWORDS.has(name);
}

function assignProtoIds(proto: Proto, next = { id: 0 }): void {
  proto.id = next.id++;
  for (const gc of proto.kgc) {
    if (gc.kind === "proto") {
      assignProtoIds(gc.proto, next);
    }
  }
}

function kgcAt(proto: Proto, index: number): GcConst | undefined {
  return proto.kgc[proto.kgc.length - 1 - index];
}

function latin1ToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function quoteLuaLong(source: string): string {
  let eq = 0;
  while (source.includes(`]${"=".repeat(eq)}]`)) {
    eq += 1;
  }
  const mark = "=".repeat(eq);
  return `[${mark}[\n${source.replace(/\n+$/, "")}\n]${mark}]`;
}

function quoteLuaLiteral(value: string): string {
  const bytes = latin1ToBytes(value);
  if (isLuaJitDump(bytes)) {
    return quoteLuaLong(decompileLuaJit(bytes));
  }
  return quoteLuaString(value);
}

function quoteLuaString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += "\\\\";
    } else if (code === 0x0a) {
      out += "\\n";
    } else if (code === 0x0d) {
      out += "\\r";
    } else if (code === 0x09) {
      out += "\\t";
    } else if (code < 32 || code >= 127) {
      out += `\\${String(code).padStart(3, "0")}`;
    } else {
      out += value[i];
    }
  }
  return `${out}"`;
}

function formatNum(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
    return String(value);
  }
  if (Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isNaN(value)) {
    return "(0/0)";
  }
  return value > 0 ? "(1/0)" : "(-1/0)";
}

function formatLuaValue(value: LuaValue): string {
  if (value === null) {
    return "nil";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return formatNum(value);
  }
  if (typeof value === "string") {
    return quoteLuaLiteral(value);
  }
  if (value.kind === "str") {
    return quoteLuaLiteral(value.value);
  }
  if (value.kind === "cdata") {
    return value.label;
  }
  if (value.kind === "proto") {
    return "function() end";
  }
  return formatTable(value);
}

function formatTable(tab: Extract<GcConst, { kind: "tab" }>): string {
  const parts: string[] = [];
  for (let i = 0; i < tab.array.length; i++) {
    parts.push(`[${i}] = ${formatLuaValue(tab.array[i])}`);
  }
  for (const entry of tab.hash) {
    const key = entry.key;
    if (typeof key === "string" && isIdent(key)) {
      parts.push(`${key} = ${formatLuaValue(entry.value)}`);
      continue;
    }
    parts.push(`[${formatLuaValue(key)}] = ${formatLuaValue(entry.value)}`);
  }
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

function priName(d: number): string {
  return d === 0 ? "nil" : d === 1 ? "false" : d === 2 ? "true" : "nil";
}

function slotName(protoId: number, slot: number): string {
  return protoId === 0 ? `v${slot}` : `f${protoId}_v${slot}`;
}

function kgcStr(proto: Proto, index: number): string {
  const gc = kgcAt(proto, index);
  if (!gc || gc.kind !== "str") {
    return `<kgc ${index}>`;
  }
  return gc.value;
}

function fieldRef(table: string, key: string): string {
  return isIdent(key) ? `${table}.${key}` : `${table}[${quoteLuaString(key)}]`;
}

function globalRef(name: string): string {
  return isIdent(name) ? name : `_G[${quoteLuaString(name)}]`;
}

function knum(proto: Proto, index: number): string {
  return formatNum(proto.kn[index] ?? 0);
}

function uvName(names: string[], index: number): string {
  return names[index] ?? `uv${index}`;
}

function argList(proto: Proto, fr2: boolean, base: number, count: number, extraMultres: boolean): string {
  const args: string[] = [];
  const start = base + 1 + (fr2 ? 1 : 0);
  for (let i = 0; i < count; i++) {
    args.push(slotName(proto.id, start + i));
  }
  if (extraMultres) {
    args.push("...");
  }
  return args.join(", ");
}

function resultList(proto: Proto, base: number, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(slotName(proto.id, base + i));
  }
  return parts.join(", ");
}

function emitFunction(proto: Proto, dump: Dump, upvalues: string[], indent: string): string {
  const fr2 = (dump.flags & FLAG_FR2) !== 0;
  const vararg = (proto.flags & 0x02) !== 0;
  const params: string[] = [];
  for (let i = 0; i < proto.numparams; i++) {
    params.push(slotName(proto.id, i));
  }
  if (vararg) {
    params.push("...");
  }

  const locals: string[] = [];
  for (let i = proto.numparams; i < proto.framesize; i++) {
    locals.push(slotName(proto.id, i));
  }

  const targets = new Set<number>();
  for (let pc = 0; pc < proto.ins.length; pc++) {
    const ins = proto.ins[pc];
    if (
      ins.op === "JMP" ||
      ins.op === "UCLO" ||
      ins.op === "FORI" ||
      ins.op === "JFORI" ||
      ins.op === "FORL" ||
      ins.op === "IFORL" ||
      ins.op === "ITERL" ||
      ins.op === "IITERL" ||
      ins.op === "LOOP" ||
      ins.op === "ILOOP" ||
      ins.op === "ISNEXT"
    ) {
      targets.add(jumpTarget(pc, ins.d));
    }
  }

  const lines: string[] = [];
  const emit = (line: string) => {
    lines.push(line.length === 0 ? "" : `${indent}${line}`);
  };

  if (locals.length > 0) {
    emit(`local ${locals.join(", ")}`);
  }

  let pc = 0;
  while (pc < proto.ins.length) {
    if (targets.has(pc)) {
      emit(`::l_${pc}::`);
    }
    const ins = proto.ins[pc];
    const a = ins.a;
    const b = ins.b;
    const c = ins.c;
    const d = ins.d;
    const va = slotName(proto.id, a);
    const vb = slotName(proto.id, b);
    const vc = slotName(proto.id, c);
    const vd = slotName(proto.id, d);

    const emitJumpIf = (cond: string, fromPc: number, jumpD: number) => {
      const target = jumpTarget(fromPc, jumpD);
      emit(`if ${cond} then goto l_${target} end`);
    };

    switch (ins.op) {
      case "KSTR":
        emit(`${va} = ${quoteLuaLiteral(kgcStr(proto, d))}`);
        break;
      case "KSHORT":
        emit(`${va} = ${signedKshort(d)}`);
        break;
      case "KNUM":
        emit(`${va} = ${knum(proto, d)}`);
        break;
      case "KPRI":
        emit(`${va} = ${priName(d)}`);
        break;
      case "KCDATA":
        emit(`${va} = ${formatLuaValue(kgcAt(proto, d) ?? { kind: "cdata", label: "cdata" })}`);
        break;
      case "KNIL":
        for (let slot = a; slot <= d; slot++) {
          emit(`${slotName(proto.id, slot)} = nil`);
        }
        break;
      case "MOV":
        emit(`${va} = ${vd}`);
        break;
      case "NOT":
        emit(`${va} = not ${vd}`);
        break;
      case "UNM":
        emit(`${va} = -${vd}`);
        break;
      case "LEN":
        emit(`${va} = #${vd}`);
        break;
      case "ADDVV":
        emit(`${va} = ${vb} + ${vc}`);
        break;
      case "SUBVV":
        emit(`${va} = ${vb} - ${vc}`);
        break;
      case "MULVV":
        emit(`${va} = ${vb} * ${vc}`);
        break;
      case "DIVVV":
        emit(`${va} = ${vb} / ${vc}`);
        break;
      case "MODVV":
        emit(`${va} = ${vb} % ${vc}`);
        break;
      case "POW":
        emit(`${va} = ${vb} ^ ${vc}`);
        break;
      case "ADDVN":
        emit(`${va} = ${vb} + ${knum(proto, c)}`);
        break;
      case "SUBVN":
        emit(`${va} = ${vb} - ${knum(proto, c)}`);
        break;
      case "MULVN":
        emit(`${va} = ${vb} * ${knum(proto, c)}`);
        break;
      case "DIVVN":
        emit(`${va} = ${vb} / ${knum(proto, c)}`);
        break;
      case "MODVN":
        emit(`${va} = ${vb} % ${knum(proto, c)}`);
        break;
      case "ADDNV":
        emit(`${va} = ${knum(proto, c)} + ${vb}`);
        break;
      case "SUBNV":
        emit(`${va} = ${knum(proto, c)} - ${vb}`);
        break;
      case "MULNV":
        emit(`${va} = ${knum(proto, c)} * ${vb}`);
        break;
      case "DIVNV":
        emit(`${va} = ${knum(proto, c)} / ${vb}`);
        break;
      case "MODNV":
        emit(`${va} = ${knum(proto, c)} % ${vb}`);
        break;
      case "CAT": {
        const parts: string[] = [];
        for (let slot = b; slot <= c; slot++) {
          parts.push(slotName(proto.id, slot));
        }
        emit(`${va} = ${parts.join(" .. ")}`);
        break;
      }
      case "UGET":
        emit(`${va} = ${uvName(upvalues, d)}`);
        break;
      case "USETV":
        emit(`${uvName(upvalues, a)} = ${vd}`);
        break;
      case "USETS":
        emit(`${uvName(upvalues, a)} = ${quoteLuaLiteral(kgcStr(proto, d))}`);
        break;
      case "USETN":
        emit(`${uvName(upvalues, a)} = ${knum(proto, d)}`);
        break;
      case "USETP":
        emit(`${uvName(upvalues, a)} = ${priName(d)}`);
        break;
      case "GGET":
        emit(`${va} = ${globalRef(kgcStr(proto, d))}`);
        break;
      case "GSET":
        emit(`${globalRef(kgcStr(proto, d))} = ${va}`);
        break;
      case "TNEW":
        emit(`${va} = {}`);
        break;
      case "TDUP": {
        const gc = kgcAt(proto, d);
        emit(`${va} = ${gc && gc.kind === "tab" ? formatTable(gc) : "{}"}`);
        break;
      }
      case "TGETV":
        emit(`${va} = ${vb}[${vc}]`);
        break;
      case "TGETS":
        emit(`${va} = ${fieldRef(vb, kgcStr(proto, c))}`);
        break;
      case "TGETB":
      case "TGETR":
        emit(`${va} = ${vb}[${c}]`);
        break;
      case "TSETV":
        emit(`${vb}[${vc}] = ${va}`);
        break;
      case "TSETS":
        emit(`${fieldRef(vb, kgcStr(proto, c))} = ${va}`);
        break;
      case "TSETB":
      case "TSETR":
        emit(`${vb}[${c}] = ${va}`);
        break;
      case "TSETM":
        emit(`-- TSETM ${va}[${knum(proto, d)}] = ...`);
        break;
      case "FNEW": {
        const gc = kgcAt(proto, d);
        if (!gc || gc.kind !== "proto") {
          emit(`${va} = function() end`);
          break;
        }
        const childUvs = gc.proto.uv.map((ref) => {
          const index = ref & 0x3fff;
          if (ref & 0x8000) {
            return slotName(proto.id, index);
          }
          return uvName(upvalues, index);
        });
        const body = emitFunction(gc.proto, dump, childUvs, `${indent}  `);
        const childVararg = (gc.proto.flags & 0x02) !== 0;
        const childParams: string[] = [];
        for (let i = 0; i < gc.proto.numparams; i++) {
          childParams.push(slotName(gc.proto.id, i));
        }
        if (childVararg) {
          childParams.push("...");
        }
        emit(`${va} = function(${childParams.join(", ")})`);
        if (body.length > 0) {
          lines.push(body);
        }
        emit("end");
        break;
      }
      case "CALL":
      case "CALLM": {
        const nresults = b === 0 ? -1 : b - 1;
        const nargs = ins.op === "CALLM" ? c : Math.max(0, c - 1);
        const call = `${va}(${argList(proto, fr2, a, nargs, ins.op === "CALLM")})`;
        if (nresults === 0) {
          emit(call);
        } else if (nresults < 0) {
          emit(`-- MULTRES ${call}`);
          emit(call);
        } else {
          emit(`${resultList(proto, a, nresults)} = ${call}`);
        }
        break;
      }
      case "CALLT":
      case "CALLMT": {
        const nargs = ins.op === "CALLMT" ? c : Math.max(0, d - 1);
        emit(`return ${va}(${argList(proto, fr2, a, nargs, ins.op === "CALLMT")})`);
        break;
      }
      case "VARG": {
        const nresults = b === 0 ? -1 : b - 1;
        if (nresults <= 0) {
          emit(`${va} = ...`);
        } else {
          emit(`${resultList(proto, a, nresults)} = ...`);
        }
        break;
      }
      case "RET0":
        emit("return");
        break;
      case "RET1":
        emit(`return ${va}`);
        break;
      case "RET": {
        const nresults = Math.max(0, d - 1);
        emit(nresults === 0 ? "return" : `return ${resultList(proto, a, nresults)}`);
        break;
      }
      case "RETM":
        emit(`return ${va}, ...`);
        break;
      case "JMP":
      case "UCLO": {
        const target = jumpTarget(pc, d);
        if (target !== pc + 1) {
          emit(`goto l_${target}`);
        }
        break;
      }
      case "LOOP":
      case "ILOOP":
      case "JLOOP": {
        const target = jumpTarget(pc, d);
        if (target !== pc + 1) {
          emit(`goto l_${target}`);
        }
        break;
      }
      case "FORI":
      case "JFORI": {
        const idx = slotName(proto.id, a);
        const stop = slotName(proto.id, a + 1);
        const step = slotName(proto.id, a + 2);
        const ext = slotName(proto.id, a + 3);
        emit(`${ext} = ${idx}`);
        emit(`if (${step} > 0 and ${ext} > ${stop}) or (${step} <= 0 and ${ext} < ${stop}) then goto l_${jumpTarget(pc, d)} end`);
        break;
      }
      case "FORL":
      case "IFORL":
      case "JFORL": {
        const idx = slotName(proto.id, a);
        const stop = slotName(proto.id, a + 1);
        const step = slotName(proto.id, a + 2);
        const ext = slotName(proto.id, a + 3);
        emit(`${ext} = ${ext} + ${step}`);
        emit(`${idx} = ${ext}`);
        emit(`if (${step} > 0 and ${ext} <= ${stop}) or (${step} <= 0 and ${ext} >= ${stop}) then goto l_${jumpTarget(pc, d)} end`);
        break;
      }
      case "ISNEXT":
        emit(`goto l_${jumpTarget(pc, d)}`);
        break;
      case "ITERC":
      case "ITERN": {
        const nresults = b === 0 ? 1 : b - 1;
        const iter = `${slotName(proto.id, a)}(${slotName(proto.id, a + 1)}, ${slotName(proto.id, a + 2)})`;
        emit(nresults <= 0 ? iter : `${resultList(proto, a + 3, nresults)} = ${iter}`);
        break;
      }
      case "ITERL":
      case "IITERL":
      case "JITERL":
        emit(`if ${slotName(proto.id, a + 3)} ~= nil then`);
        emit(`  ${slotName(proto.id, a + 2)} = ${slotName(proto.id, a + 3)}`);
        emit(`  goto l_${jumpTarget(pc, d)}`);
        emit("end");
        break;
      case "BNOT":
        emit(`${va} = bit.bnot(${vd})`);
        break;
      case "BAND":
        emit(`${va} = bit.band(${vb}, ${vc})`);
        break;
      case "BOR":
        emit(`${va} = bit.bor(${vb}, ${vc})`);
        break;
      case "BXOR":
        emit(`${va} = bit.bxor(${vb}, ${vc})`);
        break;
      case "BSHL":
        emit(`${va} = bit.lshift(${vb}, ${vc})`);
        break;
      case "BSHR":
        emit(`${va} = bit.rshift(${vb}, ${vc})`);
        break;
      case "BSAR":
        emit(`${va} = bit.arshift(${vb}, ${vc})`);
        break;
      case "ISTYPE":
      case "ISNUM":
        if (pc + 1 < proto.ins.length && proto.ins[pc + 1].op === "JMP") {
          emitJumpIf(`${va} == nil`, pc + 1, proto.ins[pc + 1].d);
          pc += 1;
        }
        break;
      default: {
        if (ins.op in COMPARE_GOTO && pc + 1 < proto.ins.length && proto.ins[pc + 1].op === "JMP") {
          const cmp = COMPARE_GOTO[ins.op as keyof typeof COMPARE_GOTO];
          const right =
            ins.op === "ISEQS" || ins.op === "ISNES"
              ? quoteLuaString(kgcStr(proto, d))
              : ins.op === "ISEQN" || ins.op === "ISNEN"
                ? knum(proto, d)
                : ins.op === "ISEQP" || ins.op === "ISNEP"
                  ? priName(d)
                  : vd;
          emitJumpIf(`${va} ${cmp} ${right}`, pc + 1, proto.ins[pc + 1].d);
          pc += 1;
          break;
        }
        if ((ins.op === "IST" || ins.op === "ISF") && pc + 1 < proto.ins.length && proto.ins[pc + 1].op === "JMP") {
          const cond = ins.op === "IST" ? `not ${vd}` : vd;
          emitJumpIf(cond, pc + 1, proto.ins[pc + 1].d);
          pc += 1;
          break;
        }
        if ((ins.op === "ISTC" || ins.op === "ISFC") && pc + 1 < proto.ins.length && proto.ins[pc + 1].op === "JMP") {
          const cond = ins.op === "ISTC" ? `not ${vd}` : vd;
          emitJumpIf(cond, pc + 1, proto.ins[pc + 1].d);
          emit(`${va} = ${vd}`);
          pc += 1;
          break;
        }
        emit(`-- ${ins.op} A=${a} B=${b} C=${c} D=${d}`);
      }
    }
    pc += 1;
  }

  if (targets.has(proto.ins.length)) {
    emit(`::l_${proto.ins.length}::`);
  }

  return lines.join("\n");
}

function extractAsciiStrings(data: Uint8Array): string[] {
  const found: string[] = [];
  let start = -1;
  for (let i = 0; i <= data.length; i++) {
    const ok = i < data.length && data[i] >= 32 && data[i] < 127;
    if (ok && start < 0) {
      start = i;
    } else if (!ok && start >= 0) {
      if (i - start >= 4) {
        found.push(new TextDecoder("latin1").decode(data.subarray(start, i)));
      }
      start = -1;
    }
  }
  return found;
}

function fallbackSource(data: Uint8Array, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const strings = extractAsciiStrings(data);
  const lines = [
    "-- Failed to decompile LuaJIT bytecode; this is a readable fallback.",
    `-- ${message}`,
  ];
  if (strings.length > 0) {
    lines.push("-- Extracted strings:");
    for (const value of strings) {
      lines.push(`--   ${quoteLuaString(value)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Decompiles a LuaJIT bytecode dump into UTF-8 Lua source.
 * On parse/decompile failure, returns a comment-only fallback that still opens as text.
 * @param data - LuaJIT dump bytes as `Uint8Array`.
 * @returns Lua source as `string`.
 */
export function decompileLuaJit(data: Uint8Array): string {
  try {
    const dump = parseDump(data);
    const body = emitFunction(dump.root, dump, [], "");
    const header = dump.chunkname ? `-- ${dump.chunkname}\n` : "";
    const source = `${header}${body}`.replace(/\n+$/, "");
    return `${source}\n`;
  } catch (error) {
    return fallbackSource(data, error);
  }
}
