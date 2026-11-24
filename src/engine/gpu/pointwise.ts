/**
 * World-only f32 compute kernels. Legacy graph math never passes through this
 * module. A backend must pass its own numerical probe before it is selectable.
 */
export type ComputePreference = 'auto' | 'cpu-reference' | 'webgpu';
export type PointwiseOperation =
  | { kind: 'remap'; contrast: number; brightness: number; gamma: number; clamp: boolean }
  | { kind: 'terrace'; steps: number; softness: number }
  | { kind: 'blend'; mode: 'mix' | 'add' | 'multiply' | 'min' | 'max'; amount: number }
  | { kind: 'mask'; low: number; high: number; softness: number; invert: boolean };
export interface ComputeCapability {
  requested: ComputePreference;
  available: boolean;
  qualified: boolean;
  backend: 'cpu-reference' | 'webgpu';
  reason: string;
  failure?: 'initialization' | 'limits' | 'compilation' | 'execution' | 'numerical';
  adapter?: string;
  maxStorageBufferBindingSize?: number;
  maxBufferSize?: number;
  maxComputeWorkgroupsPerDimension?: number;
  numerical?: { maxAbsoluteError: number; rmse: number; sampleCount: number };
}
export interface PointwiseResult {
  values: Float32Array;
  backend: 'cpu-reference' | 'webgpu';
  duration: number;
}
export interface PointwiseBackend {
  readonly capability: ComputeCapability;
  apply(
    operation: PointwiseOperation,
    input: Float32Array,
    other?: Float32Array,
    mask?: Float32Array,
  ): Promise<PointwiseResult>;
  dispose(): void;
}
// The app does not require a WebGPU types/runtime dependency. These structural
// declarations describe only the standard API surface used by these kernels.
interface ShaderModuleLike {
  getCompilationInfo(): Promise<{
    messages: Array<{ type: string; message: string; lineNum: number; linePos: number }>;
  }>;
}
interface BufferLike {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
interface ComputePassLike {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, group: unknown): void;
  dispatchWorkgroups(n: number): void;
  end(): void;
}
interface EncoderLike {
  beginComputePass(): ComputePassLike;
  copyBufferToBuffer(
    source: BufferLike,
    sourceOffset: number,
    target: BufferLike,
    targetOffset: number,
    size: number,
  ): void;
  finish(): unknown;
}
interface DeviceLike {
  lost: Promise<{ message: string; reason: string }>;
  limits: {
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
    maxComputeWorkgroupsPerDimension: number;
    maxComputeInvocationsPerWorkgroup: number;
    maxComputeWorkgroupSizeX: number;
  };
  queue: {
    writeBuffer(buffer: BufferLike, offset: number, data: ArrayBufferView): void;
    submit(commands: unknown[]): void;
  };
  createBuffer(descriptor: { label?: string; size: number; usage: number }): BufferLike;
  createShaderModule(descriptor: { code: string; label?: string }): ShaderModuleLike;
  createComputePipelineAsync(descriptor: {
    label?: string;
    layout: 'auto';
    compute: { module: unknown; entryPoint: string };
  }): Promise<{ getBindGroupLayout(index: number): unknown }>;
  createBindGroup(descriptor: {
    layout: unknown;
    entries: Array<{ binding: number; resource: { buffer: BufferLike } }>;
  }): unknown;
  createCommandEncoder(): EncoderLike;
  pushErrorScope(filter: 'validation' | 'out-of-memory'): void;
  popErrorScope(): Promise<{ message: string } | null>;
  destroy(): void;
}
interface AdapterLike {
  info?: {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
    isFallbackAdapter?: boolean;
  };
  isFallbackAdapter?: boolean;
  requestDevice(): Promise<DeviceLike>;
}
interface NavigatorGPU {
  requestAdapter(options: { powerPreference: string }): Promise<AdapterLike | null>;
}
const F = Math.fround;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (a: number, b: number, x: number) => {
  const t = F(clamp01(F(F(x - a) / F(b - a))));
  return F(F(t * t) * F(3 - F(2 * t)));
};
function validate(
  operation: PointwiseOperation,
  input: Float32Array,
  other?: Float32Array,
  mask?: Float32Array,
) {
  if (!input.length) throw new Error('A compute field must contain at least one sample.');
  if ((other && other.length !== input.length) || (mask && mask.length !== input.length))
    throw new Error('Pointwise fields must have identical sample counts.');
  if (operation.kind === 'blend' && !other) throw new Error('Blend requires a second input field.');
  const parameters = Object.values(operation).filter((v): v is number => typeof v === 'number');
  if (parameters.some((v) => !Number.isFinite(v)))
    throw new Error('Compute parameters must be finite.');
  if (
    (operation.kind === 'remap' && operation.gamma <= 0) ||
    (operation.kind === 'terrace' && (operation.steps < 1 || operation.softness <= 0)) ||
    (operation.kind === 'mask' && operation.softness <= 0)
  )
    throw new Error('Compute parameters are outside their valid range.');
  for (const values of [input, other, mask])
    if (values)
      for (const value of values)
        if (!Number.isFinite(value)) throw new Error('A compute field contains non-finite data.');
}
/** Independent, explicitly rounded f32 numerical oracle for the WGSL kernels. */
export function pointwiseCPU(
  operation: PointwiseOperation,
  input: Float32Array,
  other?: Float32Array,
  mask?: Float32Array,
): Float32Array {
  validate(operation, input, other, mask);
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const a = input[i];
    if (operation.kind === 'remap') {
      const adjusted = F(F(F(F(a - 0.5) * F(operation.contrast)) + 0.5) + F(operation.brightness));
      const v = F(Math.sign(adjusted) * F(Math.pow(Math.abs(adjusted), F(1 / F(operation.gamma)))));
      output[i] = operation.clamp ? clamp01(v) : v;
    } else if (operation.kind === 'terrace') {
      const steps = F(operation.steps),
        softness = F(operation.softness);
      const scaled = F(a * steps),
        lower = Math.floor(scaled);
      const transition = smooth(
        F(0.5 - F(softness * 0.5)),
        F(0.5 + F(softness * 0.5)),
        F(scaled - lower),
      );
      output[i] = F(F(lower + transition) / steps);
    } else if (operation.kind === 'mask') {
      const low = F(operation.low),
        high = F(operation.high),
        soft = F(operation.softness);
      const weight = F(
        smooth(F(low - soft), F(low + soft), a) * F(1 - smooth(F(high - soft), F(high + soft), a)),
      );
      output[i] = operation.invert ? F(1 - weight) : weight;
    } else {
      const b = other![i],
        amount = F(F(operation.amount) * (mask ? clamp01(mask[i]) : 1));
      let v = b;
      if (operation.mode === 'add') {
        output[i] = F(a + F(b * amount));
        continue;
      }
      if (operation.mode === 'multiply') v = F(a * b);
      else if (operation.mode === 'min') v = Math.min(a, b);
      else if (operation.mode === 'max') v = Math.max(a, b);
      output[i] = F(a + F(F(v - a) * amount));
    }
  }
  for (const value of output)
    if (!Number.isFinite(value)) throw new Error('Pointwise compute produced non-finite values.');
  return output;
}
export const POINTWISE_WGSL = `
struct Parameters { control: vec4<u32>, a: vec4<f32>, b: vec4<f32>, unused: vec4<f32> }
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read> other: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read_write> destination: array<f32>;
@group(0) @binding(4) var<uniform> parameters: Parameters;
fn ease(lo: f32, hi: f32, value: f32) -> f32 {
  let t = clamp((value - lo) / (hi - lo), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let i = invocation.x;
  if (i >= parameters.control.x) { return; }
  let value = source[i];
  let op = parameters.control.y;
  if (op == 0u) {
    let shifted = (value - 0.5) * parameters.a.x + 0.5 + parameters.a.y;
    let curved = sign(shifted) * pow(abs(shifted), 1.0 / parameters.a.z);
    destination[i] = select(curved, clamp(curved, 0.0, 1.0), parameters.control.z != 0u);
  } else if (op == 1u) {
    let scaled = value * parameters.a.x;
    let lower = floor(scaled);
    let blend = ease(0.5 - parameters.a.y * 0.5, 0.5 + parameters.a.y * 0.5, scaled - lower);
    destination[i] = (lower + blend) / parameters.a.x;
  } else if (op == 2u) {
    var fraction = parameters.a.x;
    if (parameters.control.w != 0u) { fraction *= clamp(weights[i], 0.0, 1.0); }
    let second = other[i];
    var mixed = second;
    let mode = parameters.control.z;
    if (mode == 1u) { destination[i] = value + second * fraction; return; }
    if (mode == 2u) { mixed = value * second; }
    if (mode == 3u) { mixed = min(value, second); }
    if (mode == 4u) { mixed = max(value, second); }
    destination[i] = value + (mixed - value) * fraction;
  } else {
    let selected = ease(parameters.a.x - parameters.a.z, parameters.a.x + parameters.a.z, value) *
      (1.0 - ease(parameters.a.y - parameters.a.z, parameters.a.y + parameters.a.z, value));
    destination[i] = select(selected, 1.0 - selected, parameters.control.z != 0u);
  }
}
`;
function pack(operation: PointwiseOperation, length: number, hasMask: boolean): Uint8Array {
  const bytes = new Uint8Array(64),
    ints = new Uint32Array(bytes.buffer),
    floats = new Float32Array(bytes.buffer);
  ints[0] = length;
  if (operation.kind === 'remap') {
    ints[1] = 0;
    ints[2] = +operation.clamp;
    floats.set([operation.contrast, operation.brightness, operation.gamma], 4);
  } else if (operation.kind === 'terrace') {
    ints[1] = 1;
    floats.set([operation.steps, operation.softness], 4);
  } else if (operation.kind === 'blend') {
    ints[1] = 2;
    ints[2] = ['mix', 'add', 'multiply', 'min', 'max'].indexOf(operation.mode);
    ints[3] = +hasMask;
    floats[4] = operation.amount;
  } else {
    ints[1] = 3;
    ints[2] = +operation.invert;
    floats.set([operation.low, operation.high, operation.softness], 4);
  }
  return bytes;
}
function cpuBackend(capability: ComputeCapability): PointwiseBackend {
  return {
    capability,
    async apply(operation, input, other, mask) {
      const start = performance.now();
      const values = pointwiseCPU(operation, input, other, mask);
      return { values, backend: 'cpu-reference', duration: performance.now() - start };
    },
    dispose() {},
  };
}
/**
 * One device per world build. Device loss fails that build atomically instead
 * of mixing CPU/GPU edge values in a partially written tile package. The next
 * request can select CPU or create a fresh adapter.
 */
