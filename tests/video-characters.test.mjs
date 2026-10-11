import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Commands } from '../dist/CommandDeclarations.js';
import { VideoBroker } from '../dist/VideoBroker.js';
import {
    MEXIMUTT, VIDEO_CHARACTERS, bindLocalPresetIdentity, videoCharacterCommandLabel, videoCharacterForCommand,
    videoCharacterForPreset, videoCharacterPhotorealKeyframe, videoCharacterPlannerGuidance,
} from '../dist/VideoCharacters.js';
import { videoEditIntentInstructions } from '../dist/VideoEditIntent.js';
import {
    VIDEO_CLIP_FRAME_PLANNER_GUIDANCE, completedVideoPost, formatVideoJob, initialVideoRequestStatus,
    singleVideoResponderGate, videoReplyChainGuidance,
} from '../dist/VideoGeneration.js';
import { oalgoSourceImageCompositePlan } from '../dist/VideoOalgoComposite.js';
import { VIDEO_MODELS, VIDEO_PLANNER_GUIDANCE_MAX_CHARS } from '../dist/VideoProtocol.js';
import { storeVideoSourceImage } from '../dist/VideoSourceImage.js';

const others = character => VIDEO_CHARACTERS.filter(other => other !== character);
// Every prompt a character contributes, for checks that hold across all of them.
const prompts = character => [
    videoCharacterPlannerGuidance(character),
    videoCharacterPhotorealKeyframe(character),
    JSON.stringify(oalgoSourceImageCompositePlan('He waves at the camera.', character)),
    videoEditIntentInstructions(character.name),
].join('\n');

