import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowAttachments, videoWorkflowAttachments, workflowArchive } from '../dist/VideoWorkflow.js';
import { VideoGenerationService } from '../dist/VideoGeneration.js';

const prompt = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'A duck = 🦆; #hello\nline two' } } };
const workflow = { nodes: [], links: [], version: 0.4 };
const decode = file => JSON.parse(file.attachment.toString());
const unzip = archive => JSON.parse(execFileSync('python3', ['-c',
    'import sys,io,json,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({n:json.loads(z.read(n)) for n in z.namelist()}))'],
    { input: archive.attachment, encoding: 'utf8' }));

test('exports directly loadable graphs, prefers UI workflows and ignores unrelated metadata', () => {
    assert.deepEqual(decode(workflowAttachments({ prompt: JSON.stringify(prompt) }, 'duck.mp4')[0]), prompt);
    const files = workflowAttachments({ prompt: JSON.stringify(prompt), workflow: JSON.stringify(workflow), token: 'private' }, 'duck.mp4');
    assert.equal(files[0].name, 'duck.workflow.json');
    assert.deepEqual(decode(files[0]), workflow);
    for (const tags of [{}, { prompt: 'invalid' }, { prompt: '{}' }, { prompt: '{"token":"private"}' }]) {
        assert.deepEqual(workflowAttachments(tags, 'duck.mp4'), []);
    }
});

test('archives every scene in one standard ZIP without JSON previews or attachment-count limits', () => {
    const files = workflowAttachments({ dave_workflows: JSON.stringify([{ prompt }, { workflow }]) }, 'duck.mp4');
    assert.deepEqual(files.map(decode), [prompt, workflow]);
    assert.equal(files[1].name, 'duck-scene-2.workflow.json');
    const many = workflowAttachments({ dave_workflows: JSON.stringify(Array(10).fill({ prompt })) }, 'duck.mp4');
    assert.equal(many.length, 10);
    const archive = workflowArchive(many, 'duck.mp4');
    assert.equal(archive.name, 'duck.workflows.zip');
    assert.deepEqual(Object.values(unzip(archive)), Array(10).fill(prompt));
    assert.deepEqual(unzip(workflowArchive(workflowAttachments({ prompt }, '🦆.mp4'), '🦆.mp4')), { '🦆.workflow.json': prompt });
    assert.equal(workflowArchive([], 'duck.mp4'), null);
    assert.deepEqual(workflowAttachments({ prompt: { '1': { class_type: 'Text', inputs: { text: 'a'.repeat(8 * 1024 * 1024) } } } }, 'duck.mp4'), []);
});

test('delivers the MP4 and one ZIP on initial delivery and regeneration, retaining all three scene workflows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-workflow-'));
    try {
        const path = join(directory, 'test.mp4');
        const scenes = [prompt, workflow, prompt];
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:d=0.1',
            '-metadata', `prompt=${JSON.stringify(prompt)}`,
            '-metadata', `dave_workflows=${JSON.stringify([{ prompt }, { workflow }, { prompt }])}`,
            '-movflags', '+use_metadata_tags', path]);
        assert.deepEqual((await videoWorkflowAttachments(path, 'test.mp4')).map(decode), scenes);
        const service = new VideoGenerationService({ user: { id: 'bot' } });
        const job = { id: 'd8572423-test', model: 'minimax', prompt: 'A duck waves.', result_path: path,
            command_message_id: 'command', delivery_revision: 0, delivered_revision: 0 };
        let sent;
        const existing = { edit: async payload => { sent = payload; return existing; } };
        const channel = { messages: { fetch: async id => typeof id === 'object' ? [] : id === 'command'
            ? { reply: async payload => { sent = payload; return existing; } } : existing } };
        await service.postDelivery(job, { channel });
        assert.equal(sent.files.length, 2);
        assert.equal(sent.files[0].attachment, path);
        assert.ok(sent.files[1].name.endsWith('.workflows.zip'));
        assert.deepEqual(Object.values(unzip(sent.files[1])), scenes);
        await service.postDelivery({ ...job, delivery_message_id: 'original', delivery_revision: 1 }, { channel });
        assert.deepEqual(sent.attachments, []);
        assert.equal(sent.files.length, 2);
        assert.equal(sent.files[0].attachment, path);
        assert.deepEqual(Object.values(unzip(sent.files[1])), scenes);
        assert.deepEqual((await videoWorkflowAttachments(path, 'test.mp4')).map(decode), scenes);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
