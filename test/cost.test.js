const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateAiCostMicro, totalAiTokens } = require('../src/server');

const plan = { input_token_price_micro: 10, cached_input_token_price_micro: 3, output_token_price_micro: 20 };

test('cached input is cheaper and reasoning is billed as output', () => {
  const usage = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500, reasoningTokens: 300 };
  assert.equal(calculateAiCostMicro(usage, plan), 24_600);
});

test('cached input is a subset, not an extra token category for quota', () => {
  assert.equal(totalAiTokens({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 10 }), 140);
});
