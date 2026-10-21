// Translates the WGSL the filter kernels are written in (server/lib/webgpu)
// into GLSL ES 3.00, for WebGL2. Only the part of WGSL the kernels use:
// functions, let/var/const, if/for/while/switch, the usual operators,
// vectors, fixed-size arrays and the maths built-ins. Buffers become
// lookups the caller supplies (see GlslOptions), and the kernel's one write
// to its output becomes an assignment to a result variable, since a
// fragment shader writes only its own pixel.
//
// GLSL has no type inference and no implicit conversions, so this works out
// each expression's type the way WGSL does (including its untyped "abstract"
// literals, which take the type of whatever they meet) and writes every
// declaration's type and every literal in the type it ends up with.

type Scalar = 'f' | 'i' | 'u' | 'b';
// 'af' and 'ai' are WGSL's abstract float and abstract int literals.
type Kind = Scalar | 'af' | 'ai';

interface VecType {
  kind: Kind;
  // 1 for a scalar.
  n: number;
}

interface ArrayType {
  elem: VecType;
  len: number;
}

type Type = VecType | ArrayType | 'void';

type Expr =
  | { e: 'lit'; raw: string; kind: Kind; value: number }
  | { e: 'id'; name: string }
  | { e: 'call'; callee: string; type?: Type; args: Expr[] }
  | { e: 'index'; obj: Expr; idx: Expr }
  | { e: 'member'; obj: Expr; name: string }
  | { e: 'un'; op: string; x: Expr }
  | { e: 'bin'; op: string; a: Expr; b: Expr };

type Stmt =
  | { s: 'decl'; mut: 'let' | 'var' | 'const'; name: string; type?: Type; init?: Expr }
  | { s: 'assign'; op: string; lhs: Expr; rhs: Expr }
  | { s: 'incr'; op: string; lhs: Expr }
  | { s: 'expr'; x: Expr }
  | { s: 'ret'; x?: Expr }
  | { s: 'if'; cond: Expr; then: Stmt[]; else?: Stmt[] }
  | { s: 'for'; init?: Stmt; cond?: Expr; update?: Stmt; body: Stmt[] }
  | { s: 'while'; cond: Expr; body: Stmt[] }
  | { s: 'switch'; x: Expr; cases: { sel: Expr[] | null; body: Stmt[] }[] }
  | { s: 'break' }
  | { s: 'continue' }
  | { s: 'block'; body: Stmt[] };

type Decl =
  | { d: 'const'; name: string; type?: Type; init: Expr }
  | { d: 'var'; name: string; type?: Type; init?: Expr }
  | { d: 'fn'; name: string; params: { name: string; type: Type }[]; ret: Type; body: Stmt[] };

// ---- tokens ----

interface Token {
  t: 'num' | 'id' | 'op' | 'eof';
  v: string;
  pos: number;
}

const OPS = [
  '<<=',
  '>>=',
  '->',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '!',
  '~',
  '<',
  '>',
  '=',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ',',
  ';',
  ':',
  '.',
  '@',
];

const NUMBER = new RegExp(
  [
    '0[xX][0-9a-fA-F]*\\.?[0-9a-fA-F]*[pP][+-]?\\d+[fh]?', // hex float
    '0[xX][0-9a-fA-F]+[iu]?', // hex int
    '(?:\\d+\\.\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?[fh]?', // 1.5, 1., .5, 1.5e3
    '\\d+[eE][+-]?\\d+[fh]?', // 1e-3
    '\\d+[fh]', // 1f
    '\\d+[iu]?', // 1, 1u, 1i
  ].join('|'),
  'y',
);
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let pos = 0;
  while (pos < src.length) {
    const c = src[pos];
    if (/\s/.test(c)) {
      pos++;
      continue;
    }
    if (src.startsWith('//', pos)) {
      const end = src.indexOf('\n', pos);
      pos = end < 0 ? src.length : end;
      continue;
    }
    if (src.startsWith('/*', pos)) {
      const end = src.indexOf('*/', pos + 2);
      if (end < 0) throw new Error('Unclosed comment');
      pos = end + 2;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[pos + 1] ?? ''))) {
      NUMBER.lastIndex = pos;
      const m = NUMBER.exec(src);
      if (!m) throw new Error('Bad number at ' + pos);
      out.push({ t: 'num', v: m[0], pos });
      pos += m[0].length;
      continue;
    }
    IDENT.lastIndex = pos;
    const id = IDENT.exec(src);
    if (id) {
      out.push({ t: 'id', v: id[0], pos });
      pos += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, pos));
    if (!op) throw new Error("Unexpected '" + c + "' at " + pos);
    out.push({ t: 'op', v: op, pos });
    pos += op.length;
  }
  out.push({ t: 'eof', v: '', pos });
  return out;
}

// ---- literals ----

function parseHexFloat(raw: string): number {
  const m = /^0[xX]([0-9a-fA-F]*)\.?([0-9a-fA-F]*)[pP]([+-]?\d+)/.exec(raw);
  if (!m) throw new Error('Bad hex float ' + raw);
  const digits = m[1] + m[2];
  return parseInt(digits || '0', 16) * Math.pow(2, Number(m[3]) - 4 * m[2].length);
}

