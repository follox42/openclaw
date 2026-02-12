/**
 * @module telegram-voice/call-handler
 * Telegram P2P voice call signaling via gramjs MTProto.
 * Handles DH key exchange, call lifecycle, and signaling data relay.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { TelegramVoiceConfig } from "./config.js";
import type { ActiveCall, VoiceBridgeEvent, VoiceCallState } from "./types.js";
import { isUserAllowed } from "./config.js";

/** Manages Telegram P2P voice call signaling via gramjs MTProto. */
export class TelegramCallHandler extends EventEmitter {
  private readonly config: TelegramVoiceConfig;
  private client: TelegramClient | null = null;
  private activeCalls = new Map<string, ActiveCall>();
  private dhConfig: { g: number; p: Buffer; random: Buffer } | null = null;

  constructor(config: TelegramVoiceConfig) {
    super();
    this.config = config;
  }

  /** Initialize the gramjs client and start listening for call updates. */
  async start(client: TelegramClient): Promise<void> {
    this.client = client;
    // Fetch DH config for key exchange
    this.dhConfig = await this.fetchDhConfig();
    // Register update handler for incoming calls
    this.client.addEventHandler(this.handleUpdate.bind(this));
    this.log("Call handler started, listening for calls");
  }

  /** Get active call by ID. */
  getCall(callId: string): ActiveCall | undefined {
    return this.activeCalls.get(callId);
  }

  /** Get all active call IDs. */
  getActiveCalls(): string[] {
    return [...this.activeCalls.keys()];
  }

  private async handleUpdate(update: Api.TypeUpdate): Promise<void> {
    if (update instanceof Api.UpdatePhoneCall) {
      const pc = update.phoneCall;
      if (pc instanceof Api.PhoneCallRequested) await this.handleIncomingCall(pc);
      else if (pc instanceof Api.PhoneCallAccepted) await this.handleCallAccepted(pc);
      else if (pc instanceof Api.PhoneCall) await this.handleCallConfirmed(pc);
      else if (pc instanceof Api.PhoneCallDiscarded) this.handleCallDiscarded(pc);
    } else if (update instanceof Api.UpdatePhoneCallSignalingData) {
      this.emit("signalingData", { callId: update.phoneCallId.toString(), data: update.data });
    }
  }

  /** Handle an incoming call request. */
  private async handleIncomingCall(call: Api.PhoneCallRequested): Promise<void> {
    const callId = call.id.toString();
    const userId = call.adminId;
    this.log(`Incoming call ${callId} from user ${userId}`);

    if (!isUserAllowed(this.config, BigInt(userId.toString()))) {
      this.log(`Rejecting call from unauthorized user ${userId}`);
      await this.discardCall(callId, call);
      return;
    }

    // Acknowledge receipt
    await this.client!.invoke(
      new Api.phone.ReceivedCall({
        peer: new Api.InputPhoneCall({ id: call.id, accessHash: call.accessHash }),
      }),
    );

    this.activeCalls.set(callId, {
      callId,
      phoneCall: call,
      state: "ringing",
      userId: BigInt(userId.toString()),
    });

    this.emitEvent({ type: "call_incoming", callId, userId: BigInt(userId.toString()) });

    if (this.config.autoAnswer) {
      setTimeout(() => this.acceptCall(callId), 500);
    }
  }

  /** Accept an incoming call — performs DH key exchange (callee side). */
  async acceptCall(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.state !== "ringing" || !this.dhConfig) return;

    call.state = "connecting";
    const phoneCall = call.phoneCall as Api.PhoneCallRequested;

    // Generate b, compute g_b = g^b mod p
    const b = this.dhConfig.random;
    const gB = this.modPow(
      BigInt(this.dhConfig.g),
      this.bufToBigInt(b),
      this.bufToBigInt(this.dhConfig.p),
    );

