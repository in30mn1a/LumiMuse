/**
 * 预设脚本在独立 QuickJS 解释器中运行，只通过 JSON 交换数据。
 * 不向解释器注入宿主对象或回调；构建、实际调用、Promise 作业和序列化共享执行期限。
 * 函数闭包存活到 scope.dispose()，独立调用者也可主动释放返回值。
 *
 * 脚本失控时分两层兜底：栈和内存限额让绝大多数情况在解释器内变成普通脚本错误；
 * 仍然穿透到宿主的故障（WASM 调用链耗尽 V8 栈等）会破坏整个模块，只隔离出错的上下文，
 * 下次 initializeSandbox 换新模块。
 */

import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';

const DEFAULT_TIMEOUT_MS = 2000;
const TIMEOUT_MESSAGE = '预设脚本执行超时';
/**
 * 实测上限：256KB 时解析约 2 万层 JSON 仍会先耗尽 V8 栈，128KB 时干净报错，
 * 且可递归约 700 层、解析 5000 层 JSON。
 */
const MAX_STACK_BYTES = 128 * 1024;
/**
 * WASM 内存上限随输入增长（真实预设处理聊天历史约占 24 字节/字符），
 * 否则固定上限等于给聊天历史长度加了 cap。超限只让脚本失败并走既有回退。
 */
const BASE_MEMORY_CEILING_BYTES = 256 * 1024 * 1024;
const MEMORY_BYTES_PER_INPUT_CHAR = 32;
const MAX_MEMORY_CEILING_BYTES = 2 ** 31 - 1;
/** WASM 线性内存只增不减；高水位超过此值时换新模块归还内存。 */
const RECYCLE_WASM_BYTES = 512 * 1024 * 1024;
const WASM_PAGE_BYTES = 65536;

let quickJS: QuickJSWASMModule | undefined;
let moduleTainted = false;
/** 解释器调用都是同步的，进入调用时设置一次，对同一时刻的所有模块都准确。 */
let memoryCeiling = BASE_MEMORY_CEILING_BYTES;

/**
 * 在增长线性内存的入口限额。runtime.setMemoryLimit 在这个构建里实测无效（设 8MB 仍能分配到 2GB）；
 * 增长被拒后解释器内 malloc 返回空，脚本得到普通的 out of memory 错误。
 */
function guardMemoryGrowth(wasmModule: QuickJSWASMModule): void {
  const memory = wasmModule.getWasmMemory();
  const grow = memory.grow.bind(memory);
  memory.grow = (pages: number) => {
    if (memory.buffer.byteLength + pages * WASM_PAGE_BYTES > memoryCeiling) {
      throw new RangeError('预设脚本内存超限');
    }
    return grow(pages);
  };
}

export async function initializeSandbox(): Promise<void> {
  if (quickJS && !moduleTainted && quickJS.getWasmMemory().buffer.byteLength <= RECYCLE_WASM_BYTES) return;
  // 进行中的上下文各自持有旧模块，不受替换影响。
  const wasmModule = await newQuickJSWASMModule();
  guardMemoryGrowth(wasmModule);
  quickJS = wasmModule;
  moduleTainted = false;
}

/** 穿透到宿主的栈耗尽或 WASM 断言：解释器状态已不可信。 */
function markIfHostFault(error: unknown): boolean {
  if (!(error instanceof RangeError || error instanceof WebAssembly.RuntimeError)) return false;
  moduleTainted = true;
  return true;
}

function memoryCeilingFor(inputLength: number): number {
  return Math.min(MAX_MEMORY_CEILING_BYTES, Math.max(BASE_MEMORY_CEILING_BYTES, inputLength * MEMORY_BYTES_PER_INPUT_CHAR));
}

export interface SandboxScope {
  dispose(): void;
}

export interface SandboxOptions {
  timeoutMs?: number;
  scope?: SandboxScope;
  /** 兼容旧调用签名；隔离环境中的 console 始终静默，不注入宿主回调。 */
  onConsole?: (level: 'log' | 'warn' | 'error', args: unknown[]) => void;
}

export type SandboxFunction<TArg, TResult> = ((arg: TArg) => TResult) & { dispose(): void };

const scopes = new WeakMap<SandboxScope, Set<ScriptContext>>();
const owners = new WeakMap<object, ScriptContext>();

export function createSandboxScope(): SandboxScope {
  const contexts = new Set<ScriptContext>();
  let disposed = false;
  const scope: SandboxScope = {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const context of contexts) context.dispose();
      contexts.clear();
      scopes.delete(scope);
    },
  };
  scopes.set(scope, contexts);
  return scope;
}