test('the character registry has unambiguous ids, presets, commands, and portraits', () => {
    const ids = VIDEO_CHARACTERS.flatMap(character => [character.id, ...(character.presetAliases || [])]);
    assert.equal(new Set(ids).size, ids.length);
    const commands = VIDEO_CHARACTERS.flatMap(character => Object.values(character.commands)
        .flatMap(command => [command.variant, ...(command.aliases || [])]));
    assert.equal(new Set(commands).size, commands.length);
    const modelCommands = Object.values(VIDEO_MODELS).map(model => model.command);
    for (const command of commands) assert.equal(modelCommands.includes(command), false, `${command} is a renderer command`);
    for (const character of VIDEO_CHARACTERS) {
        assert.equal(character.id, character.name.toLowerCase());
        assert.equal(videoCharacterForPreset(character.id), character);
        assert.ok(character.commands.minimax, `${character.name} needs a MiniMax command`);
        const portrait = readFileSync(new URL(`../images/${character.image}`, import.meta.url));
        assert.equal(portrait.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${character.image} must be a PNG`);
        for (const [model, command] of Object.entries(character.commands)) {
            assert.ok(VIDEO_MODELS[model], `${model} is a video model`);
            assert.equal(videoCharacterForCommand(command.variant), character);
            assert.equal(videoCharacterCommandLabel(command.variant), command.label);
        }
    }
    assert.equal(videoCharacterForPreset('oalgo'), MEXIMUTT);
    for (const unknown of ['minimax', 'meximutt', '', null, undefined]) assert.equal(videoCharacterForCommand(unknown), null);
    for (const unknown of ['minimax', '', null, undefined, 7]) assert.equal(videoCharacterForPreset(unknown), null);
});

for (const character of VIDEO_CHARACTERS) {
    const { name } = character;

    test(`${name} has his own commands`, () => {
        for (const [model, command] of Object.entries(character.commands)) {
            const declared = Commands.filter(candidate => candidate.aliases.includes(command.variant));
            assert.equal(declared.length, 1, `${command.variant} is declared once`);
            assert.deepEqual(declared[0].aliases, [command.variant, ...(command.aliases || [])]);
            assert.equal(declared[0].discordOnly, true);
            assert.ok(declared[0].commandGates.includes(singleVideoResponderGate));
            assert.match(declared[0].primaryCommand.description, new RegExp(name));
            for (const example of declared[0].primaryCommand.examples) {
                assert.ok(example.value.startsWith(`${command.variant} `), example.value);
            }
            for (const related of declared[0].relatedCommands) {
                assert.ok(Commands.some(candidate => candidate.aliases.includes(related)), `${related} exists`);
            }
            assert.match(initialVideoRequestStatus(model, command.variant), new RegExp(`your ${command.label} video`));
        }
    });

    test(`${name}'s prompts describe only him`, () => {
        const text = prompts(character);
        assert.match(text, new RegExp(name));
        for (const other of others(character)) {
            for (const foreign of [other.name, other.clothing, other.clothingAndEmblem, other.accent, other.dialogueStyle]) {
                assert.equal(text.includes(foreign), false, `${name} prompts mention ${foreign}`);
            }
        }
        const guidance = videoCharacterPlannerGuidance(character);
        assert.match(guidance, new RegExp(`^${name} is the recurring character`));
        assert.ok(guidance.includes(`dialogue.delivery: "${character.delivery}".`));
        assert.equal(character.delivery.includes('"'), false, 'The delivery is quoted inside the guidance.');
        assert.ok(character.delivery.includes(`strong ${character.accent} accent`));
        assert.ok(guidance.includes(`his own ${character.eyes} and facial proportions`));
        assert.ok(guidance.includes(`Preserve his ${character.clothing} while`));
        assert.match(guidance, new RegExp(`Season nearly every new ${name} line with slang`));
        for (const phrase of character.slang) assert.ok(guidance.includes(`“${phrase}`), `${phrase} is offered as slang`);
        if (character.persona) assert.ok(guidance.includes(character.persona));
        assert.match(guidance, /explicitly requested verbatim/);
        assert.doesNotMatch(guidance, /undefined|\n/);
    });

    test(`${name}'s guidance fits the broker's limit with the longest request context`, () => {
        const combined = [videoCharacterPlannerGuidance(character), VIDEO_CLIP_FRAME_PLANNER_GUIDANCE,
            videoReplyChainGuidance(Array.from({ length: 3 }, () => ({ content: 'y'.repeat(1000) })))].join(' ');
        assert.ok(combined.length <= VIDEO_PLANNER_GUIDANCE_MAX_CHARS, `combined guidance is ${combined.length} characters`);
    });

    test(`${name}'s scene openings and image compositions keep his portrait`, () => {
        const photoreal = videoCharacterPhotorealKeyframe(character);
        assert.ok(photoreal.includes(`the original ${name} portrait`));
        assert.ok(photoreal.includes(`his own ${character.eyes} at their true size`));
        assert.doesNotMatch(photoreal, /cartoon|anim|3D|CG|Pixar|not |never/i, 'The image models draw styles they are told to avoid.');
        const plan = oalgoSourceImageCompositePlan('He waves at the camera.', character);
        assert.ok(plan.keyframe.prompt.includes(`adding ${name} from Reference 1 as one additional, separate person`));
        assert.ok(plan.keyframe.prompt.includes(`heavy torso, and ${character.clothing}.`));
        assert.ok(plan.keyframe.motion_contract.camera_relation.includes(`recognizable ${name}`));
        // Local Qwen Image has never heard of him, so it meets him as a picture.
        const local = bindLocalPresetIdentity(`${photoreal} ${name}'s shirt stays on ${name}.`, character);
        assert.equal(local.includes(name), false);
        assert.match(local, /camera realism of Picture 1:.* the Picture 1 man's shirt stays on the man in Picture 1\./);
    });

    test(`${name}'s video edits offer him as the default replacement`, () => {
        const instructions = videoEditIntentInstructions(name);
        assert.ok(instructions.includes(`If hasPreset is true, ${name} is the command's default replacement.`));
        assert.ok(instructions.includes(`start replacement with "${name}" followed by any requested directions`));
    });

    test(`${name}'s status posts name him`, () => {
        const { variant, label } = character.commands.minimax;
        const base = { id: '096444e4-test', model: 'minimax', command_variant: variant, prompt: 'test',
            status: 'running', has_source_image: true, progress: null };
        for (const [source_kind, description] of [
            ['preset', `Starring ${name}`],
            ['preset_image', `Combining ${name} with your image`],
            ['preset_video_frame', `Combining ${name} with a frame from your video`],
        ]) {
            const job = { ...base, source_kind };
            assert.ok(formatVideoJob(job).includes(`**${label} · `));
            assert.ok(formatVideoJob(job).includes(description));
            assert.ok(completedVideoPost(job).includes(description));
        }
    });

    test(`the broker stars ${name} for his commands only`, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'dave-video-character-'));
        const composed = [];
        const broker = new VideoBroker({
            host: '127.0.0.1', port: 0, dbPath: join(directory, 'queue.sqlite3'), resultsDir: join(directory, 'results'),
            botToken: 'bot-secret', workerToken: 'worker-secret', preplanQueuedJobs: false,
            // The bundled portrait is stored for real; a Discord attachment is stubbed.
            sourceImageDownloader: async (descriptor, target) => {
                if ('preset' in descriptor) return storeVideoSourceImage(descriptor, target);
                mkdirSync(target, { recursive: true });
                writeFileSync(join(target, 'source.png'), 'attached');
                return { path: join(target, 'source.png'), mimeType: 'image/png', bytes: 8 };
            },
            sourceImageComposer: async (base, _attached, _prompt, _hooks, _provider, star) => {
                composed.push({ star, base: readFileSync(base.path) });
                return { bytes: Buffer.from('composite'), mimeType: 'image/png', provider: 'test', model: 'test' };
            },
        });
        await broker.start();
        let sequence = 0;
        const submit = async body => {
            const n = ++sequence;
            const response = await fetch(`http://127.0.0.1:${broker.listeningPort()}/v1/jobs`, {
                method: 'POST', headers: { authorization: 'Bearer bot-secret', 'content-type': 'application/json' },
                body: JSON.stringify({ prompt: 'Animate the preset', requester_id: `user-${n}`, origin_bot_id: 'bot-1',
                    channel_id: 'channel-1', command_message_id: `message-${n}`, status_message_id: `status-${n}`, ...body }),
            });
            return { status: response.status, body: await response.json() };
        };
        try {
            const portrait = readFileSync(new URL(`../images/${character.image}`, import.meta.url));
            for (const [model, { variant }] of Object.entries(character.commands)) {
                for (const command_variant of [variant, undefined]) {
                    const accepted = await submit({ model, command_variant, source_image: { preset: character.id } });
                    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
                    assert.equal(accepted.body.job.command_variant, variant);
                    assert.equal(accepted.body.job.source_kind, 'preset');
                    assert.deepEqual(readFileSync(join(directory, 'results', accepted.body.job.id, 'source.png')), portrait);
                }
                for (const other of others(character)) {
                    const mismatched = await submit({ model, command_variant: variant, source_image: { preset: other.id } });
                    assert.equal(mismatched.status, 400);
                    assert.match(mismatched.body.error, /belongs to another character command/);
                }
            }
            if (!character.commands.minimaxfast) {
                for (const command_variant of [character.commands.minimax.variant, undefined]) {
                    const rejected = await submit({ model: 'minimaxfast', command_variant, source_image: { preset: character.id } });
                    assert.equal(rejected.status, 400);
                    assert.match(rejected.body.error, /Invalid video command variant/);
                }
            }
            const combined = await submit({ model: 'minimax', command_variant: character.commands.minimax.variant,
                source_image: { preset: character.id }, source_image_composite: {
                    url: 'https://cdn.discordapp.com/attachments/1/2/attached.png', mime_type: 'image/png', bytes: 8 } });
            assert.equal(combined.status, 201, JSON.stringify(combined.body));
            assert.equal(combined.body.job.source_kind, 'preset_image');
            assert.equal(composed.length, 1);
            assert.equal(composed[0].star, character, 'The composition prompts name the command\'s own character.');
            assert.deepEqual(composed[0].base, portrait);
        } finally {
            await broker.stop();
            rmSync(directory, { recursive: true, force: true });
        }
    });
}