function literal(raw: string): { kind: Kind; value: number } {
  if (raw === 'true' || raw === 'false') return { kind: 'b', value: raw === 'true' ? 1 : 0 };
  if (/^0[xX].*[pP]/.test(raw)) {
    return { kind: /[fh]$/.test(raw) ? 'f' : 'af', value: parseHexFloat(raw) };
  }
  if (/^0[xX]/.test(raw)) {
    const value = parseInt(raw.replace(/[iu]$/, ''), 16);
    return { kind: raw.endsWith('u') ? 'u' : raw.endsWith('i') ? 'i' : 'ai', value };
  }
  if (/[.eE]/.test(raw) || /[fh]$/.test(raw)) {
    return { kind: /[fh]$/.test(raw) ? 'f' : 'af', value: parseFloat(raw) };
  }
  const value = parseInt(raw, 10);
  return { kind: raw.endsWith('u') ? 'u' : raw.endsWith('i') ? 'i' : 'ai', value };
}

// ---- types ----

const SCALARS: Record<string, Scalar> = { f32: 'f', i32: 'i', u32: 'u', bool: 'b' };
const SUFFIX: Record<string, Scalar> = { f: 'f', i: 'i', u: 'u' };

// vec3f, vec4u... (and vec3 alone, for vec3<T>).
function vectorName(name: string): { n: number; kind?: Scalar } | null {
  const m = /^vec([234])([fiu]?)$/.exec(name);
  if (!m) return null;
  return { n: Number(m[1]), kind: m[2] ? SUFFIX[m[2]] : undefined };
}

const isArray = (t: Type): t is ArrayType => typeof t === 'object' && 'elem' in t;
const isVec = (t: Type): t is VecType => typeof t === 'object' && 'kind' in t;
const isAbstract = (k: Kind) => k === 'af' || k === 'ai';

function concrete(k: Kind, want?: Scalar): Scalar {
  if (k === 'ai') return want ?? 'i';
  if (k === 'af') return 'f';
  return k;
}

// The kind two operands share, as WGSL converts abstract literals.
function unify(a: Kind, b: Kind, where: string): Kind {
  if (a === b) return a;
  if (isAbstract(a) && isAbstract(b)) return 'af';
  if (isAbstract(a)) {
    if (a === 'af' && b !== 'f') throw new Error(where + ': float literal with ' + b);
    return b;
  }
  if (isAbstract(b)) {
    if (b === 'af' && a !== 'f') throw new Error(where + ': float literal with ' + a);
    return a;
  }
  throw new Error(where + ': mixes ' + a + ' and ' + b);
}

function glslScalar(k: Scalar): string {
  return { f: 'float', i: 'int', u: 'uint', b: 'bool' }[k];
}

function glslVec(t: VecType): string {
  const k = concrete(t.kind);
  if (t.n === 1) return glslScalar(k);
  return { f: '', i: 'i', u: 'u', b: 'b' }[k] + 'vec' + t.n;
}

function typeName(t: Type): string {
  if (t === 'void') return 'void';
  if (isArray(t)) return glslVec(t.elem) + '[' + t.len + ']';
  return glslVec(t);
}

function zeroOf(t: Type): string {
  if (t === 'void') throw new Error('No zero for void');
  if (isArray(t)) {
    return typeName(t) + '(' + Array(t.len).fill(zeroOf(t.elem)).join(', ') + ')';
  }
  const k = concrete(t.kind);
  const z = { f: '0.0', i: '0', u: '0u', b: 'false' }[k];
  return t.n === 1 ? z : glslVec(t) + '(' + z + ')';
}

// ---- parser ----

class Parser {
  private p = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(o = 0): Token {
    return this.toks[Math.min(this.p + o, this.toks.length - 1)];
  }
  private next(): Token {
    return this.toks[this.p++];
  }
  private is(v: string): boolean {
    const t = this.peek();
    return (t.t === 'op' || t.t === 'id') && t.v === v;
  }
  private eat(v: string): boolean {
    if (!this.is(v)) return false;
    this.p++;
    return true;
  }
  private expect(v: string): void {
    if (!this.eat(v)) this.fail("expected '" + v + "'");
  }
  private ident(): string {
    const t = this.next();
    if (t.t !== 'id') this.fail('expected a name', t);
    return t.v;
  }
  private fail(msg: string, t = this.peek()): never {
    throw new Error(msg + " at '" + t.v + "' (" + t.pos + ')');
  }

  module(): Decl[] {
    const decls: Decl[] = [];
    while (this.peek().t !== 'eof') {
      while (this.eat('@')) {
        this.ident();
        if (this.eat('(')) this.args();
      }
      if (this.eat('const')) {
        const name = this.ident();
        const type = this.eat(':') ? this.type() : undefined;
        this.expect('=');
        decls.push({ d: 'const', name, type, init: this.expr() });
        this.expect(';');
      } else if (this.eat('var')) {
        if (this.eat('<')) {
          const space = this.ident();
          if (space !== 'private') this.fail('only var<private> is supported');
          this.expect('>');
        }
        const name = this.ident();
        const type = this.eat(':') ? this.type() : undefined;
        const init = this.eat('=') ? this.expr() : undefined;
        decls.push({ d: 'var', name, type, init });
        this.expect(';');
      } else if (this.eat('fn')) {
        const name = this.ident();
        this.expect('(');
        const params: { name: string; type: Type }[] = [];
        while (!this.eat(')')) {
          while (this.eat('@')) {
            this.ident();
            if (this.eat('(')) this.args();
          }
          const pname = this.ident();
          this.expect(':');
          params.push({ name: pname, type: this.type() });
          this.eat(',');
        }
        const ret = this.eat('->') ? this.type() : 'void';
        decls.push({ d: 'fn', name, params, ret, body: this.block() });
      } else {
        this.fail('expected a declaration');
      }
    }
    return decls;
  }

