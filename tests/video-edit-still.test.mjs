import test from 'node:test';
import assert from 'node:assert/strict';

import { createVideoEditStill, isolatedEditSubject, videoEditStillPrompt, videoEditTargetNamesHeadwear, videoEditStillWithEffects, withoutJpegApp11 } from '../dist/VideoKeyframeProvider.js';
import { parseSubjectBox } from '../dist/VideoBroker.js';
import { parseVideoEditHead, videoEditHeadWording } from '../dist/VideoEditIntent.js';
import { inflateSync } from 'node:zlib';
import { createCanvas, loadImage } from 'canvas';
import { config } from '../dist/Config.js';
import { VideoUsagePersistenceError } from '../dist/VideoUsage.js';

const sourceCanvas = createCanvas(160, 90);
const frame = { bytes: sourceCanvas.toBuffer('image/png'), mimeType: 'image/png' };
const replacement = { bytes: Buffer.from('replacement'), mimeType: 'image/png' };

async function withImageEdits(respond, run) {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (input, init) => {
        requests += 1;
        const [status, body] = await respond(requests, String(input), init);
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    try {
        return { result: await run(), requests };
    } catch (error) {
        return { error, requests };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

const refused = [400, { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }];
const repainted = [200, { data: [{ b64_json: Buffer.from('repainted').toString('base64') }] }];

test('the preferred editor gets one retry before switching editors', async () => {
    const attempts = [];
    const recovered = await withImageEdits(count => (count === 1 ? refused : repainted),
        () => createVideoEditStill(frame, replacement, 'the woman', 'meximutt',
            { onAttempt: value => attempts.push([value.attempt, value.outcome]) }));
    assert.equal(recovered.result.bytes.toString(), 'repainted');
    assert.deepEqual(attempts, [[1, 'error'], [2, 'success']]);

});

test('each shot of a clip numbers its own repaint attempts', async () => {
    const attempts = [];
    await withImageEdits(count => (count === 1 ? refused : repainted),
        () => createVideoEditStill(frame, replacement, 'the woman', 'meximutt',
            { attemptOffset: 4, onAttempt: value => attempts.push(value.attempt) }));
    assert.deepEqual(attempts, [5, 6]);
});

test('an isolated repaint names the target and its place in a crop shared with other people', () => {
    // 24206bd8: "the selected subject" let the editor replace a man holding the target aloft.
    const subject = isolatedEditSubject('the person falling from the bridge', [0.1, 0.05, 0.62, 0.4]);
    assert.match(subject, /^the person falling from the bridge: the one figure/);
    assert.match(subject, /from 10% to 62% of Image 1's width and 5% to 40% of its height/);
    assert.match(videoEditStillPrompt(subject, 'meximutt'), /Every other person in Image 1 stays exactly as they are/);
    assert.equal(isolatedEditSubject('the man'), 'the selected subject in this tight source crop');
    // 24206bd8: at 15 px the editor drew the thrown man's head where his feet were.
    const head = videoEditHeadWording(parseVideoEditHead({ found: true, head_box_2d: [294, 606, 373, 674], head_side: 'right' }));
    assert.equal(head, "its head is at the right end of its body, at 61% to 67% of Image 1's width and 29% to 37% of its height");
    assert.match(isolatedEditSubject('the person falling', [0.1, 0.05, 0.62, 0.4], head),
        /of its height; its head is at the right end of its body, .* so the replacement's head and face go exactly there/);
    // 9d8798c9: from a blurred crop the editor drew the reference's own scowl over a worried emoji.
    const worried = videoEditHeadWording(parseVideoEditHead({ found: true, head_box_2d: [240, 210, 760, 820], head_side: 'top',
        expression: '  anxious, with furrowed inner brows,\n wide eyes and a closed mouth.  ' }));
    assert.equal(worried, "its head is at the top end of its body, at 21% to 82% of Image 1's width and 24% to 76% of its height"
        + ', and its face shows anxious, with furrowed inner brows, wide eyes and a closed mouth');
    assert.equal(parseVideoEditHead({ found: true, head_box_2d: [1, 2, 3, 4], head_side: 'top', expression: ' ' })?.expression, undefined);
    assert.equal(parseVideoEditHead({ found: true, head_box_2d: [1, 2, 3, 4], head_side: 'top', expression: 'x'.repeat(500) })?.expression?.length, 220);
    for (const bad of [{ found: false, head_box_2d: [1, 2, 3, 4], head_side: 'left' },
        { found: true, head_box_2d: [5, 2, 3, 4], head_side: 'left' }, { found: true, head_box_2d: [1, 2, 3, 4], head_side: 'up' }]) {
        assert.equal(parseVideoEditHead(bad), null);
    }
    assert.deepEqual(parseSubjectBox('0.100,0.050,0.620,0.400'), [0.1, 0.05, 0.62, 0.4]);
    for (const bad of [undefined, '', '0.1,0.2,0.3', '0.5,0.1,0.4,0.9', '0,0,1.2,1', 'a,b,c,d', ['0,0,1,1']]) {
        assert.equal(parseSubjectBox(bad), undefined, String(bad));
    }
});

test('a group target replaces each of its members with its own copy', () => {
    // 3c8ba05b: worded for one figure, the editor replaced one of four dancing bears or drew a single Meximutt.
    const subject = isolatedEditSubject('all dancing bears', [0.02, 0.085, 0.982, 0.931], undefined, true);
    assert.equal(subject, "the dancing bears in the region from 2% to 98% of Image 1's width and 9% to 93% of its height");
    const prompt = videoEditStillPrompt(subject, 'meximutt', true);
    assert.match(prompt, /^Edit Image 1, a frame from a video\. Replace the dancing bears in the region .* with copies of the subject shown in Image 2, one copy for each of them/);
    assert.match(prompt, /exactly as many copies as Image 1 shows of them/);
    assert.doesNotMatch(prompt, /the one figure|The replacement takes/);
    assert.equal(isolatedEditSubject('every bear', undefined, undefined, true), 'the selected subjects in this tight source crop');
    assert.match(isolatedEditSubject('both of the men', [0, 0, 1, 1], undefined, true), /^the men in the region/);
    assert.match(videoEditStillPrompt('all dancing bears', '', true), /Replace all dancing bears with copies/);
});

test('the repaint keeps the subject\'s headwear without naming any garment', () => {
    const prompt = videoEditStillPrompt('the woman in the foreground', 'Meximutt');
    assert.match(prompt, /wears anything on its head in Image 1, the replacement wears the same thing/);
    // Listing religious garments got frames of bareheaded real people refused.
    assert.doesNotMatch(prompt, /hijab|veil|turban|headscarf/i);
});

test('headwear named in the target is replaced with it', () => {
    // 19b37af1: the kept hat sat over Sol Slug's afro and every render was rejected for it.
    const target = 'the person wearing a Guy Fawkes mask and black hat';
    assert.equal(videoEditTargetNamesHeadwear(target), true);
    for (const prompt of [videoEditStillPrompt(target, 'slug'),
        videoEditStillPrompt(isolatedEditSubject(target, [0.06, 0.01, 0.89, 0.99], 'its head is at the top'), 'slug')]) {
        assert.match(prompt, /on its head too, is replaced along with it/);
        assert.doesNotMatch(prompt, /wears the same thing/);
        assert.doesNotMatch(prompt.replaceAll(target.replace(/^the /, ''), ''), /hijab|veil|turban|headscarf|\bhat\b/i);
    }
    assert.match(videoEditStillPrompt('the soldiers in helmets', 'slug', true), /each copy has only the head/);
    for (const plain of ['the woman in the foreground', 'the man escaping the capsule', 'the headless horseman',
        'the kid from the neighborhood', 'the chapter narrator']) {
        assert.equal(videoEditTargetNamesHeadwear(plain), false, plain);
        assert.match(videoEditStillPrompt(plain, 'slug'), /wears the same thing in the same way/);
    }
});

const geminiImage = (bytes = frame.bytes, mimeType = 'image/png') => [200, {
    candidates: [{ content: { parts: [{ inlineData: { mimeType, data: bytes.toString('base64') } }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1690,
        candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1680 }] },
}];

for (const isolated of [false, true]) test(`Gemini gets the original frame, identity and edit prompt (isolated=${isolated})`, async () => {
    const attempts = [], usage = [], reservations = [];
    let originalPrompt;
    const { result, error, requests } = await withImageEdits((_count, url, init) => {
        if (url.includes('api.openai.com')) {
            originalPrompt = init.body.get('prompt');
            return refused;
        }
        assert.match(url, /generativelanguage.googleapis.com/);
        const body = JSON.parse(init.body);
        const parts = body.contents[0].parts;
        assert.deepEqual(parts.filter(part => part.inlineData).map(part => part.inlineData),
            [frame, replacement].map(image => ({ mimeType: image.mimeType, data: image.bytes.toString('base64') })));
        assert.equal(parts.at(-1).text, originalPrompt);
        assert.doesNotMatch(JSON.stringify(parts), /FRAME-ZERO|Generate one new|visual references only/);
        assert.equal(body.generationConfig.imageConfig.aspectRatio, '16:9');
        assert.equal(body.safetySettings, undefined, 'Use normal provider safeguards.');
        return geminiImage();
    }, () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', {
        isolated, attemptOffset: 6, onAttempt: event => attempts.push(event),
        onUsage: event => usage.push(event), beforeRequest: event => reservations.push(event),
    }));
    assert.equal(error, undefined);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.mimeType, 'image/png');
    assert.equal((await loadImage(result.bytes)).width, 160);
    assert.equal(requests, 3);
    assert.deepEqual(attempts.map(event => [event.stage, event.provider, event.attempt, event.outcome]), [
        ['video_edit_still', 'openai', 7, 'error'], ['video_edit_still', 'openai', 8, 'error'],
        ['video_edit_still', 'google', 9, 'success'],
    ]);
    assert.deepEqual(usage.map(event => [event.stage, event.provider, event.attempt, event.images]),
        [['video_edit_still', 'google', 9, 1]]);
    assert.deepEqual(reservations.map(event => event.stage), Array(3).fill('video_edit_still'));
});

test('a second draw can go straight to Gemini with a 4:5 crop kept at 4:5', async () => {
    // f2968aee: a 148x176 crop went out as 3:4 and came back with the replacement at half height.
    const crop = { bytes: createCanvas(148, 176).toBuffer('image/png'), mimeType: 'image/png' };
    const attempts = [];
    const { result, error, requests } = await withImageEdits((_count, url, init) => {
        assert.match(url, /generativelanguage.googleapis.com/, 'The preferred editor already refused this frame.');
        assert.equal(JSON.parse(init.body).generationConfig.imageConfig.aspectRatio, '4:5');
        return geminiImage();
    }, () => createVideoEditStill(crop, replacement, 'Mario', 'meximutt', {
        isolated: true, alternateOnly: true, attemptOffset: 3, deadline: Date.now() + 200_000,
        onAttempt: event => attempts.push([event.provider, event.attempt, event.outcome]),
    }));
    assert.equal(error, undefined);
    assert.equal(result.provider, 'gemini');
    assert.equal(requests, 1);
    assert.deepEqual(attempts, [['google', 6, 'success']]);
    const wide = await withImageEdits((_count, url, init) => url.includes('api.openai.com') ? refused
        : (assert.equal(JSON.parse(init.body).generationConfig.imageConfig.aspectRatio, '5:4'), geminiImage()),
    () => createVideoEditStill({ bytes: createCanvas(176, 144).toBuffer('image/png'), mimeType: 'image/png' },
        replacement, 'Mario', 'meximutt'));
    assert.equal(wide.error, undefined);
});

test('an isolated group repaint asks for one copy per member and no head position', async () => {
    let prompt;
    const { error } = await withImageEdits((_count, _url, init) => (prompt = init.body.get('prompt'), repainted),
        () => createVideoEditStill(frame, replacement, 'all dancing bears', 'meximutt', {
            isolated: true, group: true, subjectBox: [0.02, 0.085, 0.982, 0.931], headWording: 'its head is at the top end' }));
    assert.equal(error, undefined);
    assert.match(prompt, /copies of the subject shown in Image 2, one copy for each of them/);
    assert.match(prompt, /tracked crop of the intended subjects.*Replace every one of them; leave none of them unchanged and remove none of them/);
    assert.doesNotMatch(prompt, /its head is at|the one figure|crop of the intended subject,/);
});

test('a second draw sends nothing once its deadline has passed', async () => {
    const { error, requests } = await withImageEdits(() => geminiImage(),
        () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', { alternateOnly: true, deadline: Date.now() - 1 }));
    assert.match(error.message, /ran out of time/);
    assert.equal(requests, 0);
});

test('an outage goes directly to Gemini and JPEG output remains usable for effect metadata', async () => {
    const { result, error, requests } = await withImageEdits((_count, url) => url.includes('api.openai.com')
        ? [503, { error: { message: 'Service unavailable' } }]
        : geminiImage(sourceCanvas.toBuffer('image/jpeg'), 'image/jpeg'),
    () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
    assert.equal(error, undefined);
    assert.equal(requests, 2);
    assert.equal(result.mimeType, 'image/png');
    assert.ok(videoEditStillWithEffects(result, 'blue light').bytes.includes(Buffer.from('video_edit_effects')));
});

test('all editors failing leaves the job failed, and missing Gemini configuration preserves the original error', async t => {
    const failed = await withImageEdits((_count, url) => url.includes('api.openai.com') ? refused
        : [200, { promptFeedback: { blockReason: 'SAFETY' } }],
    () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
    assert.match(failed.error.message, /prompt_block=SAFETY/);
    assert.equal(failed.requests, 3);
    const saved = config.geminiApiKey;
    config.geminiApiKey = '';
    t.after(() => { config.geminiApiKey = saved; });
    const unavailable = await withImageEdits(() => refused,
        () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
    assert.equal(unavailable.error.code, 'moderation');
    assert.equal(unavailable.requests, 2);
});

test('empty or corrupt fallback images never reach animation', async () => {
    for (const response of [[200, { candidates: [] }], geminiImage(Buffer.from('not an image'))]) {
        const { error, result } = await withImageEdits((_count, url) => url.includes('api.openai.com') ? refused : response,
            () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
        assert.ok(error);
        assert.equal(result, undefined);
    }
});

test('cancellation and accounting failures do not dispatch fallback requests', async () => {
    const controller = new AbortController();
    const cancelled = await withImageEdits(() => { controller.abort(); return refused; },
        () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', { abortSignal: controller.signal }));
    assert.equal(cancelled.requests, 1);
    assert.ok(cancelled.error);
    const alreadyCancelled = await withImageEdits(() => repainted,
        () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', { abortSignal: controller.signal }));
    assert.equal(alreadyCancelled.requests, 0);
    for (const hook of ['beforeRequest', 'onUsage', 'onAttempt']) {
        const { error, requests } = await withImageEdits(() => repainted,
            () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', {
                [hook]: () => { throw new Error('Accounting is unavailable'); },
            }));
        assert.ok(error instanceof VideoUsagePersistenceError);
        assert.equal(requests, hook === 'beforeRequest' ? 0 : 1);
    }
});

test('the alternate editor respects the generation deadline', async t => {
    const realNow = Date.now;
    let elapsed = 0;
    t.mock.method(Date, 'now', () => realNow() + elapsed);
    const { error, requests } = await withImageEdits(() => {
        elapsed = 270_001;
        return refused;
    }, () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
    assert.equal(error.code, 'moderation');
    assert.equal(requests, 1);
});

// A 1x1 PNG: signature, IHDR, IDAT and IEND.
const onePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

function chunks(png) {
    const found = [];
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        found.push({ type: png.toString('latin1', offset + 4, offset + 8),
            data: png.subarray(offset + 8, offset + 8 + length) });
        offset += 12 + length;
    }
    return found;
}

test('the still carries grounded effects to the worker as PNG text', () => {
    const still = { bytes: onePixel, mimeType: 'image/png', provider: 'openai', model: 'gpt-image-test' };
    const labeled = videoEditStillWithEffects(still, ' glowing light beams from the eyes\u2014both ');
    const found = chunks(labeled.bytes);
    assert.deepEqual(found.map(chunk => chunk.type), ['IHDR', 'IDAT', 'tEXt', 'IEND']);
    assert.equal(found[2].data.toString('latin1'), 'video_edit_effects\0glowing light beams from the eyesboth');
    assert.equal(inflateSync(found[1].data).length, 4, 'the image data is untouched');
    assert.equal(videoEditStillWithEffects(still, ''), still);
    const jpeg = { ...still, mimeType: 'image/jpeg', bytes: Buffer.from('jpeg') };
    assert.equal(videoEditStillWithEffects(jpeg, 'beams'), jpeg);
});

test('outfit images follow the portrait and fix the clothing below it in every shot', async () => {
    // 3c8ba05b: the portrait ends at the shirt, and two shots drew bare legs and red trousers.
    const sheet = { bytes: Buffer.from('sheet'), mimeType: 'image/png' };
    const shot = { bytes: Buffer.from('shot'), mimeType: 'image/png' };
    let prompt, images;
    const both = await withImageEdits((_count, _url, init) => (prompt = init.body.get('prompt'),
        images = init.body.getAll('image[]').map(file => file.name), repainted),
    () => createVideoEditStill(frame, replacement, 'all dancing bears', 'meximutt', {
        isolated: true, group: true, outfit: { sheet, shot } }));
    assert.equal(both.error, undefined);
    assert.deepEqual(images, ['image_1.png', 'image_2.png', 'image_3.png', 'image_4.png']);
    assert.match(prompt, /Image 3 is a full-length reference sheet of the subject in Image 2.*Dress every copy exactly as Image 3 shows, from the shirt down to the trousers and shoes/);
    assert.match(prompt, /Image 4 is these same copies already drawn into another shot of this clip/);
    assert.match(prompt, /Take only appearance from Images 3 and 4: the pose, size, position, framing and expression still come from Image 1\.$/);
    const sheetOnly = await withImageEdits((_count, _url, init) => (prompt = init.body.get('prompt'),
        images = init.body.getAll('image[]').length, repainted),
    () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', { outfit: { sheet } }));
    assert.equal(sheetOnly.error, undefined);
    assert.equal(images, 3);
    assert.match(prompt, /Dress the replacement exactly as Image 3 shows/);
    assert.match(prompt, /Take only appearance from Image 3:/);
    assert.doesNotMatch(prompt, /Image 4/);
    const shotOnly = await withImageEdits((_count, _url, init) => (prompt = init.body.get('prompt'), repainted),
        () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', { isolated: true, outfit: { shot } }));
    assert.equal(shotOnly.error, undefined);
    assert.match(prompt, /Image 3 is this same replacement already drawn into another shot of this clip/);
    const plain = await withImageEdits((_count, _url, init) => (prompt = init.body.get('prompt'),
        images = init.body.getAll('image[]').length, repainted),
    () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt'));
    assert.equal(plain.error, undefined);
    assert.equal(images, 2);
    assert.doesNotMatch(prompt, /Image 3/);
});

test('a preset portrait reference brings its character sheet and an upload brings none', async () => {
    const { videoCharacterBodySheet } = await import('../dist/VideoSourceImage.js');
    const { readFileSync } = await import('node:fs');
    const sheet = videoCharacterBodySheet(readFileSync(new URL('../images/oalgo.png', import.meta.url)));
    assert.equal(sheet.mimeType, 'image/png');
    assert.ok(sheet.bytes.equals(readFileSync(new URL('../images/oalgo-sheet.png', import.meta.url))));
    assert.equal(videoCharacterBodySheet(Buffer.from('an uploaded reference')), null);
    assert.equal(videoCharacterBodySheet(readFileSync(new URL('../images/argenmutt.png', import.meta.url))), null);
});

test('a Gemini JPEG signed with a C2PA manifest that names an SVG type still decodes', async () => {
    // node-canvas sniffs "<svg" ahead of the JPEG signature and parsed such a repaint as SVG.
    const plain = sourceCanvas.toBuffer('image/jpeg');
    const app0End = 4 + plain.readUInt16BE(4);
    const manifest = Buffer.from(`JP\0\x01jumb c2pa.thumbnail.claim image/svg+xml <svg xmlns="http://www.w3.org/2000/svg"/>`, 'latin1');
    const header = Buffer.from([0xff, 0xeb, 0, 0]);
    header.writeUInt16BE(manifest.length + 2, 2);
    const signed = Buffer.concat([plain.subarray(0, app0End), header, manifest, plain.subarray(app0End)]);
    await assert.rejects(loadImage(signed), /SVG/, 'The fixture reproduces the misdetection.');
    assert.ok(withoutJpegApp11(signed).equals(plain));
    assert.equal(withoutJpegApp11(plain), plain);
    assert.equal(withoutJpegApp11(frame.bytes), frame.bytes, 'PNGs pass through untouched.');
    const { result, error } = await withImageEdits(() => geminiImage(signed, 'image/jpeg'),
        () => createVideoEditStill(frame, replacement, 'Peach', 'meximutt', { alternateOnly: true }));
    assert.equal(error, undefined);
    assert.equal(result.mimeType, 'image/png');
    assert.equal((await loadImage(result.bytes)).width, 160);
});
