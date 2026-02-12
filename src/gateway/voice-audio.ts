/**
 * @module voice-audio
 * Audio utilities for the voice WebSocket endpoint: WAV encoding, STT via Groq, VAD helpers.
 */

/** RMS threshold below which audio is considered silence (PCM16 range). */
export const VAD_SILENCE_THRESHOLD = 500;

/** Calculate RMS energy of a PCM16 buffer. */
export function calculateRms(pcm: Buffer): number {
  const samples = pcm.length / 2;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

/** Build a minimal WAV header for PCM data. */
export function buildWavHeader(
  dataSize: number,
  sampleRate: number,
  channels: number,
  bits: number,
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bits / 8);
  const blockAlign = channels * (bits / 8);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

/** Transcribe audio buffer (PCM16 mono 16kHz) using Groq Whisper API. */
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY not set");
  }

  const wavHeader = buildWavHeader(audioBuffer.length, 16000, 1, 16);
  const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);

  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "fr");
  form.append("response_format", "json");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Groq STT error: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { text?: string };
  return json.text?.trim() ?? "";
}
