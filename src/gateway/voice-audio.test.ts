import { describe, expect, it } from "vitest";
import { calculateRms, buildWavHeader } from "./voice-audio.js";

describe("calculateRms", () => {
  it("returns 0 for empty buffer", () => {
    expect(calculateRms(Buffer.alloc(0))).toBe(0);
  });

  it("returns 0 for silence (all zeros)", () => {
    // 100 samples of silence (PCM16 = 2 bytes per sample)
    const silence = Buffer.alloc(200);
    expect(calculateRms(silence)).toBe(0);
  });

  it("returns correct RMS for known signal", () => {
    // 4 samples: [1000, -1000, 1000, -1000]
    // RMS = sqrt((1000² + 1000² + 1000² + 1000²) / 4) = 1000
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(1000, 0);
    buf.writeInt16LE(-1000, 2);
    buf.writeInt16LE(1000, 4);
    buf.writeInt16LE(-1000, 6);
    expect(calculateRms(buf)).toBe(1000);
  });

  it("returns higher RMS for louder signal", () => {
    const quiet = Buffer.alloc(4);
    quiet.writeInt16LE(100, 0);
    quiet.writeInt16LE(-100, 2);

    const loud = Buffer.alloc(4);
    loud.writeInt16LE(10000, 0);
    loud.writeInt16LE(-10000, 2);

    expect(calculateRms(loud)).toBeGreaterThan(calculateRms(quiet));
  });
});

describe("buildWavHeader", () => {
  it("produces a 44-byte header", () => {
    const header = buildWavHeader(1000, 16000, 1, 16);
    expect(header.length).toBe(44);
  });

  it("starts with RIFF magic", () => {
    const header = buildWavHeader(1000, 16000, 1, 16);
    expect(header.toString("ascii", 0, 4)).toBe("RIFF");
  });

  it("contains WAVE format", () => {
    const header = buildWavHeader(1000, 16000, 1, 16);
    expect(header.toString("ascii", 8, 12)).toBe("WAVE");
  });

  it("encodes correct file size (dataSize + 36)", () => {
    const dataSize = 32000;
    const header = buildWavHeader(dataSize, 16000, 1, 16);
    // Bytes 4-7: file size - 8 = dataSize + 36
    expect(header.readUInt32LE(4)).toBe(dataSize + 36);
  });

  it("encodes correct sample rate", () => {
    const header = buildWavHeader(1000, 16000, 1, 16);
    expect(header.readUInt32LE(24)).toBe(16000);
  });

  it("encodes PCM format (1)", () => {
    const header = buildWavHeader(1000, 16000, 1, 16);
    expect(header.readUInt16LE(20)).toBe(1);
  });

  it("encodes correct byte rate", () => {
    // byteRate = sampleRate * channels * bitsPerSample/8
    // 16000 * 1 * 2 = 32000
    const header = buildWavHeader(1000, 16000, 1, 16);
    expect(header.readUInt32LE(28)).toBe(32000);
  });

  it("encodes data chunk size", () => {
    const dataSize = 5000;
    const header = buildWavHeader(dataSize, 16000, 1, 16);
    expect(header.readUInt32LE(40)).toBe(dataSize);
  });
});