  type(): Type {
    const name = this.ident();
    if (SCALARS[name]) return { kind: SCALARS[name], n: 1 };
    const vec = vectorName(name);
    if (vec) {
      if (vec.kind) return { kind: vec.kind, n: vec.n };
      this.expect('<');
      const elem = this.type();
      this.expect('>');
      if (!isVec(elem) || elem.n !== 1) this.fail('bad vector element');
      return { kind: elem.kind, n: vec.n };
    }
    if (name === 'array') {
      this.expect('<');
      const elem = this.type();
      this.expect(',');
      const len = this.next();
      if (len.t !== 'num') this.fail('array length must be a number', len);
      this.expect('>');
      if (!isVec(elem)) this.fail('arrays of arrays are not supported');
      return { elem, len: literal(len.v).value };
    }
    this.fail('unsupported type ' + name);
  }

  block(): Stmt[] {
    this.expect('{');
    const out: Stmt[] = [];
    while (!this.eat('}')) out.push(this.stmt());
    return out;
  }

  stmt(): Stmt {
    if (this.is('{')) return { s: 'block', body: this.block() };
    if (this.eat('return')) {
      if (this.eat(';')) return { s: 'ret' };
      const x = this.expr();
      this.expect(';');
      return { s: 'ret', x };
    }
    if (this.eat('if')) return this.ifRest();
    if (this.eat('for')) {
      this.expect('(');
      const init = this.is(';') ? undefined : this.simple();
      this.expect(';');
      const cond = this.is(';') ? undefined : this.expr();
      this.expect(';');
      const update = this.is(')') ? undefined : this.simple();
      this.expect(')');
      return { s: 'for', init, cond, update, body: this.block() };
    }
    if (this.eat('while')) {
      const cond = this.expr();
      return { s: 'while', cond, body: this.block() };
    }
    if (this.eat('switch')) {
      const x = this.expr();
      this.expect('{');
      const cases: { sel: Expr[] | null; body: Stmt[] }[] = [];
      while (!this.eat('}')) {
        let sel: Expr[] | null;
        if (this.eat('default')) {
          sel = null;
        } else {
          this.expect('case');
          sel = [];
          do {
            if (this.eat('default')) sel = null;
            else sel!.push(this.expr());
          } while (sel && this.eat(','));
        }
        this.eat(':');
        cases.push({ sel, body: this.block() });
      }
      return { s: 'switch', x, cases };
    }
    if (this.eat('break')) {
      this.expect(';');
      return { s: 'break' };
    }
    if (this.eat('continue')) {
      this.expect(';');
      return { s: 'continue' };
    }
    const s = this.simple();
    this.expect(';');
    return s;
  }

  private ifRest(): Stmt {
    const cond = this.expr();
    const then = this.block();
    if (!this.eat('else')) return { s: 'if', cond, then };
    if (this.eat('if')) return { s: 'if', cond, then, else: [this.ifRest()] };
    return { s: 'if', cond, then, else: this.block() };
  }

  // A statement that can go in a for loop's header.
  private simple(): Stmt {
    for (const mut of ['let', 'var', 'const'] as const) {
      if (this.eat(mut)) {
        const name = this.ident();
        const type = this.eat(':') ? this.type() : undefined;
        const init = this.eat('=') ? this.expr() : undefined;
        return { s: 'decl', mut, name, type, init };
      }
    }
    const lhs = this.expr();
    if (this.eat('++')) return { s: 'incr', op: '++', lhs };
    if (this.eat('--')) return { s: 'incr', op: '--', lhs };
    const t = this.peek();
    if (t.t === 'op' && /^(=|[-+*/%&|^]=|<<=|>>=)$/.test(t.v)) {
      this.next();
      return { s: 'assign', op: t.v, lhs, rhs: this.expr() };
    }
    return { s: 'expr', x: lhs };
  }

  private args(): Expr[] {
    const out: Expr[] = [];
    while (!this.eat(')')) {
      out.push(this.expr());
      if (!this.eat(',') && !this.is(')')) this.fail("expected ',' or ')'");
    }
    return out;
  }

  expr(): Expr {
    return this.binary(0);
  }

  private static readonly LEVELS: string[][] = [
    ['||'],
    ['&&'],
    ['|'],
    ['^'],
    ['&'],
    ['==', '!='],
    ['<', '>', '<=', '>='],
    ['<<', '>>'],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  private binary(level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.unary();
    let a = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || !Parser.LEVELS[level].includes(t.v)) return a;
      this.next();
      a = { e: 'bin', op: t.v, a, b: this.binary(level + 1) };
    }
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.t === 'op' && ['-', '!', '~'].includes(t.v)) {
      this.next();
      return { e: 'un', op: t.v, x: this.unary() };
    }
    if (t.t === 'op' && (t.v === '&' || t.v === '*')) this.fail('pointers are not supported');
    return this.postfix(this.primary());
  }

  private postfix(x: Expr): Expr {
    for (;;) {
      if (this.eat('[')) {
        const idx = this.expr();
        this.expect(']');
        x = { e: 'index', obj: x, idx };
      } else if (this.eat('.')) {
        x = { e: 'member', obj: x, name: this.ident() };
      } else {
        return x;
      }
    }
  }

  private primary(): Expr {
    const t = this.next();
    if (t.t === 'num') return { e: 'lit', raw: t.v, ...literal(t.v) };
    if (t.t === 'op' && t.v === '(') {
      const x = this.expr();
      this.expect(')');
      return x;
    }
    if (t.t !== 'id') this.fail('expected an expression', t);
    if (t.v === 'true' || t.v === 'false') return { e: 'lit', raw: t.v, ...literal(t.v) };
    // array<f32, 4>(...) and vec3<f32>(...)
    if ((t.v === 'array' || vectorName(t.v)) && this.is('<')) {
      this.p--;
      const type = this.type();
      this.expect('(');
      return { e: 'call', callee: t.v, type, args: this.args() };
    }
    if (this.eat('(')) return { e: 'call', callee: t.v, args: this.args() };
    return { e: 'id', name: t.v };
  }
}

