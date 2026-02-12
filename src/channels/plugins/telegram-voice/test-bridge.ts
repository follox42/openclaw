#!/usr/bin/env tsx
/**
 * @module telegram-voice/test-bridge
 * Standalone test script: connects to Telegram as a userbot,
 * waits for incoming calls, and bridges them to the gateway.
 *
 * Usage:
 *   TG_API_ID=... TG_API_HASH=... GATEWAY_TOKEN=... npx tsx test-bridge.ts
 *
 * On first run, it will prompt for phone number and verification code
 * to create a session. The session is saved to disk for reuse.
 */

import fs from "node:fs";
import * as readline from "node:readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

/** Simple terminal input helper. */
function askQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}
import { loadVoiceConfig } from "./config.js";
import { TelegramVoiceBridge } from "./voice-bridge.js";

async function main(): Promise<void> {
  const config = loadVoiceConfig();

  if (!config.apiId || !config.apiHash) {
    console.error("Set TG_API_ID and TG_API_HASH environment variables");
    process.exit(1);
  }
  if (!config.gatewayToken) {
    console.error("Set GATEWAY_TOKEN environment variable");
    process.exit(1);
  }

  // Load or create session
  let sessionStr = "";
  if (fs.existsSync(config.sessionPath)) {
    sessionStr = fs.readFileSync(config.sessionPath, "utf-8").trim();
    console.log("Loaded existing session");
  }

  const client = new TelegramClient(new StringSession(sessionStr), config.apiId, config.apiHash, {
    connectionRetries: 5,
  });

  // Interactive auth on first run
  await client.start({
    phoneNumber: async () => askQuestion("Enter your phone number: "),
    phoneCode: async () => askQuestion("Enter the code you received: "),
    password: async () => askQuestion("Enter your 2FA password (if any): "),
    onError: (err) => console.error("Auth error:", err),
  });

  // Save session for reuse
  const newSession = client.session.save() as unknown as string;
  fs.writeFileSync(config.sessionPath, newSession);
  console.log("Session saved to", config.sessionPath);

  const me = await client.getMe();
  console.log(`Logged in as ${(me as any).firstName} (ID: ${(me as any).id})`);

  // Create and start the voice bridge
  const bridge = new TelegramVoiceBridge(config);
  await bridge.callHandler.start(client);

  bridge.on("event", (evt) => {
    console.log(
      "[event]",
      JSON.stringify(evt, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
  });

  console.log("\n✅ Voice bridge running. Waiting for incoming calls...");
  console.log(`   Allowed users: ${config.allowedUserIds.map(String).join(", ") || "all"}`);
  console.log(`   Auto-answer: ${config.autoAnswer}`);
  console.log(`   Gateway: ${config.gatewayVoiceUrl}`);
  console.log(`   Max duration: ${config.maxDurationSec}s\n`);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await bridge.destroy();
    await client.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
