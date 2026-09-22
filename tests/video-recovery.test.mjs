import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VideoBroker } from '../dist/VideoBroker.js';
import { approvedLocalRecoveryContract, approvedRecoveryContract, recoveryHash, repairVideoTiming, recoverySpeechMatches, recoveryLimitReached,
    VIDEO_RECOVERY_VERSION } from '../dist/VideoRecovery.js';
import { requestPlannerResponse, stageFrontierDialogueVisually } from '../dist/VideoFrontierPlanner.js';
import { prepareRecoveryPlan, RecoveryLocalPlanRequired, RecoveryStoppedError, reviewRecoveryMedia,
    VIDEO_RECOVERY_REVIEW_VERSION } from '../dist/VideoRecoveryService.js';
import { FrontierPlannerRejectedError } from '../dist/VideoFrontierPlanner.js';
import { VideoKeyframeError } from '../dist/VideoKeyframeProvider.js';

function plan(text = 'We made it home.') {
    return { intent: 'Two adult explorers return home.', continuity_bible: 'The same explorers.',
        prompt_analysis: { frontier_handling: { disposition: 'fulfill', reason_code: 'none' },
            dialogue_contract: { mode: 'verbatim', lines: [{ text, verbatim: true }] },
            subjects: ['two adult explorers'], actions: ['return home'] },
        keyframe: { recommended: true, prompt: 'Two explorers at home.' },
        segments: [{ title: 'Home', transition: 'start', target_seconds: 5,
            shots: [{ duration_seconds: 5, visual: 'Both explorers arrive home and wave.', camera: 'Wide',
                audio: 'Wind', dialogue: [{ speaker_id: 'explorer', language: 'English', delivery: 'natural', text }] }] }] };
}

test('timing repair preserves long dialogue, beat order, keyframe indexes, and is idempotent', () => {
    const text = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
    const value = plan(text);
    value.segments.push(structuredClone(plan('Welcome back.').segments[0]));
    value.segments[1].transition = 'cut';
    value.segment_keyframes = [{ segment_index: 2, prompt: 'Second scene' }];
    repairVideoTiming(value, 15, 5);
    const spoken = value.segments.flatMap(s => s.shots.flatMap(shot => shot.dialogue.map(line => line.text))).join(' ');
    assert.equal(spoken, `${text} Welcome back.`);
    assert.ok(value.segments.every(s => s.target_seconds <= 15));
    assert.equal(value.segment_keyframes[0].segment_index, value.segments.length);
    const before = structuredClone(value);
    repairVideoTiming(value, 15, 5);
    assert.deepEqual(value, before);
});

test('contract cannot approve omitted dialogue, bypassed quality, or policy rejection', () => {
    const value = plan();
    assert.doesNotThrow(() => approvedRecoveryContract(value, 'explorers return'));
    value.segments[0].shots[0].dialogue = [];
    assert.throws(() => approvedRecoveryContract(value, 'explorers return'), /dialogue/);
    value.prompt_analysis.frontier_handling.disposition = 'reject';
    assert.throws(() => approvedRecoveryContract(value, 'explorers return'), /approved story/);
    assert.throws(() => approvedRecoveryContract({ ...plan(), quality_gate_bypassed: true }, 'explorers'), /preserves/);
});

test('timing repair reserves speech time within a shot even when the whole segment has enough time', () => {
    const value = plan('Everything is fake, even the little war happening down by the feeder.');
    const speaking = value.segments[0].shots[0];
    speaking.duration_seconds = 2;
    value.segments[0].shots.unshift({ ...speaking, duration_seconds: 10, dialogue: [] });
    value.segments[0].target_seconds = 12;
    repairVideoTiming(value, 15, 5);
    const repaired = value.segments.flatMap(s => s.shots).find(s => s.dialogue.length);
    assert.ok(repaired.duration_seconds > 6);
    assert.equal(repaired.dialogue[0].text, speaking.dialogue[0].text);
    assert.equal(value.segments[1].transition, 'cut');
});

test('speech verification tolerates punctuation but rejects missing lines and silent audio', () => {
    assert.equal(recoverySpeechMatches('We made it home!', 'We made it home.'), true);
    assert.equal(recoverySpeechMatches('We made it home.', ''), false);
    assert.equal(recoverySpeechMatches('We made it home.', 'We made it.'), false);
    assert.equal(recoverySpeechMatches('', 'Invented speech'), false);
    assert.equal(recoverySpeechMatches('Just stop feeding the khat squirrels and wait for them to surrender.',
        'Just stop feeding the caught squirrels and wait for them to surrender.'), true);
});

test('speech verification accepts Spanish vowel accents without accepting missing or changed words', () => {
    const expected = 'mae Luis libereme, necesito cotizar mae, saqueme de aqui';
    const transcript = 'Mae, Luis, libéreme, necesito cotizar, mae, sáqueme de aquí.';
    assert.equal(recoverySpeechMatches(expected, transcript), true);
    assert.equal(recoverySpeechMatches(transcript, expected), true);
    assert.equal(recoverySpeechMatches(expected, transcript.normalize('NFD')), true);
    assert.equal(recoverySpeechMatches('Sí, está aquí.', 'Si, esta aqui.'), true);
    assert.equal(recoverySpeechMatches('El pingüino llegó.', 'El pinguino llego.'), true);
    assert.equal(recoverySpeechMatches(expected, 'Mae Luis libéreme'), false);
    assert.equal(recoverySpeechMatches(expected, 'Mae Luis'), false);
    assert.equal(recoverySpeechMatches(expected, ''), false);
    assert.equal(recoverySpeechMatches('Sáqueme de aquí.', 'Déjeme aquí.'), false);
    assert.equal(recoverySpeechMatches('Un año.', 'Un ano.'), false);
});