export function parseModule(src: string): Decl[] {
  return new Parser(tokenize(src)).module();
}

// ---- GLSL ----

// GLSL's keywords and built-in names, which WGSL code may use as names.
const RESERVED = new Set(
  (
    'attribute const uniform varying layout centroid flat smooth break continue do for while ' +
    'switch case default if else in out inout float int void bool true false invariant discard ' +
    'return mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 vec2 ' +
    'vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 uint uvec2 uvec3 uvec4 lowp mediump highp ' +
    'precision sampler2D sampler3D samplerCube sampler2DShadow struct coherent volatile ' +
    'restrict readonly writeonly resource atomic_uint noperspective patch sample subroutine ' +
    'common partition active asm class union enum typedef template this goto inline noinline ' +
    'public static extern external interface long short double half fixed unsigned superp ' +
    'input output hvec2 hvec3 hvec4 dvec2 dvec3 dvec4 fvec2 fvec3 fvec4 filter sizeof cast ' +
    'namespace using radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh ' +
    'atanh pow exp log exp2 log2 sqrt inversesqrt abs sign floor trunc round roundEven ceil ' +
    'fract mod min max clamp mix step smoothstep isnan isinf floatBitsToInt floatBitsToUint ' +
    'intBitsToFloat uintBitsToFloat packSnorm2x16 unpackSnorm2x16 packUnorm2x16 ' +
    'unpackUnorm2x16 packHalf2x16 unpackHalf2x16 length distance dot cross normalize ' +
    'faceforward reflect refract matrixCompMult outerProduct transpose determinant inverse ' +
    'lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not texture ' +
    'textureSize textureLod textureOffset texelFetch texelFetchOffset textureProj ' +
    'textureGrad dFdx dFdy fwidth main'
  ).split(' '),
);

// A WGSL name as it can be in GLSL.
export const glslName = (name: string) => (RESERVED.has(name) ? name + '_w' : name);

// WGSL built-ins with the same name and meaning in GLSL.
const SAME = new Set(
  (
    'abs floor ceil trunc fract sqrt exp exp2 log log2 pow sin cos tan asin acos atan sinh ' +
    'cosh tanh min max clamp mix step smoothstep length distance dot cross normalize sign ' +
    'all any radians degrees reflect'
  ).split(' '),
);
const RENAMED: Record<string, string> = {
  round: 'roundEven',
  atan2: 'atan',
  inverseSqrt: 'inversesqrt',
  unpack4x8unorm: '_unpack4x8unorm',
  pack4x8unorm: '_pack4x8unorm',
};
const TO_SCALAR = new Set(['length', 'distance', 'dot']);

// Helpers for the built-ins GLSL ES 3.00 lacks.
export const GLSL_PRELUDE = `
vec4 _unpack4x8unorm(uint p) {
  return vec4(uvec4(p, p >> 8u, p >> 16u, p >> 24u) & 255u) / 255.0;
}
uint _pack4x8unorm(vec4 c) {
  uvec4 v = uvec4(roundEven(clamp(c, 0.0, 1.0) * 255.0));
  return v.x | (v.y << 8u) | (v.z << 16u) | (v.w << 24u);
}
`;

// How the code reads one buffer: `name[i]` becomes `call(i)`, of type type.
export interface BufferRead {
  call: string;
  type: { kind: Scalar; n: number };
}

export interface GlslOptions {
  // Names defined outside the WGSL: buffers, by how they're read...
  buffers: Record<string, BufferRead>;
  // ...uniform scalars and other globals, by type...
  globals: Record<string, { kind: Scalar; n: number }>;
  // ...and the one buffer the kernel writes: `name[index] = v;` becomes
  // `assign(v)`, with v as want. index is the WGSL index expression it must
  // be written with (the pixel the fragment is for).
  output?: { name: string; index: string; want: { kind: Scalar; n: number }; assign: string };
  // The function whose early returns are checked (see GlslResult.maySkip).
  entry?: string;
}

export interface GlslResult {
  code: string;
  // Whether the entry function can return before writing its output.
  maySkip: boolean;
}

interface Binding {
  type: Type;
  glsl: string;
}

// A canonical spelling of an expression, to compare index expressions.
function canon(x: Expr): string {
  switch (x.e) {
    case 'lit':
      return x.raw;
    case 'id':
      return x.name;
    case 'call':
      return x.callee + '(' + x.args.map(canon).join(',') + ')';
    case 'index':
      return canon(x.obj) + '[' + canon(x.idx) + ']';
    case 'member':
      return canon(x.obj) + '.' + x.name;
    case 'un':
      return '(' + x.op + canon(x.x) + ')';
    case 'bin':
      return '(' + canon(x.a) + x.op + canon(x.b) + ')';
  }
}

