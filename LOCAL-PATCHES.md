# LOCAL-PATCHES.md — Custom Modifications to OpenClaw

These patches are local modifications that need to be reapplied after `openclaw update`.

## Active Patches

### 1. Mobile UI Redesign (3 commits on main)

- `479b44e42` fix(ui): improve mobile responsiveness
- `ea51b36cc` feat(ui): mobile redesign — messaging app style
- `552bb06d9` fix(ui): prevent mobile scroll overflow
- **Files**: `ui/src/styles/layout.mobile.css`, `ui/src/ui/views/chat.ts`

### 2. 1M Context Window Headers Passthrough

- **File**: `src/agents/pi-embedded-runner/extra-params.ts`
- **Purpose**: Allow `params.headers` in model config to be passed through to the provider SDK
- **Why**: Anthropic 4.6 models need `anthropic-beta: context-1m-2025-08-07` header for 1M context
- **Config**: Set in `openclaw.json` under `agents.defaults.models.*.params.headers`
- **Diff**: See `patches/extra-params-headers.patch`

### 3. Voice Bridge (branch follox/custom, commit 54857d5)

- Telegram voice bridge (gramjs MTProto + WebRTC)
- Voice WebSocket endpoint
- **Status**: On separate branch, not on main currently

## How to Reapply After Update

```bash
cd /home/follox/clawdbot

# 1. Apply extra-params headers patch
git apply patches/extra-params-headers.patch

# 2. Mobile UI — cherry-pick or reapply
# (may need manual merge if upstream changed layout.mobile.css)
git cherry-pick 479b44e42 ea51b36cc 552bb06d9

# 3. Rebuild
pnpm build
```

## Config (openclaw.json)

The 1M tokens config is in openclaw.json and survives updates:

```json
{
  "agents.defaults.contextTokens": 1000000,
  "agents.defaults.models.anthropic/claude-opus-4-6.params.headers.anthropic-beta": "context-1m-2025-08-07",
  "agents.defaults.models.anthropic/claude-sonnet-4-6.params.headers.anthropic-beta": "context-1m-2025-08-07"
}
```