test('approved dialogue may add Spanish accents while preserving the authored text', () => {
    const value = plan('mae Luis libereme, necesito cotizar mae, saqueme de aqui');
    const text = 'Mae, Luis, libéreme, necesito cotizar, mae, sáqueme de aquí.';
    value.segments[0].shots[0].dialogue[0].text = text;
    const contract = approvedRecoveryContract(value, 'John pleads at the bars');
    assert.equal(contract.segments[0].shots[0].dialogue[0].text, text);
    assert.equal(value.segments[0].shots[0].dialogue[0].text, text);
});

function mockMediaReview(t, transcript, decision) {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (url.includes('generativelanguage.googleapis.com')) {
            return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: transcript }] } }] }),
                { status: 200, headers: { 'content-type': 'application/json' } });
        }
        assert.equal(url, 'https://api.openai.com/v1/responses');
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(decision) }),
            { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return requests;
}

for (const example of [
    { name: 'extra words and flair', expected: 'We made it home.', transcript: 'Hey, we finally made it home, my friend!', acceptable: true },
    { name: 'Spanish paraphrasing', expected: 'mae Luis libereme, necesito cotizar mae, saqueme de aqui',
        transcript: 'Luis, déjeme salir, necesito hacer una cotización, por favor.', acceptable: true },
    { name: 'missing essential points', expected: 'mae Luis libereme, necesito cotizar mae, saqueme de aqui',
        transcript: 'Mae Luis', acceptable: false },
    { name: 'a meaning reversal despite similar wording', expected: 'We can safely go home now because the storm is over.',
        transcript: 'We cannot safely go home now because the storm is over.', acceptable: false },
]) {
    test(`speech review delegates ${example.name} to the meaning reviewer`, async t => {
        const requests = mockMediaReview(t, example.transcript, { acceptable: example.acceptable, permitted: true,
            issues: example.acceptable ? [] : ['The intended message is missing or changed.'] });
        const value = plan(example.expected);
        const contract = approvedRecoveryContract(value, 'The character delivers the requested message.');
        const result = await reviewRecoveryMedia(contract, value.segments[0],
            { kind: 'video', frames: ['data:image/jpeg;base64,YQ=='], audio: 'YQ==' }, {});
        assert.equal(requests.length, 1, 'Nonempty speech must reach the meaning reviewer regardless of word distance.');
        const review = JSON.parse(requests[0].input[0].content[0].text);
        assert.equal(review.expected_speech, example.expected);
        assert.equal(review.transcript, example.transcript);
        assert.equal(result.acceptable, example.acceptable);
        assert.equal(result.transcript, example.transcript);
    });
}

test('speech review still rejects silent or missing audio before the meaning reviewer', async t => {
    const requests = mockMediaReview(t, '', { acceptable: true, permitted: true, issues: [] });
    const value = plan();
    const contract = approvedRecoveryContract(value, 'The character delivers the requested message.');
    for (const audio of ['YQ==', undefined]) {
        const result = await reviewRecoveryMedia(contract, value.segments[0],
            { kind: 'video', frames: ['data:image/jpeg;base64,YQ=='], audio }, {});
        assert.equal(result.acceptable, false);
    }
    assert.equal(requests.length, 0);
});

test('timing repair fits several turns without packing an oversized split into the previous turn', () => {
    const value = plan('Please listen carefully while I explain what happened last night.');
    const long = Array.from({length: 70}, (_, index) => `word${index}`).join(' ');
    value.segments[0].shots[0].dialogue.push({speaker_id: 'other', text: long});
    const original = value.segments[0].shots[0].dialogue.map(line => line.text).join(' ');
    repairVideoTiming(value, 15, 5);
    assert.equal(value.segments.flatMap(s => s.shots.flatMap(shot => shot.dialogue.map(line => line.text))).join(' '), original);
    for (const segment of value.segments) {
        const turns = segment.shots.flatMap(shot => shot.dialogue);
        const words = turns.map(line => line.text).join(' ').split(/\s+/).length;
        assert.ok(words / (140 / 60) + turns.length * 0.3 + 1.25 <= segment.target_seconds);
    }
});

test('technical planning failure retries the original brief once', async () => {
    let calls = 0;
    await prepareRecoveryPlan({ prompt: 'explorers', model: 'minimax', requester: 'test', sources: [], options: {},
        planner: async prompt => { assert.equal(prompt, 'explorers'); if (++calls === 1) throw new Error('timeout'); return plan(); } });
    assert.equal(calls, 2);
});

test('a frontier rejection routes the original brief to local planning without a rewrite or another frontier attempt', async t => {
    t.mock.method(globalThis, 'fetch', () => { assert.fail('No automatic adaptation request is allowed.'); });
    const analysis = { dialogue_contract: { mode: 'verbatim', lines: [] } };
    for (const reason of ['provider_policy', 'cannot_faithfully_fulfill', 'unsupported_media', 'other']) {
        let calls = 0;
        await assert.rejects(prepareRecoveryPlan({ prompt: 'The original brief', model: 'minimax', requester: 'test', sources: [], options: {},
            planner: async prompt => {
                assert.equal(prompt, 'The original brief'); calls++;
                throw new FrontierPlannerRejectedError(reason, 'Provider refusal details', analysis);
            },
        }), error => error instanceof RecoveryLocalPlanRequired && error.reasonCode === reason
            && error.promptAnalysis === analysis);
        assert.equal(calls, 1, reason);
    }
    const rejected = plan();
    rejected.prompt_analysis.frontier_handling = { disposition: 'reject', reason_code: 'provider_policy' };
    await assert.rejects(prepareRecoveryPlan({ prompt: 'The original brief', model: 'minimax', requester: 'test', sources: [], options: {},
        planner: async () => rejected,
    }), error => error instanceof RecoveryLocalPlanRequired && error.promptAnalysis === rejected.prompt_analysis);
});