export function disposeSandboxValue(value: unknown): void {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    owners.get(value)?.dispose();
  }
}

class ScriptContext {
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private readonly handles: QuickJSHandle[] = [];
  private readonly timeoutMs: number;
  private readonly scopeContexts?: Set<ScriptContext>;
  private deadline = 0;
  private disposed = false;
  private faulted = false;
  private expired = false;
  private invoke!: QuickJSHandle;
  private serialize!: QuickJSHandle;
  private functionNames!: QuickJSHandle;
  private property!: QuickJSHandle;
  private describe!: QuickJSHandle;

  constructor(options: SandboxOptions) {
    if (!quickJS) throw new Error('预设脚本解释器尚未初始化');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.scope) {
      this.scopeContexts = scopes.get(options.scope);
      if (!this.scopeContexts) throw new Error('预设脚本作用域已释放');
    }
    this.runtime = quickJS.newRuntime();
    this.runtime.setMaxStackSize(MAX_STACK_BYTES);
    this.context = this.runtime.newContext();
    this.runtime.setInterruptHandler(() => Date.now() >= this.deadline);
    try {
      this.run(() => {
        const helpers = this.keep(this.unwrap(this.context.evalCode(`(() => {
          const parse = JSON.parse;
          const stringify = JSON.stringify;
          const keys = Object.keys;
          const toString = String;
          globalThis.console = { log() {}, warn() {}, error() {} };
          return {
            invoke: (fn, json) => fn(json === undefined ? undefined : parse(json)),
            serialize: value => stringify(value),
            functionNames: value => stringify(keys(value).filter(key => typeof value[key] === 'function')),
            property: (value, key) => value[key],
            describe: error => toString(error),
          };
        })()`, 'preset-bridge.js')));
        this.invoke = this.keep(this.context.getProp(helpers, 'invoke'));
        this.serialize = this.keep(this.context.getProp(helpers, 'serialize'));
        this.functionNames = this.keep(this.context.getProp(helpers, 'functionNames'));
        this.property = this.keep(this.context.getProp(helpers, 'property'));
        this.describe = this.keep(this.context.getProp(helpers, 'describe'));
      });
      this.scopeContexts?.add(this);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scopeContexts?.delete(this);
    // 故障后释放会再次触发断言；这份内存随被替换的模块一起回收。
    if (this.faulted) return;
    try {
      for (const handle of this.handles.reverse()) handle.dispose();
      this.context.dispose();
      this.runtime.dispose();
    } catch (error) {
      moduleTainted = true;
      console.warn('[spreset] 解释器释放失败，下次初始化时更换模块:', scriptErrorMessage(error));
    }
  }

  private keep(handle: QuickJSHandle): QuickJSHandle {
    this.handles.push(handle);
    return handle;
  }

  private run<T>(operation: () => T): T {
    if (this.disposed) throw new Error('预设脚本作用域已释放');
    if (this.faulted) throw new Error('预设脚本解释器已故障');
    // 超时一次即失效：过滤器逐 chunk 调用，否则每个 chunk 都会阻塞事件循环一个完整期限。
    if (this.expired) throw new Error(TIMEOUT_MESSAGE);
    this.deadline = Date.now() + this.timeoutMs;
    memoryCeiling = BASE_MEMORY_CEILING_BYTES;
    try {
      return operation();
    } catch (error) {
      if (markIfHostFault(error)) {
        this.faulted = true;
        throw new Error('预设脚本解释器已故障');
      }
      if (error instanceof Error && error.message === TIMEOUT_MESSAGE) this.expired = true;
      throw error;
    }
  }

  private unwrap(result: { value?: QuickJSHandle; error?: QuickJSHandle }): QuickJSHandle {
    if (result.error) {
      let message = '预设脚本执行失败';
      try {
        if (Date.now() >= this.deadline) message = TIMEOUT_MESSAGE;
        else if (this.describe) {
          const description = this.context.callFunction(this.describe, this.context.undefined, result.error);
          if (description.error) description.error.dispose();
          else {
            try { message = this.context.getString(description.value); }
            finally { description.value.dispose(); }
          }
        }
        if (Date.now() >= this.deadline) message = TIMEOUT_MESSAGE;
      } finally {
        result.error.dispose();
      }
      throw new Error(message);
    }
    if (!result.value) throw new Error('预设脚本没有返回值');
    return result.value;
  }