export function canonical(src: string): string {
  return canon(new Parser(tokenize(src)).expr());
}

const CMP: Record<string, string> = {
  '<': 'lessThan',
  '>': 'greaterThan',
  '<=': 'lessThanEqual',
  '>=': 'greaterThanEqual',
  '==': 'equal',
  '!=': 'notEqual',
};

class Emitter {
  private scopes: Map<string, Binding>[] = [];
  private fns = new Map<string, { params: Type[]; ret: Type; glsl: string }>();
  private ret: Type = 'void';
  // While emitting the entry function: whether every path so far wrote.
  private inEntry = false;
  private written = false;
  maySkip = false;

  constructor(private readonly opts: GlslOptions) {
    const globals = new Map<string, Binding>();
    for (const [name, t] of Object.entries(opts.globals)) {
      globals.set(name, { type: t, glsl: glslName(name) });
    }
    this.scopes.push(globals);
  }

  private lookup(name: string): Binding {
    for (let s = this.scopes.length - 1; s >= 0; s--) {
      const b = this.scopes[s].get(name);
      if (b) return b;
    }
    throw new Error('Unknown name ' + name);
  }

  private declare(name: string, type: Type): string {
    const glsl = glslName(name);
    this.scopes[this.scopes.length - 1].set(name, { type, glsl });
    return glsl;
  }

  // ---- types ----

  typeOf(x: Expr): Type {
    switch (x.e) {
      case 'lit':
        return { kind: x.kind, n: 1 };
      case 'id':
        if (this.opts.buffers[x.name])
          throw new Error('Buffer ' + x.name + ' used without an index');
        return this.lookup(x.name).type;
      case 'index': {
        if (x.obj.e === 'id' && this.opts.buffers[x.obj.name]) {
          return this.opts.buffers[x.obj.name].type;
        }
        if (x.obj.e === 'id' && this.opts.output?.name === x.obj.name) {
          throw new Error('The kernel reads its output buffer ' + x.obj.name);
        }
        const t = this.typeOf(x.obj);
        if (isArray(t)) return t.elem;
        if (isVec(t) && t.n > 1) return { kind: t.kind, n: 1 };
        throw new Error('Indexing a non-array: ' + canon(x));
      }
      case 'member': {
        const t = this.typeOf(x.obj);
        if (!isVec(t) || !/^([xyzw]{1,4}|[rgba]{1,4})$/.test(x.name)) {
          throw new Error('Unsupported member .' + x.name);
        }
        return { kind: t.kind, n: x.name.length };
      }
      case 'un': {
        const t = this.typeOf(x.x);
        if (x.op === '!') return { kind: 'b', n: (t as VecType).n };
        return t;
      }
      case 'bin':
        return this.binType(x);
      case 'call':
        return this.callType(x);
    }
  }

  private binType(x: Extract<Expr, { e: 'bin' }>): VecType {
    const a = this.typeOf(x.a);
    const b = this.typeOf(x.b);
    if (!isVec(a) || !isVec(b)) throw new Error('Operator ' + x.op + ' on arrays');
    const n = Math.max(a.n, b.n);
    if (CMP[x.op]) {
      unify(a.kind, b.kind, canon(x));
      return { kind: 'b', n };
    }
    if (x.op === '&&' || x.op === '||') return { kind: 'b', n: 1 };
    if (x.op === '<<' || x.op === '>>') return a;
    return { kind: unify(a.kind, b.kind, canon(x)), n };
  }

  private callType(x: Extract<Expr, { e: 'call' }>): Type {
    if (x.type) return x.type;
    if (SCALARS[x.callee]) return { kind: SCALARS[x.callee], n: 1 };
    const vec = vectorName(x.callee);
    if (vec) {
      if (!vec.kind) throw new Error(x.callee + '(...) needs its element type');
      return { kind: vec.kind, n: vec.n };
    }
    const fn = this.fns.get(x.callee);
    if (fn) return fn.ret;
    const args = x.args.map((a) => this.typeOf(a)) as VecType[];
    if (x.callee === 'select') {
      const t = this.typeOf(x.args[0]) as VecType;
      const f = this.typeOf(x.args[1]) as VecType;
      return { kind: unify(t.kind, f.kind, canon(x)), n: Math.max(t.n, f.n) };
    }
    if (x.callee === 'unpack4x8unorm') return { kind: 'f', n: 4 };
    if (x.callee === 'pack4x8unorm') return { kind: 'u', n: 1 };
    if (x.callee === 'all' || x.callee === 'any') return { kind: 'b', n: 1 };
    if (SAME.has(x.callee) || RENAMED[x.callee]) {
      let kind: Kind = args[0].kind;
      for (const a of args.slice(1)) kind = unify(kind, a.kind, canon(x));
      const n = TO_SCALAR.has(x.callee) ? 1 : Math.max(...args.map((a) => a.n));
      return { kind, n };
    }
    throw new Error('Unsupported function ' + x.callee);
  }

  // ---- expressions ----

  private lit(x: Extract<Expr, { e: 'lit' }>, want?: Scalar): string {
    const k = concrete(x.kind, want);
    if (k === 'b') return x.value ? 'true' : 'false';
    if (k === 'f') {
      if (x.kind === 'af' || x.kind === 'f') {
        if (!/^0[xX]/.test(x.raw)) {
          const s = x.raw.replace(/[fh]$/, '');
          return /[.eE]/.test(s) ? s : s + '.0';
        }
      }
      const s = String(x.value);
      return /[.e]/.test(s) ? s : s + '.0';
    }
    if (x.kind === 'af' || x.kind === 'f')
      throw new Error('Float literal ' + x.raw + ' as an integer');
    const hex = /^0[xX]/.test(x.raw);
    const digits = hex ? x.raw.replace(/[iu]$/, '') : String(x.value);
    return k === 'u' ? digits + 'u' : digits;
  }

