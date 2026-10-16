// ---------------------------------------------------------------------------
// Whisper-compatible transcription client.
//
// Calls the OpenAI-compatible `/v1/audio/transcriptions` endpoint (supported
// by OpenAI, Groq fast-whisper, and any Whisper-capable local server).
// Uses Node 18+ globals (FormData, Blob, fetch) so no extra dependencies.
// ---------------------------------------------------------------------------

export interface TranscriptionOptions {
  model: string;
  apiKey: string;
  transcriptionUrl: string;
  signal?: AbortSignal;
}

function audioFilename(mimeType: string): string {
  const t = mimeType.split(';')[0].toLowerCase();
  if (t.includes('webm')) return 'audio.webm';
  if (t.includes('ogg')) return 'audio.ogg';
  if (t.includes('mp4')) return 'audio.mp4';
  if (t.includes('wav')) return 'audio.wav';
  if (t.includes('mpeg') || t.includes('mp3')) return 'audio.mp3';
  return 'audio.bin';
}

/** The raw format both recorders produce: mono Float32 little-endian samples. */
const RAW_PCM_MIME = 'audio/pcm-f32le';
const PCM_SAMPLE_RATE = 16_000;

/**
 * Wrap mono Float32 PCM as a 16-bit PCM WAV file. Whisper-compatible APIs
 * take a container format; headerless samples uploaded as `audio.bin` were
 * rejected, so remote transcription never worked (#120).
 */
export function float32ToWav(pcm: Buffer, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const samples = Math.floor(pcm.length / 4);
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const s = Math.max(-1, Math.min(1, pcm.readFloatLE(i * 4)));
    wav.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return wav;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
  options: TranscriptionOptions,
): Promise<string> {
  if (mimeType.split(';')[0].trim().toLowerCase() === RAW_PCM_MIME) {
    audioBuffer = float32ToWav(audioBuffer);
    mimeType = 'audio/wav';
  }
  const cleanMime = mimeType.split(';')[0].trim() || 'audio/webm';
  const arrayBuf = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([arrayBuf], { type: cleanMime });
  const form = new FormData();
  form.append('file', blob, audioFilename(mimeType));
  form.append('model', options.model);

  const headers: Record<string, string> = {};
  if (options.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`;

  const response = await fetch(options.transcriptionUrl, {
    method: 'POST',
    headers,
    body: form,
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable body)');
    throw new Error(`Transcription request failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
  }

  const json = (await response.json()) as { text?: unknown };
  if (typeof json.text !== 'string') {
    throw new Error('Transcription response is missing the "text" field.');
  }
  return json.text.trim();
}
