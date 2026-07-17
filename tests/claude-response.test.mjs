import assert from 'node:assert/strict';
import test from 'node:test';

import {
    extractClaudeResponseText,
    getClaudeNoTextError,
    shouldRetryClaudeNoText,
    summarizeClaudeResponse,
} from '../dist/ClaudeResponse.js';

test('extracts Claude text while ignoring thinking and server-tool blocks', () => {
    assert.equal(extractClaudeResponseText([
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: 'First answer.' },
        { type: 'server_tool_use', name: 'web_search' },
        { type: 'text', text: 'Second answer.' },
    ]), 'First answer.\n\nSecond answer.');
});

test('retries ordinary no-text responses only within the configured limit', () => {
    assert.equal(shouldRetryClaudeNoText('end_turn', 0, 1), true);
    assert.equal(shouldRetryClaudeNoText('end_turn', 1, 1), false);
    assert.equal(shouldRetryClaudeNoText('refusal', 0, 1), false);
    assert.equal(shouldRetryClaudeNoText('pause_turn', 0, 1), false);
});

test('returns specific errors for actionable Claude stop reasons', () => {
    assert.match(getClaudeNoTextError('pause_turn'), /web-search turn/);
    assert.match(getClaudeNoTextError('refusal'), /declined/);
    assert.match(getClaudeNoTextError('max_tokens'), /token limit/);
});

test('summarizes Claude responses without logging their content', () => {
    assert.deepEqual(summarizeClaudeResponse({
        id: 'msg_test',
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'private answer' }],
        usage: { input_tokens: 12, output_tokens: 3 },
    }), {
        id: 'msg_test',
        model: 'claude-fable-5',
        stopReason: 'end_turn',
        contentTypes: ['text'],
        inputTokens: 12,
        outputTokens: 3,
    });
});