  // want: the scalar kind abstract literals in x should take.
  emit(x: Expr, want?: Scalar): string {
    switch (x.e) {
      case 'lit':
        return this.lit(x, want);
      case 'id':
        return this.lookup(x.name).glsl;
      case 'index': {
        if (x.obj.e === 'id' && this.opts.buffers[x.obj.name]) {
          return this.opts.buffers[x.obj.name].call + '(' + this.intIndex(x.idx) + ')';
        }
        this.typeOf(x);
        return this.emit(x.obj, want) + '[' + this.intIndex(x.idx) + ']';
      }
      case 'member':
        return this.emit(x.obj, want) + '.' + x.name;
      case 'un': {
        const t = this.typeOf(x.x) as VecType;
        if (x.op === '!' && t.n > 1) return 'not(' + this.emit(x.x) + ')';
        return '(' + x.op + this.emit(x.x, want) + ')';
      }
      case 'bin':
        return this.bin(x, want);
      case 'call':
        return this.call(x, want);
    }
  }

  // An index, as GLSL's int.
  private intIndex(x: Expr): string {
    const t = this.typeOf(x) as VecType;
    const s = this.emit(x, 'i');
    return concrete(t.kind) === 'u' ? 'int(' + s + ')' : s;
  }

  private bin(x: Extract<Expr, { e: 'bin' }>, want?: Scalar): string {
    const a = this.typeOf(x.a) as VecType;
    const b = this.typeOf(x.b) as VecType;
    if (x.op === '&&' || x.op === '||') {
      return '(' + this.emit(x.a) + ' ' + x.op + ' ' + this.emit(x.b) + ')';
    }
    if (x.op === '<<' || x.op === '>>') {
      return '(' + this.emit(x.a, want) + ' ' + x.op + ' ' + this.emit(x.b) + ')';
    }
    const shared = unify(a.kind, b.kind, canon(x));
    if (CMP[x.op]) {
      const k = concrete(shared);
      const sa = this.emit(x.a, k);
      const sb = this.emit(x.b, k);
      if (Math.max(a.n, b.n) > 1) return CMP[x.op] + '(' + sa + ', ' + sb + ')';
      return '(' + sa + ' ' + x.op + ' ' + sb + ')';
    }
    const k = isAbstract(shared) ? (want ?? concrete(shared)) : concrete(shared);
    const sa = this.emit(x.a, k);
    const sb = this.emit(x.b, k);
    if ((x.op === '&' || x.op === '|' || x.op === '^') && shared === 'b') {
      if (Math.max(a.n, b.n) > 1) throw new Error('Bitwise operators on bool vectors');
      return '(' + sa + ' ' + x.op + x.op + ' ' + sb + ')';
    }
    if (x.op === '%' && concrete(k) === 'f') {
      // WGSL's float remainder truncates, as C's fmod; GLSL's mod floors.
      return '(' + sa + ' - ' + sb + ' * trunc(' + sa + ' / ' + sb + '))';
    }
    return '(' + sa + ' ' + x.op + ' ' + sb + ')';
  }

  private call(x: Extract<Expr, { e: 'call' }>, want?: Scalar): string {
    const t = this.typeOf(x);
    // Constructors and conversions.
    if (x.type || SCALARS[x.callee] || vectorName(x.callee)) {
      if (isArray(t)) {
        const k = concrete(t.elem.kind);
        return typeName(t) + '(' + x.args.map((a) => this.emit(a, k)).join(', ') + ')';
      }
      const vt = t as VecType;
      if (x.args.length === 0) return zeroOf(vt);
      const k = concrete(vt.kind);
      return glslVec(vt) + '(' + x.args.map((a) => this.emit(a, k)).join(', ') + ')';
    }
    const fn = this.fns.get(x.callee);
    if (fn) {
      const args = x.args.map((a, i) => {
        const p = fn.params[i];
        return this.emit(a, isVec(p) ? concrete(p.kind) : undefined);
      });
      return fn.glsl + '(' + args.join(', ') + ')';
    }
    if (x.callee === 'select') {
      // select(f, t, cond): t where cond holds.
      const vt = t as VecType;
      const k = isAbstract(vt.kind) ? (want ?? concrete(vt.kind)) : concrete(vt.kind);
      const f = this.emit(x.args[0], k);
      const tt = this.emit(x.args[1], k);
      const c = this.typeOf(x.args[2]) as VecType;
      const cs = this.emit(x.args[2]);
      if (c.n === 1) return '((' + cs + ') ? (' + tt + ') : (' + f + '))';
      if (k === 'f') return 'mix(' + f + ', ' + tt + ', ' + cs + ')';
      const parts = 'xyzw'
        .slice(0, vt.n)
        .split('')
        .map((m) => '(' + cs + ').' + m + ' ? (' + tt + ').' + m + ' : (' + f + ').' + m);
      return glslVec(vt) + '(' + parts.join(', ') + ')';
    }
    const vt = t as VecType;
    const k = isAbstract(vt.kind) ? (want ?? concrete(vt.kind)) : concrete(vt.kind);
    // The arguments share a kind (clamp, min...); dot and length take floats.
    const args = x.args.map((a) => {
      const at = this.typeOf(a) as VecType;
      return this.emit(a, isAbstract(at.kind) ? (TO_SCALAR.has(x.callee) ? 'f' : k) : undefined);
    });
    const name = RENAMED[x.callee] ?? x.callee;
    // GLSL compilers may rearrange float maths, so a value WGSL works out
    // as exactly 0 (1 - c - k for the brightest channel, say) can come out
    // a hair below, and its square root would be NaN.
    if (name === 'sqrt') return 'sqrt(max(' + args[0] + ', 0.0))';
    return name + '(' + args.join(', ') + ')';
  }