  private readJson(value: QuickJSHandle): unknown {
    const encoded = this.unwrap(this.context.callFunction(this.serialize, this.context.undefined, value));
    try {
      if (this.context.typeof(encoded) === 'undefined') return undefined;
      if (this.context.typeof(encoded) !== 'string') throw new Error('脚本返回值无法序列化');
      return JSON.parse(this.context.getString(encoded)) as unknown;
    } finally {
      encoded.dispose();
    }
  }

  private settle(value: QuickJSHandle): QuickJSHandle {
    while (true) {
      if (Date.now() >= this.deadline) throw new Error(TIMEOUT_MESSAGE);
      const state = this.context.getPromiseState(value);
      if (state.type === 'fulfilled') return state.notAPromise ? value.dup() : state.value;
      if (state.type === 'rejected') return this.unwrap({ error: state.error });
      if (!this.runtime.hasPendingJob()) throw new Error('预设脚本 Promise 无法完成（没有可执行的异步任务）');
      const jobs = this.runtime.executePendingJobs(1);
      if (jobs.error) this.unwrap({ error: jobs.error });
    }
  }

  private bind<TArg, TResult>(fn: QuickJSHandle): SandboxFunction<TArg, TResult> {
    const wrapped = ((arg: TArg): TResult => this.run(() => {
      const json = JSON.stringify(arg);
      memoryCeiling = memoryCeilingFor(json?.length ?? 0);
      const input = json === undefined ? this.context.undefined : this.context.newString(json);
      try {
        const pending = this.unwrap(this.context.callFunction(this.invoke, this.context.undefined, fn, input));
        try {
          const result = this.settle(pending);
          try { return this.readJson(result) as TResult; }
          finally { result.dispose(); }
        } finally {
          pending.dispose();
        }
      } finally {
        input.dispose();
      }
    })) as SandboxFunction<TArg, TResult>;
    wrapped.dispose = () => this.dispose();
    owners.set(wrapped, this);
    return wrapped;
  }

  expression<TArg, TResult>(source: string): SandboxFunction<TArg, TResult> | null {
    return this.run(() => {
      const value = this.keep(this.unwrap(this.context.evalCode(`(${source}\n)`, 'preset-expression.js')));
      return this.context.typeof(value) === 'function' ? this.bind<TArg, TResult>(value) : null;
    });
  }

  factory<TResult>(source: string): TResult | null {
    return this.run(() => {
      const value = this.keep(this.unwrap(this.context.evalCode(`(function () {\n${source}\n})()`, 'preset-factory.js')));
      const result = this.readJson(value);
      if (!result || typeof result !== 'object') return (result ?? null) as TResult | null;
      const keysValue = this.unwrap(this.context.callFunction(this.functionNames, this.context.undefined, value));
      let keys: string[];
      try { keys = JSON.parse(this.context.getString(keysValue)) as string[]; }
      finally { keysValue.dispose(); }
      for (const key of keys) {
        const name = this.context.newString(key);
        try {
          const fn = this.keep(this.unwrap(this.context.callFunction(this.property, this.context.undefined, value, name)));
          Object.defineProperty(result, key, { value: this.bind(fn), enumerable: true, configurable: true });
        } finally {
          name.dispose();
        }
      }
      owners.set(result, this);
      return result as TResult;
    });
  }
}

export function evaluateFunction<TArg = unknown, TResult = unknown>(
  source: string,
  options: SandboxOptions = {},
): SandboxFunction<TArg, TResult> | null {
  if (typeof source !== 'string' || !source.trim()) return null;
  const expression = source.trim().replace(/[\s;]+$/, '');
  if (!expression) return null;
  let context: ScriptContext | undefined;
  try {
    context = new ScriptContext(options);
    const fn = context.expression<TArg, TResult>(expression);
    if (!fn) context.dispose();
    return fn;
  } catch (error) {
    markIfHostFault(error);
    context?.dispose();
    return null;
  }
}

export function evaluateFactory<TResult = unknown>(
  body: string,
  options: SandboxOptions = {},
): TResult | null {
  if (typeof body !== 'string' || !body.trim()) return null;
  let context: ScriptContext | undefined;
  try {
    context = new ScriptContext(options);
    const result = context.factory<TResult>(body);
    if (!result || typeof result !== 'object') context.dispose();
    return result;
  } catch (error) {
    markIfHostFault(error);
    context?.dispose();
    return null;
  }
}

export function scriptErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