export async function createPointwiseBackend(
  preference: ComputePreference = 'auto',
): Promise<PointwiseBackend> {
  const report: ComputeCapability = {
    requested: preference,
    available: false,
    qualified: false,
    backend: 'cpu-reference',
    reason: 'CPU reference selected.',
  };
  if (preference === 'cpu-reference') return cpuBackend(report);
  const gpu =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as unknown as { gpu?: NavigatorGPU }).gpu;
  if (!gpu)
    return cpuBackend({
      ...report,
      reason: 'WebGPU is unavailable in this browser or secure context. Using CPU reference.',
    });
  let device: DeviceLike | undefined;
  let failure: NonNullable<ComputeCapability['failure']> = 'initialization';
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter)
      return cpuBackend({
        ...report,
        reason: 'No WebGPU adapter was available. Using CPU reference.',
      });
    device = await adapter.requestDevice();
    const ownedDevice = device;
    let disposed = false,
      lost = '';
    void device.lost.then((info) => {
      if (!disposed) lost = info.message || info.reason || 'WebGPU device lost.';
    });
    const { limits } = device;
    report.available = true;
    report.adapter =
      [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description]
        .filter(Boolean)
        .join(' / ') || 'WebGPU adapter (identification unavailable)';
    report.maxStorageBufferBindingSize = limits.maxStorageBufferBindingSize;
    report.maxBufferSize = limits.maxBufferSize;
    report.maxComputeWorkgroupsPerDimension = limits.maxComputeWorkgroupsPerDimension;
    failure = 'limits';
    if (limits.maxComputeInvocationsPerWorkgroup < 64 || limits.maxComputeWorkgroupSizeX < 64)
      throw new Error('Adapter workgroup limits are below the kernel requirement.');
    failure = 'compilation';
    const module = device.createShaderModule({
      label: 'Normal Height world pointwise kernels',
      code: POINTWISE_WGSL,
    });
    const compilation = await module.getCompilationInfo();
    const compilationErrors = compilation.messages.filter((message) => message.type === 'error');
    if (compilationErrors.length)
      throw new Error(
        'WebGPU shader compilation failed: ' +
          compilationErrors
            .map((message) => `line ${message.lineNum}:${message.linePos}: ${message.message}`)
            .join('; '),
      );
    const pipeline = await device.createComputePipelineAsync({
      label: 'World f32 pointwise',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    failure = 'execution';
    const backend: PointwiseBackend = {
      capability: report,
      async apply(operation, input, other, mask) {
        validate(operation, input, other, mask);
        if (disposed || lost) throw new Error(lost || 'WebGPU backend has been disposed.');
        const size = input.byteLength;
        if (
          size > limits.maxBufferSize ||
          size > limits.maxStorageBufferBindingSize ||
          Math.ceil(input.length / 64) > limits.maxComputeWorkgroupsPerDimension
        )
          throw new Error(
            'This compute region exceeds WebGPU buffer or dispatch limits; choose smaller tiles or CPU reference.',
          );
        const start = performance.now(),
          allocated: BufferLike[] = [];
        const buffer = (bytes: number, usage: number, label: string) => {
          const value = ownedDevice.createBuffer({ size: bytes, usage, label });
          allocated.push(value);
          return value;
        };
        ownedDevice.pushErrorScope('out-of-memory');
        ownedDevice.pushErrorScope('validation');
        let scopesPopped = false;
        try {
          const a = buffer(size, 128 | 8, 'input A');
          const b = buffer(other ? size : 4, 128 | 8, 'input B');
          const m = buffer(mask ? size : 4, 128 | 8, 'blend mask');
          const out = buffer(size, 128 | 4, 'output');
          const uniforms = buffer(64, 64 | 8, 'parameters');
          const readback = buffer(size, 1 | 8, 'readback');
          ownedDevice.queue.writeBuffer(a, 0, input);
          if (other) ownedDevice.queue.writeBuffer(b, 0, other);
          if (mask) ownedDevice.queue.writeBuffer(m, 0, mask);
          ownedDevice.queue.writeBuffer(uniforms, 0, pack(operation, input.length, !!mask));
          const group = ownedDevice.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [a, b, m, out, uniforms].map((entry, binding) => ({
              binding,
              resource: { buffer: entry },
            })),
          });
          const encoder = ownedDevice.createCommandEncoder(),
            pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(input.length / 64));
          pass.end();
          encoder.copyBufferToBuffer(out, 0, readback, 0, size);
          ownedDevice.queue.submit([encoder.finish()]);
          await readback.mapAsync(1);
          const values = new Float32Array(readback.getMappedRange().slice(0));
          readback.unmap();
          const validation = await ownedDevice.popErrorScope(),
            memory = await ownedDevice.popErrorScope();
          scopesPopped = true;
          if (validation || memory || lost)
            throw new Error(validation?.message || memory?.message || lost);
          for (const value of values)
            if (!Number.isFinite(value)) throw new Error('WebGPU produced non-finite values.');
          return { values, backend: 'webgpu', duration: performance.now() - start };
        } finally {
          for (const allocation of allocated) allocation.destroy();
          if (!scopesPopped) {
            await ownedDevice.popErrorScope();
            await ownedDevice.popErrorScope();
          }
        }
      },
      dispose() {
        disposed = true;
        ownedDevice.destroy();
      },
    };
    const input = Float32Array.from({ length: 257 }, (_, i) => (i - 32) / 192),
      second = Float32Array.from(input, (x) => 0.7 - x * 0.2);
    const mask = Float32Array.from(input, (x) => clamp01(x));
    const operations: PointwiseOperation[] = [
      { kind: 'remap', contrast: 1.27, brightness: -0.13, gamma: 1.2, clamp: false },
      { kind: 'terrace', steps: 13, softness: 0.38 },
      ...(['mix', 'add', 'multiply', 'min', 'max'] as const).map((mode) => ({
        kind: 'blend' as const,
        mode,
        amount: 0.37,
      })),
      { kind: 'mask', low: 0.2, high: 0.7, softness: 0.1, invert: true },
    ];
    let maxAbsoluteError = 0,
      squareSum = 0,
      sampleCount = 0;
    for (const operation of operations) {
      const expected = pointwiseCPU(operation, input, second, mask),
        actual = await backend.apply(operation, input, second, mask);
      for (let i = 0; i < input.length; i++) {
        const error = Math.abs(expected[i] - actual.values[i]);
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
        squareSum += error * error;
        sampleCount++;
      }
    }
    const rmse = Math.sqrt(squareSum / sampleCount);
    report.numerical = { maxAbsoluteError, rmse, sampleCount };
    failure = 'numerical';
    if (maxAbsoluteError > 1e-4 || rmse > 1e-5)
      throw new Error(
        `WebGPU numerical probe failed (${maxAbsoluteError.toExponential(2)} maximum error).`,
      );
    report.qualified = true;
    report.backend = 'webgpu';
    report.reason =
      adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter
        ? 'Pointwise kernels passed the runtime numerical probe on a fallback/software adapter. This is not hardware performance qualification.'
        : 'Pointwise kernels passed the runtime numerical probe. Noise and global simulation remain CPU reference; hardware performance is not certified.';
    return backend;
  } catch (error) {
    device?.destroy();
    return cpuBackend({
      ...report,
      failure,
      backend: 'cpu-reference',
      qualified: false,
      reason: `${error instanceof Error ? error.message : 'WebGPU initialization failed.'} Using CPU reference.`,
    });
  }
}