  // ---- statements ----

  private stmts(list: Stmt[], indent: string): string {
    this.scopes.push(new Map());
    const saved = this.written;
    const out = list.map((s) => this.stmt(s, indent)).join('');
    this.scopes.pop();
    // A write in a nested block only counts there.
    this.written = saved;
    return out;
  }

  private declType(type: Type | undefined, init: Expr | undefined, what: string): Type {
    if (type) return type;
    if (!init) throw new Error(what + ' needs a type or a value');
    const t = this.typeOf(init);
    if (isVec(t)) return { kind: concrete(t.kind), n: t.n };
    return t;
  }

  private decl(s: Extract<Stmt, { s: 'decl' }>): string {
    const type = this.declType(s.type, s.init, s.name);
    let value: string;
    if (s.init) {
      const k = isVec(type)
        ? concrete(type.kind)
        : isArray(type)
          ? concrete(type.elem.kind)
          : undefined;
      value = this.emit(s.init, k);
    } else {
      value = zeroOf(type);
    }
    const name = this.declare(s.name, type);
    if (isArray(type)) return glslVec(type.elem) + ' ' + name + '[' + type.len + '] = ' + value;
    return typeName(type) + ' ' + name + ' = ' + value;
  }

  private assign(s: Extract<Stmt, { s: 'assign' }>): string {
    const out = this.opts.output;
    if (s.lhs.e === 'index' && s.lhs.obj.e === 'id' && out && s.lhs.obj.name === out.name) {
      if (s.op !== '=') throw new Error('The kernel updates its output with ' + s.op);
      if (canon(s.lhs.idx) !== canonical(out.index)) {
        throw new Error(
          'The kernel writes ' + out.name + '[' + canon(s.lhs.idx) + '], not its own element',
        );
      }
      this.written = true;
      const rhs = this.emit(s.rhs, out.want.kind);
      return out.assign.replace('$', rhs);
    }
    if (s.lhs.e === 'index' && s.lhs.obj.e === 'id' && this.opts.buffers[s.lhs.obj.name]) {
      throw new Error('The kernel writes to ' + s.lhs.obj.name + ', which it only reads');
    }
    const t = this.typeOf(s.lhs) as VecType;
    const k = concrete(t.kind);
    const rhsWant = s.op === '<<=' || s.op === '>>=' ? undefined : k;
    return this.emit(s.lhs) + ' ' + s.op + ' ' + this.emit(s.rhs, rhsWant);
  }

  // A statement for a for loop's header, without its semicolon.
  private simple(s: Stmt): string {
    switch (s.s) {
      case 'decl':
        return this.decl(s);
      case 'assign':
        return this.assign(s);
      case 'incr':
        return this.emit(s.lhs) + s.op;
      case 'expr':
        return this.emit(s.x);
      default:
        throw new Error('Unsupported statement in a for loop');
    }
  }

  private stmt(s: Stmt, indent: string): string {
    const inner = indent + '  ';
    switch (s.s) {
      case 'decl':
      case 'assign':
      case 'incr':
      case 'expr':
        return indent + this.simple(s) + ';\n';
      case 'ret': {
        if (this.inEntry && !this.written) this.maySkip = true;
        if (!s.x) return indent + 'return;\n';
        const k = isVec(this.ret) ? concrete(this.ret.kind) : undefined;
        return indent + 'return ' + this.emit(s.x, k) + ';\n';
      }
      case 'if': {
        let out =
          indent + 'if (' + this.emit(s.cond) + ') {\n' + this.stmts(s.then, inner) + indent + '}';
        if (s.else) out += ' else {\n' + this.stmts(s.else, inner) + indent + '}';
        return out + '\n';
      }
      case 'for': {
        const unrolled = this.unroll(s, indent);
        if (unrolled !== null) return unrolled;
        this.scopes.push(new Map());
        const init = s.init ? this.simple(s.init) : '';
        const cond = s.cond ? this.emit(s.cond) : '';
        const update = s.update ? this.simple(s.update) : '';
        const body = this.stmts(s.body, inner);
        this.scopes.pop();
        return (
          indent + 'for (' + init + '; ' + cond + '; ' + update + ') {\n' + body + indent + '}\n'
        );
      }
      case 'while':
        return (
          indent +
          'while (' +
          this.emit(s.cond) +
          ') {\n' +
          this.stmts(s.body, inner) +
          indent +
          '}\n'
        );
      case 'switch': {
        const xt = this.typeOf(s.x) as VecType;
        const k = concrete(xt.kind);
        let out = indent + 'switch (' + this.emit(s.x, k) + ') {\n';
        for (const c of s.cases) {
          const labels = c.sel
            ? c.sel.map((e) => 'case ' + this.emit(e, k) + ':').join(' ')
            : 'default:';
          out += inner + labels + ' {\n' + this.stmts(c.body, inner + '  ') + inner + '} break;\n';
        }
        return out + indent + '}\n';
      }
      case 'break':
        return indent + 'break;\n';
      case 'continue':
        return indent + 'continue;\n';
      case 'block':
        return indent + '{\n' + this.stmts(s.body, inner) + indent + '}\n';
    }
  }

