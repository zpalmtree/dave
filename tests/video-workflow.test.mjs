import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowAttachments, videoWorkflowAttachments } from '../dist/VideoWorkflow.js';
import { VideoGenerationService } from '../dist/VideoGeneration.js';

const prompt = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'A duck = 🦆; #hello\nline two' } } };
const workflow = { nodes: [], links: [], version: 0.4 };
const decode = file => JSON.parse(file.attachment.toString());

test('exports directly loadable graphs, prefers UI workflows and ignores unrelated metadata', () => {
    assert.deepEqual(decode(workflowAttachments({ prompt: JSON.stringify(prompt) }, 'duck.mp4')[0]), prompt);
    const files = workflowAttachments({ prompt: JSON.stringify(prompt), workflow: JSON.stringify(workflow), token: 'private' }, 'duck.mp4');
    assert.equal(files[0].name, 'duck.workflow.json');
    assert.deepEqual(decode(files[0]), workflow);
    for (const tags of [{}, { prompt: 'invalid' }, { prompt: '{}' }, { prompt: '{"token":"private"}' }]) {
        assert.deepEqual(workflowAttachments(tags, 'duck.mp4'), []);
    }
});

test('preserves each scene and stays within Discord attachment and size limits', () => {
    const files = workflowAttachments({ dave_workflows: JSON.stringify([{ prompt }, { workflow }]) }, 'duck.mp4');
    assert.deepEqual(files.map(decode), [prompt, workflow]);
    assert.equal(files[1].name, 'duck-scene-2.workflow.json');
    const many = workflowAttachments({ dave_workflows: JSON.stringify(Array(10).fill({ prompt })) }, 'duck.mp4');
    assert.equal(many.length, 1);
    assert.deepEqual(decode(many[0]).workflows, Array(10).fill(prompt));
    assert.deepEqual(workflowAttachments({ prompt: { '1': { class_type: 'Text', inputs: { text: 'a'.repeat(8 * 1024 * 1024) } } } }, 'duck.mp4'), []);
});

test('reads actual MP4 metadata and includes it on initial delivery and regeneration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-workflow-'));
    try {
        const path = join(directory, 'test.mp4');
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:d=0.1',
            '-metadata', `prompt=${JSON.stringify(prompt)}`, '-movflags', '+use_metadata_tags', path]);
        assert.deepEqual(decode((await videoWorkflowAttachments(path, 'test.mp4'))[0]), prompt);
        const service = new VideoGenerationService({ user: { id: 'bot' } });
        const job = { id: 'd8572423-test', model: 'minimax', prompt: 'A duck waves.', result_path: path,
            command_message_id: 'command', delivery_revision: 0, delivered_revision: 0 };
        let sent;
        const existing = { edit: async payload => { sent = payload; return existing; } };
        const channel = { messages: { fetch: async id => typeof id === 'object' ? [] : id === 'command'
            ? { reply: async payload => { sent = payload; return existing; } } : existing } };
        await service.postDelivery(job, { channel });
        assert.equal(sent.files.length, 2);
        assert.deepEqual(decode(sent.files[1]), prompt);
        await service.postDelivery({ ...job, delivery_message_id: 'original', delivery_revision: 1 }, { channel });
        assert.deepEqual(sent.attachments, []);
        assert.deepEqual(decode(sent.files[1]), prompt);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
