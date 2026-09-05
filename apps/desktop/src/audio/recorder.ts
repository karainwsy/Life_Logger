import processorUrl from './processor.js?url';
const TARGET_SAMPLE_RATE = 16000;
export const MAX_RECORDING_SECONDS = 300;
export const downsampleBuffer = (input: Float32Array, inputSampleRate: number) => {
  if (inputSampleRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const output = new Float32Array(Math.round(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = Math.round(i * ratio); const end = Math.min(input.length, Math.round((i + 1) * ratio));
    let sum = 0; for (let j = start; j < end; j++) sum += input[j];
    output[i] = end > start ? sum / (end - start) : input[Math.min(start, input.length - 1)] ?? 0;
  }
  return output;
};
export const encodeWav = (samples: Float32Array, rate = TARGET_SAMPLE_RATE) => {
  const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => { const sample = Math.max(-1, Math.min(1, value)); view.setInt16(44 + i * 2, sample * (sample < 0 ? 32768 : 32767), true); });
  return buffer;
};
export type AudioRecorder = { stop(): Promise<ArrayBuffer>; cancel(): Promise<void> };
export const startAudioRecording = async (options: { signal?: AbortSignal; onLimit?: () => void } = {}): Promise<AudioRecorder> => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let context: AudioContext | undefined; let source: MediaStreamAudioSourceNode | undefined; let processor: AudioWorkletNode | undefined;
  const chunks: Float32Array[] = []; let total = 0; let stopped = false; let result: Promise<ArrayBuffer> | null = null;
  const cleanup = async () => {
    stopped = true; options.signal?.removeEventListener('abort', abort);
    if (processor) { processor.port.onmessage = null; processor.port.close(); processor.disconnect(); }
    source?.disconnect(); stream.getTracks().forEach(track => track.stop());
    if (context && context.state !== 'closed') await context.close();
  };
  const abort = () => { void cleanup(); };
  try {
    if (options.signal?.aborted) throw new DOMException('已取消录音', 'AbortError');
    context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    await context.audioWorklet.addModule(processorUrl);
    if (options.signal?.aborted) throw new DOMException('已取消录音', 'AbortError');
    source = context.createMediaStreamSource(stream); processor = new AudioWorkletNode(context, 'life-logger-recorder');
    const sampleRate = context.sampleRate; const maxSamples = sampleRate * MAX_RECORDING_SECONDS;
    processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (stopped) return;
      const chunk = event.data.slice(0, Math.max(0, maxSamples - total));
      chunks.push(chunk); total += chunk.length;
      if (total >= maxSamples) { stopped = true; options.onLimit?.(); }
    };
    source.connect(processor); processor.connect(context.destination); await context.resume();
    options.signal?.addEventListener('abort', abort, { once: true });
    return {
      stop() {
        result ??= (async () => {
          await cleanup();
          const samples = new Float32Array(total); let offset = 0;
          for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
          chunks.length = 0;
          return encodeWav(downsampleBuffer(samples, sampleRate));
        })();
        return result;
      },
      async cancel() { await cleanup(); chunks.length = 0; }
    };
  } catch (error) { await cleanup(); throw error; }
};