  // A loop over a few constant indices (for (var n = 0; n < 8; n++)),
  // written out once per index, with the index a constant, so the arrays it
  // indexes can stay in registers: some GLSL compilers keep an array
  // indexed by a variable in slow memory. Each copy is a do-while(false),
  // so continue still ends just that iteration. Not for loops with a break
  // anywhere in them, or that change their index.
  private unroll(s: Extract<Stmt, { s: 'for' }>, indent: string): string | null {
    const init = s.init;
    const cond = s.cond;
    const up = s.update;
    if (!init || init.s !== 'decl' || init.init?.e !== 'lit') return null;
    const name = init.name;
    const isIndex = (x: Expr) => x.e === 'id' && x.name === name;
    if (!cond || cond.e !== 'bin' || cond.op !== '<' || !isIndex(cond.a) || cond.b.e !== 'lit') {
      return null;
    }
    if (!up || up.s !== 'incr' || up.op !== '++' || !isIndex(up.lhs)) return null;
    const from = init.init.value;
    const to = cond.b.value;
    if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from || to - from > 8) {
      return null;
    }
    if (Emitter.breaksOrSets(s.body, name)) return null;
    const type = this.declType(init.type, init.init, name) as VecType;
    const kind = init.init.kind;
    const inner = indent + '  ';
    let out = '';
    for (let v = from; v < to; v++) {
      this.scopes.push(new Map());
      const glsl = this.declare(name, type);
      const value = this.emit({ e: 'lit', raw: String(v), kind, value: v }, concrete(type.kind));
      const body = this.stmts(s.body, inner + '  ');
      this.scopes.pop();
      out +=
        indent +
        '{\n' +
        inner +
        'const ' +
        typeName(type) +
        ' ' +
        glsl +
        ' = ' +
        value +
        ';\n' +
        inner +
        'do {\n' +
        body +
        inner +
        '} while (false);\n' +
        indent +
        '}\n';
    }
    return out;
  }

  // Whether statements break anywhere, or set name.
  private static breaksOrSets(list: Stmt[], name: string): boolean {
    return list.some((s) => {
      switch (s.s) {
        case 'break':
          return true;
        case 'assign':
        case 'incr':
          return s.lhs.e === 'id' && s.lhs.name === name;
        case 'decl':
          return s.name === name;
        case 'if':
          return Emitter.breaksOrSets(s.then, name) || Emitter.breaksOrSets(s.else ?? [], name);
        case 'block':
        case 'while':
          return Emitter.breaksOrSets(s.body, name);
        case 'for':
          return Emitter.breaksOrSets(
            [...(s.init ? [s.init] : []), ...(s.update ? [s.update] : []), ...s.body],
            name,
          );
        case 'switch':
          return s.cases.some((c) => Emitter.breaksOrSets(c.body, name));
        default:
          return false;
      }
    });
  }

  // ---- declarations ----

  module(decls: Decl[]): string {
    const out: string[] = [];
    // Prototypes first: WGSL functions can be used before they're defined.
    for (const d of decls) {
      if (d.d !== 'fn') continue;
      const glsl = glslName(d.name);
      this.fns.set(d.name, { params: d.params.map((p) => p.type), ret: d.ret, glsl });
      out.push(
        typeName(d.ret) + ' ' + glsl + '(' + d.params.map((p) => this.param(p)).join(', ') + ');',
      );
    }
    for (const d of decls) {
      if (d.d === 'const' || d.d === 'var') {
        const type = this.declType(d.type, d.init, d.name);
        const k = isVec(type)
          ? concrete(type.kind)
          : isArray(type)
            ? concrete(type.elem.kind)
            : undefined;
        const value = d.init ? this.emit(d.init, k) : zeroOf(type);
        const name = this.declare(d.name, type);
        const prefix = d.d === 'const' ? 'const ' : '';
        if (isArray(type))
          out.push(
            prefix + glslVec(type.elem) + ' ' + name + '[' + type.len + '] = ' + value + ';',
          );
        else out.push(prefix + typeName(type) + ' ' + name + ' = ' + value + ';');
        continue;
      }
      this.scopes.push(new Map());
      const params = d.params.map((p) => {
        this.declare(p.name, p.type);
        return this.param(p);
      });
      this.ret = d.ret;
      this.inEntry = d.name === this.opts.entry;
      this.written = false;
      const body = this.stmts(d.body, '  ');
      this.inEntry = false;
      this.scopes.pop();
      out.push(
        typeName(d.ret) + ' ' + glslName(d.name) + '(' + params.join(', ') + ') {\n' + body + '}',
      );
    }
    return out.join('\n');
  }

  private param(p: { name: string; type: Type }): string {
    if (isArray(p.type))
      return glslVec(p.type.elem) + ' ' + glslName(p.name) + '[' + p.type.len + ']';
    return typeName(p.type) + ' ' + glslName(p.name);
  }
}

// Translates a WGSL module (no bindings or entry point attributes; those are
// the caller's) into GLSL declarations.
export function wgslToGlsl(src: string, opts: GlslOptions): GlslResult {
  const emitter = new Emitter(opts);
  const code = emitter.module(parseModule(src));
  return { code, maySkip: emitter.maySkip };
}
