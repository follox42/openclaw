#!/usr/bin/env tsx
/**
 * @module test-voice-ws
 * Simple test client for the gateway voice WebSocket endpoint.
 *
 * Usage:
 *   GATEWAY_TOKEN=your-token tsx src/channels/plugins/telegram-voice/test-voice-ws.ts
 *
 * Optional env vars:
 *   GATEWAY_URL=ws://localhost:18789/voice/ws
 *   TEST_AUDIO_FILE=/path/to/audio.pcm  (PCM16 mono 16kHz raw file)
 *
 * Without TEST_AUDIO_FILE, sends a sine wave tone to test the pipeline.
 */

import { readFileSync, existsSync } from "node:fs";
import WebSocket from "ws";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "ws://127.0.0.1:18789/voice/ws";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const TEST_AUDIO_FILE = process.env.TEST_AUDIO_FILE;

if (!GATEWAY_TOKEN) {
  console.error("Error: Set GATEWAY_TOKEN env var");
  process.exit(1);
}

/** Generate a PCM16 sine wave (for testing without a real audio file). */
function generateSineWave(durationSec: number, freqHz: number, sampleRate = 16000): Buffer {
  const samples = Math.floor(durationSec * sampleRate);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.floor(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 16000);
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
}

/** Generate silence (for triggering VAD end-of-speech). */
function generateSilence(durationSec: number, sampleRate = 16000): Buffer {
  return Buffer.alloc(Math.floor(durationSec * sampleRate) * 2);
}

async function main() {
  const url = new URL(GATEWAY_URL);
  url.searchParams.set("token", GATEWAY_TOKEN);

  console.log(`Connecting to ${GATEWAY_URL}...`);
  const ws = new WebSocket(url.toString());

  ws.on("open", () => {
    console.log("Connected!");

    // Load or generate test audio
    let audioData: Buffer;
    if (TEST_AUDIO_FILE && existsSync(TEST_AUDIO_FILE)) {
      console.log(`Loading audio from ${TEST_AUDIO_FILE}`);
      audioData = readFileSync(TEST_AUDIO_FILE);
    } else {
      console.log("Generating test sine wave (440Hz, 2s) + silence (1s)");
      const tone = generateSineWave(2, 440);
      const silence = generateSilence(1);
      audioData = Buffer.concat([tone, silence]);
    }

    // Send in chunks (simulating real-time streaming)
    const chunkSize = 3200; // 100ms at 16kHz mono 16-bit
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= audioData.length) {
        clearInterval(interval);
        console.log("Audio sent. Sending end_of_speech...");
        ws.send(JSON.stringify({ type: "end_of_speech" }));
        return;
      }
      const chunk = audioData.subarray(offset, offset + chunkSize);
      ws.send(chunk);
      offset += chunkSize;
    }, 100);
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      console.log(`[audio] Received ${(data as Buffer).length} bytes`);
    } else {
      const msg = JSON.parse(data.toString());
      console.log(`[json]`, JSON.stringify(msg, null, 2));
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`Disconnected: ${code} ${reason.toString()}`);
    process.exit(0);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    process.exit(1);
  });

  // Auto-close after 30s
  setTimeout(() => {
    console.log("Timeout, closing...");
    ws.close();
  }, 30_000);
}

void main();
