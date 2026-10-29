/** Tencent SILK ↔ PCM/WAV, plus ffmpeg for AMR and other common audio files. */
import { spawn } from 'node:child_process';
import { decode, encode, getDuration, isSilk, isWav } from 'silk-wasm';

function wav(pcm, rate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}
export async function audioToPcm(bytes, { signal, sampleRate = 24000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'pipe',
        '-i',
        'pipe:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-t',
        '600',
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], signal },
    );
    const chunks = [];
    let size = 0;
    let diagnostics = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          error.code === 'ENOENT'
            ? '语音转码需要安装 ffmpeg'
            : `语音转码失败：${error.message}`,
        ),
      );
    });
    child.stdout.on('data', (part) => {
      size += part.length;
      if (size > 30 * 1024 * 1024) child.kill('SIGKILL');
      else chunks.push(part);
    });
    child.stderr.on('data', (part) => {
      if (diagnostics.length < 500) diagnostics += part.toString();
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !size)
        reject(new Error('音频无法解码，请发送有效的语音或音频文件'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(bytes);
  });
}
export async function normalizeAudio(bytes, options = {}) {
  options.signal?.throwIfAborted();
  // dsh's SenseVoice provider requires 16 kHz mono PCM16 WAV, while native
  // WeChat voice encoding uses 24 kHz. Do not pass SILK's decode rate through.
  if (
    isWav(bytes) &&
    bytes.length >= 46 &&
    bytes.toString('ascii', 12, 16) === 'fmt ' &&
    bytes.readUInt32LE(16) === 16 &&
    bytes.readUInt16LE(20) === 1 &&
    bytes.readUInt16LE(22) === 1 &&
    bytes.readUInt32LE(24) === 16000 &&
    bytes.readUInt32LE(28) === 32000 &&
    bytes.readUInt16LE(32) === 2 &&
    bytes.readUInt16LE(34) === 16 &&
    bytes.toString('ascii', 36, 40) === 'data' &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.readUInt32LE(40) === bytes.length - 44 &&
    (bytes.length - 44) % 2 === 0
  )
    return { bytes: Buffer.from(bytes), mediaType: 'audio/wav' };
  if (isSilk(bytes) && getDuration(bytes) > 600000)
    throw new Error('语音超过 10 分钟，请作为音频文件发送');
  const pcm = isSilk(bytes)
    ? (await decode(bytes, 16000)).data
    : await audioToPcm(bytes, { ...options, sampleRate: 16000 });
  options.signal?.throwIfAborted();
  return { bytes: wav(pcm, 16000), mediaType: 'audio/wav' };
}
export async function encodeVoice(bytes, { signal } = {}) {
  signal?.throwIfAborted();
  if (isSilk(bytes)) {
    return {
      bytes: Buffer.from(bytes),
      seconds: Math.max(1, Math.ceil(getDuration(bytes) / 1000)),
    };
  }
  const pcm = await audioToPcm(bytes, { signal });
  signal?.throwIfAborted();
  const encoded = await encode(pcm, 24000);
  signal?.throwIfAborted();
  return {
    bytes: Buffer.from(encoded.data),
    seconds: Math.max(1, Math.ceil(encoded.duration / 1000)),
  };
}