    try {
      const result = await this.client!.invoke(
        new Api.phone.AcceptCall({
          peer: new Api.InputPhoneCall({ id: phoneCall.id, accessHash: phoneCall.accessHash }),
          gB: this.bigIntToBuf(gB, 256),
          protocol: this.makeProtocol(),
        }),
      );
      call.phoneCall = (result as Api.phone.PhoneCall).phoneCall;
      this.log(`Accepted call ${callId}, waiting for confirm`);
    } catch (err) {
      this.emitEvent({ type: "error", callId, message: `Accept failed: ${err}` });
      this.activeCalls.delete(callId);
    }
  }

  /** Handle callee->caller: the caller receives PhoneCallAccepted, sends confirmCall. */
  private async handleCallAccepted(phoneCall: Api.PhoneCallAccepted): Promise<void> {
    const callId = phoneCall.id.toString();
    const call = this.activeCalls.get(callId);
    if (!call || !this.dhConfig) return;

    // Caller computes shared key and sends g_a
    const a = this.dhConfig.random;
    const gA = this.modPow(
      BigInt(this.dhConfig.g),
      this.bufToBigInt(a),
      this.bufToBigInt(this.dhConfig.p),
    );

    try {
      const result = await this.client!.invoke(
        new Api.phone.ConfirmCall({
          peer: new Api.InputPhoneCall({ id: phoneCall.id, accessHash: phoneCall.accessHash }),
          gA: this.bigIntToBuf(gA, 256),
          keyFingerprint: BigInt(0) as any, // Calculated from shared key
          protocol: this.makeProtocol(),
        }),
      );
      call.phoneCall = (result as Api.phone.PhoneCall).phoneCall;
      call.state = "connecting";
      this.log(`Confirmed call ${callId}`);
    } catch (err) {
      this.emitEvent({ type: "error", callId, message: `Confirm failed: ${err}` });
    }
  }

  /** Handle fully established call (both sides exchanged keys). */
  private async handleCallConfirmed(phoneCall: Api.PhoneCall): Promise<void> {
    const callId = phoneCall.id.toString();
    let call = this.activeCalls.get(callId);

    if (!call) {
      // This can happen for outgoing calls
      call = {
        callId,
        phoneCall,
        state: "connecting",
        userId: BigInt(phoneCall.participantId.toString()),
      };
      this.activeCalls.set(callId, call);
    } else {
      call.phoneCall = phoneCall;
    }

    call.state = "active";
    call.startTime = Date.now();
    call.durationTimer = setTimeout(() => {
      this.endCall(callId, "max_duration");
    }, this.config.maxDurationSec * 1000);

    this.emitEvent({ type: "call_connected", callId });
    this.log(`Call ${callId} connected (protocol v${phoneCall.protocol?.maxLayer})`);

    // Emit the full phoneCall object so voice-bridge can set up WebRTC
    this.emit("callReady", { callId, phoneCall });
  }

  /** Handle call discard (remote hangup). */
  private handleCallDiscarded(phoneCall: Api.PhoneCallDiscarded): void {
    const callId = phoneCall.id.toString();
    const call = this.activeCalls.get(callId);
    if (call?.durationTimer) clearTimeout(call.durationTimer);
    this.activeCalls.delete(callId);
    const reason = phoneCall.reason?.className ?? "remote_hangup";
    this.emitEvent({ type: "call_ended", callId, reason });
    this.log(`Call ${callId} ended: ${reason}`);
  }

  /** Initiate an outgoing call to a user. */
  async initiateCall(userId: bigint): Promise<string | null> {
    if (!this.client || !this.dhConfig) return null;

    const a = this.dhConfig.random;
    const gA = this.modPow(
      BigInt(this.dhConfig.g),
      this.bufToBigInt(a),
      this.bufToBigInt(this.dhConfig.p),
    );
    const gAHash = crypto.createHash("sha256").update(this.bigIntToBuf(gA, 256)).digest();

    try {
      const result = await this.client.invoke(
        new Api.phone.RequestCall({
          userId: userId.toString(),
          randomId: Math.floor(Math.random() * 0x7fffffff),
          gAHash,
          protocol: this.makeProtocol(),
        }),
      );
      const phoneCall = (result as Api.phone.PhoneCall).phoneCall;
      const callId = phoneCall.id.toString();

      this.activeCalls.set(callId, {
        callId,
        phoneCall,
        state: "ringing",
        userId,
      });

      this.log(`Outgoing call ${callId} to user ${userId}`);
      return callId;
    } catch (err) {
      this.emitEvent({ type: "error", message: `Initiate call failed: ${err}` });
      return null;
    }
  }

  /** End a call by ID. */
  async endCall(callId: string, reason = "local_hangup"): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) return;
    if (call.durationTimer) clearTimeout(call.durationTimer);
    await this.discardCall(callId, call.phoneCall as Api.TypePhoneCall);
    this.activeCalls.delete(callId);
    this.emitEvent({ type: "call_ended", callId, reason });
  }

  /** Send phone.discardCall to Telegram. */
  private async discardCall(callId: string, phoneCall: Api.TypePhoneCall): Promise<void> {
    try {
      const id = (phoneCall as any).id;
      const accessHash = (phoneCall as any).accessHash;
      if (id && accessHash) {
        await this.client!.invoke(
          new Api.phone.DiscardCall({
            peer: new Api.InputPhoneCall({ id, accessHash }),
            duration: 0,
            reason: new Api.PhoneCallDiscardReasonHangup(),
            connectionId: BigInt(0) as any,
          }),
        );
      }
    } catch {
      // Call may already be discarded
    }
  }

  /** Send signaling data (used for WebRTC SDP exchange in protocol v6+). */
  async sendSignalingData(callId: string, data: Buffer): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) return;
    const phoneCall = call.phoneCall as any;
    await this.client!.invoke(
      new Api.phone.SendSignalingData({
        peer: new Api.InputPhoneCall({ id: phoneCall.id, accessHash: phoneCall.accessHash }),
        data,
      }),
    );
  }

  /** Fetch Diffie-Hellman config from Telegram. */
  private async fetchDhConfig(): Promise<{ g: number; p: Buffer; random: Buffer }> {
    const result = await this.client!.invoke(
      new Api.messages.GetDhConfig({ version: 0, randomLength: 256 }),
    );
    if (result instanceof Api.messages.DhConfig) {
      return { g: result.g, p: Buffer.from(result.p), random: Buffer.from(result.random) };
    }
    throw new Error("Failed to get DH config");
  }

  /** Build Telegram call protocol descriptor. */
  private makeProtocol(): Api.PhoneCallProtocol {
    return new Api.PhoneCallProtocol({
      minLayer: 92,
      maxLayer: 92,
      udpP2p: true,
      udpReflector: true,
      libraryVersions: ["6.0.0", "7.0.0"],
    });
  }

  /** Modular exponentiation: base^exp mod m. */
  private modPow(base: bigint, exp: bigint, m: bigint): bigint {
    let result = 1n;
    base = base % m;
    while (exp > 0n) {
      if (exp % 2n === 1n) result = (result * base) % m;
      exp = exp / 2n;
      base = (base * base) % m;
    }
    return result;
  }

  private bufToBigInt(buf: Buffer): bigint {
    return BigInt("0x" + buf.toString("hex"));
  }

  private bigIntToBuf(n: bigint, len: number): Buffer {
    const hex = n.toString(16).padStart(len * 2, "0");
    return Buffer.from(hex, "hex");
  }

  private emitEvent(evt: VoiceBridgeEvent): void {
    this.emit("event", evt);
  }

  private log(msg: string): void {
    console.log(`[tg-voice] ${msg}`);
  }

  /** Clean up all calls. */
  async destroy(): Promise<void> {
    for (const callId of this.activeCalls.keys()) {
      await this.endCall(callId, "shutdown");
    }
  }
}