test('sexual content involving minors stops instead of reaching the local planner', async () => {
    await assert.rejects(prepareRecoveryPlan({ prompt: 'The original brief', model: 'minimax', requester: 'test', sources: [], options: {},
        planner: async () => { throw new FrontierPlannerRejectedError('minor_sexualization', 'Declined.'); },
    }), error => error instanceof RecoveryStoppedError && /never planned locally/.test(error.message));
});

test('an OpenAI moderation block is a frontier rejection rather than an outage', async t => {
    let error = { code: 'invalid_prompt', message: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.' };
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error }),
        { status: 400, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(requestPlannerResponse({ model: 'gpt-5.6-sol', input: 'x' }, AbortSignal.timeout(5000), 'test', {}),
        error => error instanceof FrontierPlannerRejectedError && error.reasonCode === 'provider_policy');
    error = { message: 'Bad schema.' };
    await assert.rejects(requestPlannerResponse({ model: 'gpt-5.6-sol', input: 'x' }, AbortSignal.timeout(5000), 'test', {}),
        error => !(error instanceof FrontierPlannerRejectedError) && /Bad schema/.test(error.message));
});

// Mock fetch once per test: a second mock of the same method is not restored cleanly.
function mockRefusingReview(t, transcript, reply) {
    const mock = { requests: [], transcript, reply };
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (url.includes('generativelanguage.googleapis.com')) {
            mock.requests.push({ gemini: JSON.parse(init.body) });
            return new Response(JSON.stringify(mock.transcript === null
                ? { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }
                : { candidates: [{ content: { role: 'model', parts: [{ text: mock.transcript }] } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        }
        mock.requests.push({ openai: JSON.parse(init.body) });
        return new Response(JSON.stringify(mock.reply), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return mock;
}

test('a refused or unpermitted frontier review hands the artifact to the local reviewer', async t => {
    const value = plan();
    const contract = approvedRecoveryContract(value, 'The character delivers the requested message.');
    const body = { kind: 'video', frames: ['data:image/jpeg;base64,YQ=='], audio: 'YQ==' };
    const mock = mockRefusingReview(t, 'We made it home.', null);
    for (const reply of [
        { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }] },
        { status: 'completed', output_text: JSON.stringify({ acceptable: false, permitted: false, issues: ['Prohibited imagery.'] }) },
    ]) {
        mock.reply = reply;
        const result = await reviewRecoveryMedia(contract, value.segments[0], body, {});
        assert.equal(result.local_review_required, true);
        assert.ok(result.frontier_rejection);
        assert.equal(result.context.transcript, 'We made it home.');
        assert.equal(result.context.expected_speech, 'We made it home.');
        assert.equal('acceptable' in result, false, 'A refusal is never cached as a failed review.');
    }
});

test('a locally planned story is reviewed locally and a blocked transcription is not missing speech', async t => {
    const value = plan();
    const contract = approvedLocalRecoveryContract(value, 'The character delivers the requested message.', 'provider_policy');
    const mock = mockRefusingReview(t, null, {});
    const { requests } = mock;
    const result = await reviewRecoveryMedia(contract, value.segments[0],
        { kind: 'video', frames: ['data:image/jpeg;base64,YQ=='], audio: 'YQ==' }, {});
    assert.equal(result.local_review_required, true);
    assert.equal(result.context.transcript_unavailable, true);
    assert.equal(result.context.speech_wording_close, undefined);
    assert.equal(requests.filter(request => request.openai).length, 0, 'Sol never reviews a story it rejected.');
    const settings = requests[0].gemini.safetySettings || requests[0].gemini.safety_settings;
    assert.ok(settings?.length && settings.every(setting => setting.threshold === 'BLOCK_NONE'));
    mock.transcript = '';
    const silent = await reviewRecoveryMedia(contract, value.segments[0],
        { kind: 'video', frames: ['data:image/jpeg;base64,YQ=='], audio: 'YQ==' }, {});
    assert.equal(silent.acceptable, false, 'Audible silence still fails before the local reviewer.');
});

test('mouthless dialogue staging preserves anatomy without forcing lip sync', () => {
    const value = { continuity_bible: 'John is a mouthless robot with small lens eyes.', segments: [{ shots: [{
        visual: 'John walks to the bars and speaks through his collar.', dialogue: [{ speaker_id: 'John', text: 'Let me out.' }],
    }] }] };
    stageFrontierDialogueVisually(value);
    assert.match(value.segments[0].shots[0].visual, /established voice mechanism/);
    assert.doesNotMatch(value.segments[0].shots[0].visual, /synchronized mouth movement/);
    assert.equal(stageFrontierDialogueVisually(value), 0);
    const human = { segments: [{ shots: [{ visual: 'A man speaks.', dialogue: [{ speaker_id: 'Alex', text: 'Hello.' }] }] }] };
    stageFrontierDialogueVisually(human);
    assert.match(human.segments[0].shots[0].visual, /synchronized mouth movement/);
    for (const visual of ['No mouth movement until the line begins.', 'Wait without mouth animation, then speak.']) {
        const timed = { segments: [{ shots: [{ visual, dialogue: [{ speaker_id: 'Alex', text: 'Hello.' }] }] }] };
        stageFrontierDialogueVisually(timed);
        assert.match(timed.segments[0].shots[0].visual, /synchronized mouth movement/);
    }
});

test('original request and portrait are retained in planning and required in review', async () => {
    const sources = [{ data: Buffer.from('portrait'), mimeType: 'image/png' }];
    let calls = 0;
    const result = await prepareRecoveryPlan({ prompt: 'The supplied character complains about a crypto scam.', model: 'minimax', requester: 'test', sources,
        options: {}, requireSourceIdentity: true, requireOriginalFirstFrame: true,
        planner: async (prompt, _model, _requester, references, options) => {
            assert.equal(prompt, 'The supplied character complains about a crypto scam.');
            assert.equal(references, sources);
            assert.match(options.plannerGuidance, /keyframe.recommended=false/);
            if (++calls === 1) throw new Error('temporary timeout');
            const value = plan(); value.keyframe.recommended = false; return value;
        },
    });
    assert.equal(calls, 2);
    assert.equal(result.prompt, 'The supplied character complains about a crypto scam.');
    assert.equal(result.notice, '');
    assert.equal(result.contract.use_source_images, true);
    assert.equal(result.contract.source_reference_required, true);
    assert.equal(result.contract.original_first_frame, true);
    await assert.rejects(reviewRecoveryMedia(result.contract, result.plan.segments[0],
        { kind: 'image', frames: ['data:image/jpeg;base64,YQ=='] }, {}, []), /reference is missing from review/);
    await assert.rejects(prepareRecoveryPlan({ prompt: 'A character speaks', model: 'minimax', requester: 'test',
        sources: [], options: {}, requireSourceIdentity: true,
        planner: async () => { assert.fail('Missing references must fail before planning.'); },
    }), /reference is missing/);
});

test('a generated replacement opening cannot satisfy a required original portrait', async () => {
    let calls = 0;
    await assert.rejects(prepareRecoveryPlan({ prompt: 'A character speaks', model: 'minimax', requester: 'test',
        sources: [{ data: Buffer.from('portrait'), mimeType: 'image/png' }], options: {}, requireOriginalFirstFrame: true,
        planner: async () => { calls++; return plan(); },
    }), /required original portrait/);
    assert.equal(calls, 2);
});

test('recovery budgets allow one retry and preserve pending reviews and accepted scenes', () => {
    assert.equal(recoveryLimitReached({ waits: 2 }), false);
    assert.equal(recoveryLimitReached({ waits: 3 }), true);
    const used = scene => recoveryLimitReached({ checkpoint: { scenes: { 0: scene } } });
    assert.equal(used({ video_attempts: 1 }), false);
    assert.equal(used({ video_attempts: 2 }), true);
    assert.equal(used({ cycles: 1 }), true, 'Legacy four-render cycles are already exhausted.');
    assert.equal(used({ video_attempts: 2, pending_video: 'clip.mp4' }), false);
    assert.equal(used({ video_attempts: 2, render_interrupted: true }), false);
    assert.equal(used({ cycles: 2, video_accepted: 'hash' }), false);
});

test('broker persists recovery and requires every scene review for the matching contract/output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-recovery-'));
    const value = plan();
    const contract = approvedRecoveryContract(value, 'explorers return');
    const prepared = { plan: value, contract, contract_hash: recoveryHash(contract), prompt: contract.prompt, notice: '' };
    let reviews = 0;
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: false, recoveryPlanner: async () => prepared,
        keyframeGenerator: async (scenePlan, _references, options) => {
            assert.equal(options.reviewPurpose, 'recovery-scene');
            assert.equal(scenePlan.recovery_request, contract.prompt);
            return { bytes: Buffer.from('fixture'), mimeType: 'image/png', provider: 'test', model: 'test' };
        },
        frontierPlanner: async () => { throw new Error('Legacy planning must not run before approval.'); },
        recoveryReviewer: async (_contract, _segment, body) => {
            reviews++;
            return { acceptable: body.frames[0].endsWith('YQ=='), permitted: true, issues: [] };
        } });
    await broker.start();
    try {
        const submitted = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'explorers return', requester_id: '1', origin_bot_id: '2',
                channel_id: '3', command_message_id: '4', status_message_id: '5' }),
        });
        const response = await submitted.json();
        assert.equal(submitted.status, 201, JSON.stringify(response));
        const id = response.job.id;
        const initial = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs/${id}/prepare`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' }, body: '{}',
        });
        assert.equal(initial.status, 200);
        let leased = false;
        broker.worker = { id: 'old-worker', currentJob: null, ready: true, capabilities: ['minimax'],
            recoveryVersion: 1, lastHeartbeat: Date.now(), scheduler: { available: false },
            socket: { send() { leased = true; }, close() {}, terminate() {} } };
        await broker.dispatchNext();
        assert.equal(leased, false, 'A storyboard-capable legacy worker must not receive new work');
        // Use a leased worker directly so these HTTP integration assertions don't
        // depend on websocket scheduling or real GPU availability.
        broker.worker = { id: 'test-worker', currentJob: id, leaseId: 'lease', ready: false,
            capabilities: ['minimax'], recoveryVersion: VIDEO_RECOVERY_VERSION, lastHeartbeat: Date.now(),
            scheduler: { available: false }, socket: { send() {}, close() {}, terminate() {} } };
        await broker.run("UPDATE video_jobs SET status='running', worker_id='test-worker', lease_token='lease', recovery_version=2 WHERE public_id=?", [id]);
        const request = async (operation, body = {}) => {
            const result = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/worker/jobs/${id}/recovery/${operation}`, {
                method: 'POST', headers: { authorization: 'Bearer worker', 'content-type': 'application/json', 'x-video-lease-id': 'lease' },
                body: JSON.stringify({ contract_hash: prepared.contract_hash, ...body }),
            });
            return { status: result.status, body: await result.json() };
        };
        assert.equal((await request('plan')).status, 200);
        assert.equal((await request('image', { segment_index: 0 })).status, 200);
        assert.equal((await request('checkpoint', { checkpoint: { scenes: { '0': { video_attempts: 1 } } } })).status, 200);
        assert.equal((await request('plan')).body.checkpoint.scenes['0'].video_attempts, 1);
        const hash = 'a'.repeat(64), resultHash = 'b'.repeat(64);
        const quality = { format: 'generated', result_sha256: resultHash, artifacts: [{ sha256: hash }] };
        assert.equal((await request('quality', quality)).status, 503);
        assert.equal((await request('review', { segment_index: 0, kind: 'video', artifact_sha256: hash,
            frames: ['data:image/jpeg;base64,YQ=='] })).body.acceptable, true);
        const legacyHash = 'd'.repeat(64);
        const legacyState = JSON.parse((await broker.get('SELECT recovery_json FROM video_jobs WHERE public_id=?', [id])).recovery_json);
        delete legacyState.reviews[`video:0:${hash}`].review_version;
        legacyState.reviews[`video:0:${legacyHash}`] = { acceptable: false, permitted: true, transcript: 'Hey, we made it home!', issues: ['Speech mismatch.'] };
        await broker.run('UPDATE video_jobs SET recovery_json=? WHERE public_id=?', [JSON.stringify(legacyState), id]);
        await request('review', { segment_index: 0, kind: 'video', artifact_sha256: hash, frames: ['data:image/jpeg;base64,YQ=='] });
        assert.equal(reviews, 1, 'Previously accepted artifacts remain cached across review policy changes.');
        const rechecked = await request('review', { segment_index: 0, kind: 'video', artifact_sha256: legacyHash,
            frames: ['data:image/jpeg;base64,YQ=='] });
        assert.equal(rechecked.body.acceptable, true);
        assert.equal(rechecked.body.review_version, VIDEO_RECOVERY_REVIEW_VERSION);
        assert.equal(reviews, 2, 'A legacy rejection must receive a fresh review.');
        const rejected = { segment_index: 0, kind: 'video', artifact_sha256: 'e'.repeat(64), frames: ['data:image/jpeg;base64,Yg=='] };
        assert.equal((await request('review', rejected)).body.acceptable, false);
        assert.equal((await request('review', rejected)).body.acceptable, false);
        assert.equal(reviews, 3, 'Current-policy rejections remain cached instead of retrying the reviewer forever.');
        assert.equal((await request('quality', quality)).status, 200);
        assert.equal((await request('quality', { ...quality, format: 'storyboard' })).status, 503);
        assert.equal((await request('review', { segment_index: 0, kind: 'storyboard', artifact_sha256: hash })).status, 503);
        assert.equal((await request('quality', { ...quality, contract_hash: 'c'.repeat(64) })).status, 409);
        await broker.run("UPDATE video_jobs SET result_path='result.mp4', result_sha256=? WHERE public_id=?", ['c'.repeat(64), id]);
        await assert.rejects(broker.handleWorkerMessage({ type: 'event', event: 'complete', job_id: id,
            lease_id: 'lease', runtime_seconds: 5 }), /exact output/);
        await broker.run("UPDATE video_jobs SET result_path='result.mp4', result_sha256=?, error='old error' WHERE public_id=?", [resultHash, id]);
        const notice = 'An alternate video renderer recovered the scene.';
        await broker.handleWorkerMessage({ type: 'event', event: 'complete', job_id: id, lease_id: 'lease', runtime_seconds: 5, generation_notice: notice });
        const row = await broker.get('SELECT status,error FROM video_jobs WHERE public_id=?', [id]);
        assert.deepEqual(row, { status: 'ready', error: null });
        const stored = await broker.get('SELECT planner_json FROM video_jobs WHERE public_id=?', [id]);
        assert.equal(JSON.parse(stored.planner_json).generation_notice, notice);
        // A temporary service failure retains the same approved plan/checkpoint
        // and releases the worker, instead of delivering a terminal error.
        broker.worker.currentJob = id;
        await broker.run("UPDATE video_jobs SET status='running' WHERE public_id=?", [id]);
        await broker.handleWorkerMessage({ type: 'event', event: 'failed', job_id: id, lease_id: 'lease',
            error: 'review service unavailable', retryable: true });
        const deferred = await broker.get('SELECT status,error,recovery_next_at,recovery_json FROM video_jobs WHERE public_id=?', [id]);
        assert.equal(deferred.status, 'queued');
        assert.equal(deferred.error, null);
        assert.ok(deferred.recovery_next_at > Date.now() / 1000);
        assert.equal(JSON.parse(deferred.recovery_json).checkpoint.scenes['0'].video_attempts, 1);
        // Failed passes are bounded even if every provider failure is marked retryable.
        for (let pass = 2; pass <= 3; pass++) {
            broker.worker.currentJob = id;
            await broker.run("UPDATE video_jobs SET status='running', progress=.98 WHERE public_id=?", [id]);
            await broker.handleWorkerMessage({ type: 'event', event: 'failed', job_id: id, lease_id: 'lease',
                error: 'review service unavailable', retryable: true });
            const stopped = await broker.get('SELECT status,progress,error,recovery_next_at,completed_at,recovery_json FROM video_jobs WHERE public_id=?', [id]);
            assert.equal(stopped.status, pass === 3 ? 'failed' : 'queued');
            assert.equal(stopped.progress, null);
            assert.equal(JSON.parse(stopped.recovery_json).waits, pass);
            if (pass === 3) {
                assert.match(stopped.error, /3 failed passes/);
                assert.equal(stopped.recovery_next_at, null);
                assert.ok(stopped.completed_at);
            }
        }
        // A legacy queued job over budget is stopped before it can receive another lease.
        await broker.run("UPDATE video_jobs SET status='queued', recovery_next_at=0 WHERE public_id=?", [id]);
        broker.worker.ready = true;
        broker.worker.scheduler = { available: true, mode: 'normal', health: 'healthy' };
        await broker.dispatchNext();
        assert.equal((await broker.get('SELECT status FROM video_jobs WHERE public_id=?', [id])).status, 'failed');
        assert.equal(broker.worker.currentJob, null);
        // Non-retryable errors stop immediately, retaining the last diagnostic and checkpoint.
        await broker.run("UPDATE video_jobs SET status='running', recovery_json=? WHERE public_id=?", [deferred.recovery_json, id]);
        broker.worker.currentJob = id;
        await broker.handleWorkerMessage({ type: 'event', event: 'failed', job_id: id, lease_id: 'lease',
            error: 'Scene exhausted its render attempts', retryable: false });
        assert.equal((await broker.get('SELECT status FROM video_jobs WHERE public_id=?', [id])).status, 'failed');
        broker.worker = null;
        await broker.run("UPDATE video_jobs SET status='delivered', delivery_message_id='123456' WHERE public_id=?", [id]);
        const botRequest = async (endpoint, body) => fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs/${id}/${endpoint}`, {
            method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        assert.equal((await botRequest('regenerate', { planner_guidance: 'Meximutt plays the explorer.' })).status, 200);
        const regenerated = await broker.get('SELECT status,delivery_message_id,delivery_revision,delivered_revision,recovery_json,planner_json,planner_guidance FROM video_jobs WHERE public_id=?', [id]);
        assert.deepEqual(regenerated, { status: 'queued', delivery_message_id: '123456', delivery_revision: 1,
            delivered_revision: 0, recovery_json: null, planner_json: null, planner_guidance: 'Meximutt plays the explorer.' });
        assert.equal((await botRequest('regenerate', {})).status, 409);
        await broker.run("UPDATE video_jobs SET status='ready' WHERE public_id=?", [id]);
        await botRequest('delivered', { revision: 0, message_id: '123456' });
        assert.equal((await broker.get('SELECT status FROM video_jobs WHERE public_id=?', [id])).status, 'ready');
        await botRequest('delivered', { revision: 1, message_id: '123456' });
        assert.deepEqual(await broker.get('SELECT status,delivered_revision,delivery_message_id FROM video_jobs WHERE public_id=?', [id]),
            { status: 'delivered', delivered_revision: 1, delivery_message_id: '123456' });
        await broker.run("UPDATE video_jobs SET status='queued', recovery_json=? WHERE public_id=?", [JSON.stringify({ waits: 3 }), id]);
        assert.equal((await botRequest('regenerate', {})).status, 200, 'An explicitly regenerated exhausted queue entry gets a fresh revision.');
        const retried = await broker.get('SELECT delivery_revision,recovery_json FROM video_jobs WHERE public_id=?', [id]);
        assert.deepEqual(retried, { delivery_revision: 2, recovery_json: null });
    } finally { broker.worker = null; await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('broker stops rewritten plans, missing identity, and replacement openings, and routes refusals locally', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-recovery-identity-'));
    const portrait = join(directory, 'portrait.png');
    writeFileSync(portrait, Buffer.from('portrait'));
    const value = plan(); value.keyframe.recommended = false;
    const contract = approvedRecoveryContract(value, 'The original request');
    const prepared = { plan: value, contract, contract_hash: recoveryHash(contract), prompt: contract.prompt, notice: '' };
    let refusal = false, planningCalls = 0;
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: false,
        recoveryPlanner: async input => {
            planningCalls++;
            assert.equal(input.requireSourceIdentity, true);
            assert.equal(input.requireOriginalFirstFrame, true);
            assert.equal(input.sources.length, 1);
            if (refusal) return prepareRecoveryPlan({ ...input, planner: async () => {
                throw new FrontierPlannerRejectedError(refusal === 'minor' ? 'minor_sexualization' : 'provider_policy',
                    'Provider refused the original request');
            } });
            return structuredClone(prepared);
        },
        keyframeGenerator: async () => { assert.fail('The original portrait cannot be regenerated.'); },
    });
    await broker.start();
    try {
        const base = `http://127.0.0.1:${broker.listeningPort()}`;
        const submitted = await fetch(`${base}/v1/jobs`, { method: 'POST',
            headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'The original request', requester_id: '1', origin_bot_id: '2',
                channel_id: '3', command_message_id: '4', status_message_id: '5' }),
        });
        assert.equal(submitted.status, 201);
        const id = (await submitted.json()).job.id;
        broker.worker = { id: 'test-worker', currentJob: id, leaseId: 'lease', ready: false,
            capabilities: ['minimax'], recoveryVersion: VIDEO_RECOVERY_VERSION, lastHeartbeat: Date.now(),
            scheduler: { available: false }, socket: { send() {}, close() {}, terminate() {} } };
        const reset = async (state = {}, source = portrait) => {
            broker.worker.currentJob = id;
            await broker.run("UPDATE video_jobs SET status='running', worker_id='test-worker', lease_token='lease', recovery_version=2, command_variant='oalgo', source_image_path=?, source_image_mime='image/png', recovery_json=? WHERE public_id=?",
                [source, JSON.stringify(state), id]);
        };
        const request = async (operation, body = {}) => {
            const response = await fetch(`${base}/v1/worker/jobs/${id}/recovery/${operation}`, { method: 'POST',
                headers: { authorization: 'Bearer worker', 'content-type': 'application/json', 'x-video-lease-id': 'lease' },
                body: JSON.stringify({ contract_hash: prepared.contract_hash, ...body }),
            });
            return { status: response.status, body: await response.json() };
        };
        await reset();
        assert.equal((await request('plan')).status, 200);
        assert.equal((await request('image', { segment_index: 0 })).status, 422);
        const failed = async () => {
            await broker.handleWorkerMessage({ type: 'event', event: 'failed', job_id: id, lease_id: 'lease',
                error: 'Recovery request failed', retryable: true });
            const row = await broker.get('SELECT status,recovery_json FROM video_jobs WHERE public_id=?', [id]);
            assert.equal(row.status, 'failed');
            const state = JSON.parse(row.recovery_json);
            assert.equal(state.waits, 1);
            assert.ok(state.terminal_error);
        };
        await failed();
        for (const change of [
            candidate => { candidate.prompt = 'An automatically rewritten request'; },
            candidate => { candidate.contract.use_source_images = false; },
            candidate => { candidate.plan.keyframe.recommended = true; },
        ]) {
            const candidate = structuredClone(prepared); change(candidate);
            await reset({ prepared: candidate });
            assert.equal((await request('plan')).status, 422);
            await failed();
        }
        await reset({}, null);
        assert.equal((await request('plan')).status, 422);
        await failed();
        assert.equal(planningCalls, 1, 'Invalid saved plans and missing references stop before calling the planner.');
        await reset({ prepared, checkpoint: { scenes: { 0: { video_attempts: 2 } } } });
        assert.equal((await request('checkpoint', { checkpoint: { scenes: { 0: {
            video_attempts: 3, render_interrupted: true,
        } } } })).status, 422, 'An older worker cannot start a third render.');
        await failed();
        await reset({ prepared, checkpoint: { scenes: { 0: { video_attempts: 3, render_interrupted: true } } } });
        assert.equal((await request('checkpoint', { checkpoint: { scenes: { 0: {
            video_attempts: 3, render_interrupted: true,
        } } } })).status, 200, 'A render already active before deployment can finish.');
        await reset(); refusal = true;
        const routed = await request('plan');
        assert.equal(routed.status, 200);
        assert.equal(routed.body.local_plan_required, true);
        assert.equal(routed.body.reason_code, 'provider_policy');
        assert.equal(routed.body.sources.length, 1, 'The local planner receives the original portrait.');
        assert.equal((await request('plan')).body.local_plan_required, true);
        assert.equal(planningCalls, 2, 'A persisted local routing decision never asks the frontier again.');
        const local = plan(); local.keyframe.recommended = true;
        const uploaded = await request('local-plan', { plan: local });
        assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
        assert.equal(uploaded.body.plan.keyframe.recommended, false, 'The required portrait stays the opening frame.');
        assert.equal(uploaded.body.contract.planner, 'local');
        assert.equal(uploaded.body.contract.original_first_frame, true);
        assert.equal(uploaded.body.sources.length, 1);
        assert.equal((await request('plan')).body.contract_hash, uploaded.body.contract_hash);
        const row = await broker.get('SELECT planner_model FROM video_jobs WHERE public_id=?', [id]);
        assert.equal(row.planner_model, 'hauhaucs-qwen3.8:27b-q4kp-mtp');
        await reset(); refusal = 'minor';
        const stopped = await request('plan');
        assert.equal(stopped.status, 422);
        assert.match(stopped.body.error, /never planned locally/);
        await failed();
    } finally { broker.worker = null; await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('a rejected recovery job is planned, composed, reviewed, and approved through local Qwen', async t => {
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init);
        assert.fail(`A locally planned story must not reach ${url}.`);
    });
    const directory = mkdtempSync(join(tmpdir(), 'video-recovery-local-'));
    let frontierCalls = 0, generatorCalls = 0, reviewerCalls = 0;
    const analysis = { dialogue_contract: { mode: 'verbatim', lines: [{ text: 'We made it home.', verbatim: true }] } };
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: false,
        frontierPlanner: async () => { frontierCalls++; throw new FrontierPlannerRejectedError('provider_policy', 'Declined.', analysis); },
        keyframeGenerator: async () => { generatorCalls++; throw new Error('Frontier images are not used for a policy rejection.'); },
        recoveryReviewer: async (...args) => { reviewerCalls++; return reviewRecoveryMedia(...args); },
    });
    await broker.start();
    try {
        const base = `http://127.0.0.1:${broker.listeningPort()}`;
        const submitted = await fetch(`${base}/v1/jobs`, { method: 'POST',
            headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'explorers return', requester_id: '1', origin_bot_id: '2',
                channel_id: '3', command_message_id: '4', status_message_id: '5' }),
        });
        const id = (await submitted.json()).job.id;
        broker.worker = { id: 'test-worker', currentJob: id, leaseId: 'lease', ready: false,
            capabilities: ['minimax'], recoveryVersion: VIDEO_RECOVERY_VERSION, lastHeartbeat: Date.now(),
            scheduler: { available: false }, socket: { send() {}, close() {}, terminate() {} } };
        await broker.run("UPDATE video_jobs SET status='running', worker_id='test-worker', lease_token='lease', recovery_version=? WHERE public_id=?",
            [VIDEO_RECOVERY_VERSION, id]);
        let contractHash = '';
        const request = async (operation, body = {}) => {
            const response = await fetch(`${base}/v1/worker/jobs/${id}/recovery/${operation}`, { method: 'POST',
                headers: { authorization: 'Bearer worker', 'content-type': 'application/json', 'x-video-lease-id': 'lease' },
                body: JSON.stringify({ contract_hash: contractHash, ...body }),
            });
            return { status: response.status, body: await response.json() };
        };
        const routed = await request('plan');
        assert.equal(routed.status, 200, JSON.stringify(routed.body));
        assert.deepEqual(routed.body.prompt_analysis, analysis, 'The local planner keeps the frontier dialogue contract.');
        assert.equal(frontierCalls, 1, 'Recovery does not retry a rejected brief with the frontier planner.');
        assert.equal((await broker.get('SELECT planner_model FROM video_jobs WHERE public_id=?', [id])).planner_model,
            'local-fallback:provider_policy');
        assert.equal((await request('local-plan', { plan: { segments: [] } })).status, 503, 'An empty local screenplay is refused.');
        const uploaded = await request('local-plan', { plan: { ...plan(), prompt_analysis: analysis,
            generation_notice: 'Planned by the local model.' } });
        assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
        contractHash = uploaded.body.contract_hash;
        assert.equal(uploaded.body.notice, 'Planned by the local model.');
        assert.equal(uploaded.body.contract.local_reason, 'provider_policy');
        const image = await request('image', { segment_index: 0 });
        assert.equal(image.body.local_image_required, true);
        assert.match(image.body.keyframe.prompt, /opening instant/);
        assert.equal(generatorCalls, 0);
        const hash = 'a'.repeat(64);
        const artifact = { segment_index: 0, kind: 'image', artifact_sha256: hash, frames: ['data:image/jpeg;base64,YQ=='] };
        const pending = await request('review', artifact);
        assert.equal(pending.body.local_review_required, true);
        assert.equal(pending.body.context.request, 'explorers return');
        assert.equal((await request('review', artifact)).body.local_review_required, true);
        assert.equal(reviewerCalls, 1, 'A pending local review is not recomputed.');
        assert.equal((await request('local-review', { ...artifact, artifact_sha256: 'f'.repeat(64),
            verdict: { acceptable: true, issues: [] } })).status, 503, 'Only a requested review can be answered locally.');
        assert.equal((await request('local-review', { ...artifact, verdict: { acceptable: 'yes' } })).status, 503);
        const stored = await request('local-review', { ...artifact, verdict: { acceptable: true, issues: [] } });
        assert.equal(stored.body.acceptable, true);
        assert.equal(stored.body.reviewer, 'hauhaucs-qwen3.8:27b-q4kp-mtp');
        assert.equal((await request('review', artifact)).body.acceptable, true);
        const video = { ...artifact, kind: 'video', artifact_sha256: 'b'.repeat(64) };
        delete video.frames;
        video.frames = ['data:image/jpeg;base64,YQ=='];
        const quality = { format: 'generated', result_sha256: 'c'.repeat(64), artifacts: [{ sha256: video.artifact_sha256 }] };
        assert.equal((await request('quality', quality)).status, 503);
        const videoReview = await request('review', video);
        assert.equal(videoReview.body.acceptable, false, 'Missing audio for required speech still fails deterministically.');
        const audible = { ...video, artifact_sha256: 'd'.repeat(64) };
        const state = JSON.parse((await broker.get('SELECT recovery_json FROM video_jobs WHERE public_id=?', [id])).recovery_json);
        state.local_reviews[`video:0:${audible.artifact_sha256}`] = { context: { transcript: 'We made it home.' } };
        await broker.run('UPDATE video_jobs SET recovery_json=? WHERE public_id=?', [JSON.stringify(state), id]);
        const accepted = await request('local-review', { ...audible, verdict: { acceptable: true, issues: [] } });
        assert.equal(accepted.body.transcript, 'We made it home.');
        assert.equal((await request('quality', { ...quality, artifacts: [{ sha256: audible.artifact_sha256 }] })).status, 200);
    } finally { broker.worker = null; await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('an image-provider refusal of an approved scene falls back to local composition', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'video-recovery-image-'));
    const value = plan();
    const contract = approvedRecoveryContract(value, 'explorers return');
    const prepared = { plan: value, contract, contract_hash: recoveryHash(contract), prompt: contract.prompt, notice: '' };
    let failure = new VideoKeyframeError('moderation', 'Blocked by moderation.');
    const broker = new VideoBroker({ host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'),
        resultsDir: join(directory, 'results'), botToken: 'bot', workerToken: 'worker',
        recoveryEnabled: true, preplanQueuedJobs: false, recoveryPlanner: async () => structuredClone(prepared),
        keyframeGenerator: async () => { throw failure; } });
    await broker.start();
    try {
        const base = `http://127.0.0.1:${broker.listeningPort()}`;
        const submitted = await fetch(`${base}/v1/jobs`, { method: 'POST',
            headers: { authorization: 'Bearer bot', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'minimax', prompt: 'explorers return', requester_id: '1', origin_bot_id: '2',
                channel_id: '3', command_message_id: '4', status_message_id: '5' }),
        });
        const id = (await submitted.json()).job.id;
        broker.worker = { id: 'test-worker', currentJob: id, leaseId: 'lease', ready: false,
            capabilities: ['minimax'], recoveryVersion: VIDEO_RECOVERY_VERSION, lastHeartbeat: Date.now(),
            scheduler: { available: false }, socket: { send() {}, close() {}, terminate() {} } };
        await broker.run("UPDATE video_jobs SET status='running', worker_id='test-worker', lease_token='lease', recovery_version=? WHERE public_id=?",
            [VIDEO_RECOVERY_VERSION, id]);
        const request = async (operation, body = {}) => {
            const response = await fetch(`${base}/v1/worker/jobs/${id}/recovery/${operation}`, { method: 'POST',
                headers: { authorization: 'Bearer worker', 'content-type': 'application/json', 'x-video-lease-id': 'lease' },
                body: JSON.stringify({ contract_hash: prepared.contract_hash, ...body }),
            });
            return { status: response.status, body: await response.json() };
        };
        assert.equal((await request('plan')).status, 200);
        const refused = await request('image', { segment_index: 0 });
        assert.equal(refused.body.local_image_required, true);
        assert.equal(refused.body.use_references, false);
        failure = new VideoKeyframeError('provider_error', 'Provider offline.');
        assert.equal((await request('image', { segment_index: 0 })).status, 503, 'An outage still waits for the provider.');
    } finally { broker.worker = null; await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});
