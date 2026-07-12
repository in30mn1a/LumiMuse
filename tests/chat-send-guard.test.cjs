const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();
const { canBeginChatSend } = require(path.resolve(__dirname, '../src/hooks/chat/chat-send-guard.ts'));

test('chat send guard synchronously blocks duplicate new and existing conversation sends', () => {
  assert.equal(canBeginChatSend(null, false, new Set()), true);
  assert.equal(canBeginChatSend(null, true, new Set()), false);
  assert.equal(canBeginChatSend('conv-a', false, new Set()), true);
  assert.equal(canBeginChatSend('conv-a', false, new Set(['conv-a'])), false);
  assert.equal(canBeginChatSend('conv-a', true, new Set(['conv-b'])), true);
});
