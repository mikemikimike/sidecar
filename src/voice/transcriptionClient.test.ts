import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transcribeAudio, float32ToWav } from './transcriptionClient.js';
import type { TranscriptionOptions } from './transcriptionClient.js';

const BASE_OPTS: TranscriptionOptions = {
  model: 'whisper-1',
  apiKey: 'test-key',
  transcriptionUrl: 'http://localhost:11434/v1/audio/transcriptions',
};

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('transcribeAudio', () => {
  it('returns trimmed text from a successful response', async () => {
    vi.stubGlobal('fetch', makeFetch(200, { text: '  Hello world.  ' }));
    vi.stubGlobal(
      'FormData',
      class MockFormData {
        private entries: [string, unknown][] = [];
        append(k: string, v: unknown) {
          this.entries.push([k, v]);
        }
      },
    );
    vi.stubGlobal(
      'Blob',
      class MockBlob {
        constructor(
          public parts: unknown[],
          public opts?: { type?: string },
        ) {}
      },
    );

    const buf = Buffer.from('fake-audio');
    const result = await transcribeAudio(buf, 'audio/webm', BASE_OPTS);
    expect(result).toBe('Hello world.');
  });

  it('sends Authorization header when apiKey is provided', async () => {
    const mockFetch = makeFetch(200, { text: 'ok' });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal(
      'FormData',
      class {
        append() {}
      },
    );
    vi.stubGlobal(
      'Blob',
      class {
        constructor() {}
      },
    );

    await transcribeAudio(Buffer.from('x'), 'audio/webm', BASE_OPTS);

    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('omits Authorization header when apiKey is empty string', async () => {
    const mockFetch = makeFetch(200, { text: 'ok' });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal(
      'FormData',
      class {
        append() {}
      },
    );
    vi.stubGlobal(
      'Blob',
      class {
        constructor() {}
      },
    );

    await transcribeAudio(Buffer.from('x'), 'audio/webm', { ...BASE_OPTS, apiKey: '' });

    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit & { headers: Record<string, string> }).headers).not.toHaveProperty('Authorization');
  });

  it('posts to the configured transcriptionUrl', async () => {
    const mockFetch = makeFetch(200, { text: 'hi' });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal(
      'FormData',
      class {
        append() {}
      },
    );
    vi.stubGlobal(
      'Blob',
      class {
        constructor() {}
      },
    );

    const url = 'https://api.groq.com/openai/v1/audio/transcriptions';
    await transcribeAudio(Buffer.from('x'), 'audio/webm', { ...BASE_OPTS, transcriptionUrl: url });

    expect(mockFetch.mock.calls[0][0]).toBe(url);
  });

  it('throws on non-OK HTTP status with body excerpt in message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized: invalid key',
        json: async () => ({}),
      }),
    );
    vi.stubGlobal(
      'FormData',
      class {
        append() {}
      },
    );
    vi.stubGlobal(
      'Blob',
      class {
        constructor() {}
      },
    );

    await expect(transcribeAudio(Buffer.from('x'), 'audio/webm', BASE_OPTS)).rejects.toThrow('HTTP 401');
  });

  it('throws when response JSON is missing "text" field', async () => {
    vi.stubGlobal('fetch', makeFetch(200, { result: 'missing text field' }));
    vi.stubGlobal(
      'FormData',
      class {
        append() {}
      },
    );
    vi.stubGlobal(
      'Blob',
      class {
        constructor() {}
      },
    );

    await expect(transcribeAudio(Buffer.from('x'), 'audio/webm', BASE_OPTS)).rejects.toThrow('"text" field');
  });

  it('respects the AbortSignal', async () => {
    const mockFetch = makeFetch(200, { text: 'ok' });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal(
      'FormData',
      class {
        append() {}
      },
    );
    vi.stubGlobal(
      'Blob',
      class {
        constructor() {}
      },
    );

    const controller = new AbortController();
    await transcribeAudio(Buffer.from('x'), 'audio/webm', { ...BASE_OPTS, signal: controller.signal });

    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit).signal).toBe(controller.signal);
  });

  describe('audioFilename inference', () => {
    const cases: [string, string][] = [
      ['audio/webm;codecs=opus', 'audio.webm'],
      ['audio/ogg', 'audio.ogg'],
      ['audio/mp4', 'audio.mp4'],
      ['audio/wav', 'audio.wav'],
      ['audio/mpeg', 'audio.mp3'],
      ['audio/mp3', 'audio.mp3'],
      ['application/octet-stream', 'audio.bin'],
    ];

    for (const [mimeType, expectedFilename] of cases) {
      it(`maps ${mimeType} → ${expectedFilename}`, async () => {
        let appendedFilename = '';
        vi.stubGlobal('fetch', makeFetch(200, { text: 'ok' }));
        vi.stubGlobal(
          'FormData',
          class {
            append(_k: string, _v: unknown, name?: string) {
              if (name) appendedFilename = name;
            }
          },
        );
        vi.stubGlobal(
          'Blob',
          class {
            constructor() {}
          },
        );

        await transcribeAudio(Buffer.from('x'), mimeType, BASE_OPTS);
        expect(appendedFilename).toBe(expectedFilename);
      });
    }
  });
});

// #120: both recorders produce headerless Float32 PCM, which Whisper-compatible
// APIs reject; it is uploaded as a 16-bit WAV.
describe('raw PCM upload', () => {
  function f32(...samples: number[]): Buffer {
    const b = Buffer.alloc(samples.length * 4);
    samples.forEach((s, i) => b.writeFloatLE(s, i * 4));
    return b;
  }

  it('wraps Float32 samples in a 16 kHz mono 16-bit WAV', () => {
    const wav = float32ToWav(f32(0, 1, -1, 0.5, 2));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(10);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    const samples = [0, 1, 2, 3, 4].map((i) => wav.readInt16LE(44 + i * 2));
    expect(samples).toEqual([0, 32767, -32768, 16384, 32767]); // clipped above 1
  });

  it('uploads audio/pcm-f32le as audio.wav with a RIFF header', async () => {
    const mockFetch = makeFetch(200, { text: 'ok' });
    vi.stubGlobal('fetch', mockFetch);
    await transcribeAudio(f32(0.1, -0.1), 'audio/pcm-f32le', BASE_OPTS);
    const file = ((mockFetch.mock.calls[0][1] as RequestInit).body as FormData).get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
    expect(Buffer.from(await file.arrayBuffer()).toString('ascii', 0, 4)).toBe('RIFF');
  });
});
