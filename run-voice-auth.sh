#!/bin/bash
export TG_API_ID=33667981
export TG_API_HASH=057752f61adf63f5a5c387b91a8ab386
export GATEWAY_TOKEN=32d5ef6553afc2891204db823d4ef4516658ff88855587c3f15e6fc6e1838644
export TG_SESSION_PATH=/home/follox/.clawdbot/credentials/telegram-voice.session
export NODE_PATH=./node_modules
cd /home/follox/clawdbot
npx tsx src/channels/plugins/telegram-voice/test-bridge.ts
