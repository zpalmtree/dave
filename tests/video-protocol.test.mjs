import assert from 'node:assert/strict';
import test from 'node:test';

import { Commands } from '../dist/CommandDeclarations.js';
import {
    formatVideoJob,
    formatVideoRuntime,
    singleVideoResponderGate,
    videoPromptFromMessages,
    videoSourceImageFromMessage,
    videoSourceImageFromMessages,
} from '../dist/VideoGeneration.js';
import { VIDEO_MODELS, isVideoModel, parsePauseDuration } from '../dist/VideoProtocol.js';
import {
    VIDEO_PLAN_SCHEMA,
    VIDEO_PLANNER_INSTRUCTIONS,
    VIDEO_PLANNER_MODEL,
} from '../dist/VideoFrontierPlanner.js';
import {
    buildVideoKeyframePrompt,
    buildVideoKeyframeReviewPrompt,
    VIDEO_KEYFRAME_FALLBACK_MODEL,
    VIDEO_KEYFRAME_MODEL,
    VIDEO_KEYFRAME_REVIEW_MODEL,
} from '../dist/VideoKeyframeProvider.js';

test('video pause durations default to six hours and enforce safe limits', () => {
    assert.equal(parsePauseDuration(undefined), 6 * 60 * 60);
    assert.equal(parsePauseDuration('90m'), 90 * 60);
    assert.equal(parsePauseDuration('2d'), 2 * 24 * 60 * 60);
    assert.throws(() => parsePauseDuration('30s'), /look like/);
    assert.throws(() => parsePauseDuration('8d'), /between 1 minute and 7 days/);
});

test('local video commands are declared as Discord-only', () => {
    for (const name of ['ltx', 'ltxfast', 'minimax', 'minimaxfast', 'minimaxdraft', 'videoqueue', 'videogen']) {
        const command = Commands.find(candidate => candidate.aliases.includes(name));
        assert.ok(command, `${name} command is present`);
        assert.equal(command.discordOnly, true);
    }
});

test('test channel video commands have one silent Dave responder', () => {
    for (const name of ['ltx', 'ltxfast', 'minimax', 'minimaxfast', 'minimaxdraft', 'videoqueue', 'videogen']) {
        const command = Commands.find(candidate => candidate.aliases.includes(name));
        assert.ok(command.commandGates.includes(singleVideoResponderGate));
    }
    const message = (channelId, botId) => ({
        channel: { id: channelId },
        client: { user: { id: botId } },
    });
    assert.deepEqual(
        singleVideoResponderGate(message('483470443001413675', '446154284514541579')),
        { canAccess: true },
    );
    assert.deepEqual(
        singleVideoResponderGate(message('483470443001413675', '903156913724874832')),
        { canAccess: false },
    );
    assert.deepEqual(singleVideoResponderGate(message('another-channel', '903156913724874832')), {
        canAccess: true,
    });
});

test('video runtime is formatted for the delivered post', () => {
    assert.equal(formatVideoRuntime(null), null);
    assert.equal(formatVideoRuntime(8.4), '8s');
    assert.equal(formatVideoRuntime(65.6), '1m 6s');
    assert.equal(formatVideoRuntime(3661), '1h 1m 1s');
});

test('fast video commands map to explicit quality tradeoffs', () => {
    assert.deepEqual(
        VIDEO_MODELS.ltxfast.generatorArgs,
        ['--model', 'ltx', '--quality', 'draft', '--ltx-one-stage'],
    );
    assert.deepEqual(
        VIDEO_MODELS.minimaxfast.generatorArgs,
        ['--model', 'h3', '--quality', 'final', '--fast'],
    );
    assert.deepEqual(
        VIDEO_MODELS.minimaxdraft.generatorArgs,
        ['--model', 'h3', '--quality', 'draft', '--turbo4'],
    );
    assert.equal(isVideoModel('ltxfast'), true);
    assert.equal(isVideoModel('minimaxfast'), true);
    assert.equal(isVideoModel('minimaxdraft'), true);
});

test('offline queue messages omit fake ETAs', () => {
    const text = formatVideoJob({
        id: '12345678-1234-1234-1234-123456789abc',
        model: 'minimax',
        prompt: 'test',
        requester_id: 'u',
        origin_bot_id: 'b',
        channel_id: 'c',
        guild_id: null,
        command_message_id: 'm',
        status_message_id: 's',
        status: 'queued',
        queue_position: 2,
        estimate_low_seconds: 10,
        estimate_high_seconds: 20,
        expected_start_at: null,
        expected_finish_at: null,
        stage: null,
        progress: null,
        error: null,
        result_path: null,
        result_bytes: null,
        has_source_image: false,
        created_at: 1,
        updated_at: 1,
        started_at: null,
        completed_at: null,
        runtime_seconds: null,
        delivered_at: null,
        worker_online: false,
        worker_busy: false,
        paused_until: null,
    });
    assert.match(text, /Queue position: \*\*2\*\*/);
    assert.match(text, /offline/);
    assert.doesNotMatch(text, /Expected (start|finish)/);
});

test('frontier video planning uses Sol and a strict recursive screenplay schema', () => {
    assert.equal(VIDEO_PLANNER_MODEL, 'gpt-5.6-sol');
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /vehicle nose, visible road\/path ahead/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /positive-only diffusion prompt/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /do not put the franchise name/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /at most three identity-critical people/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /user-supplied start image/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Every hard scene change/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /one independently generated clip/);
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'object') assert.equal(value.additionalProperties, false);
        for (const child of Object.values(value)) visit(child);
    };
    visit(VIDEO_PLAN_SCHEMA);
});

test('video commands accept exactly one supported attached start frame', () => {
    const attachment = {
        url: 'https://cdn.discordapp.com/attachments/1/2/frame.png',
        contentType: 'image/png',
        name: 'frame.png',
        size: 1234,
    };
    const selected = videoSourceImageFromMessage({ attachments: new Map([['one', attachment]]) });
    assert.deepEqual(selected, {
        url: attachment.url,
        mime_type: 'image/png',
        bytes: 1234,
        name: 'frame.png',
    });
    assert.throws(
        () => videoSourceImageFromMessage({ attachments: new Map([
            ['one', attachment],
            ['two', { ...attachment, url: `${attachment.url}?second=1` }],
        ]) }),
        /one starting image/,
    );
    assert.throws(
        () => videoSourceImageFromMessage({
            attachments: new Map([['gif', { ...attachment, contentType: 'image/gif', name: 'frame.gif' }]]),
        }),
        /PNG, JPEG, or WebP/,
    );
});

test('video commands inherit prompt and image context from a replied-to message', () => {
    const replyAttachment = {
        url: 'https://cdn.discordapp.com/attachments/1/2/reply.png',
        contentType: 'image/png',
        name: 'reply.png',
        size: 1234,
    };
    const commandAttachment = {
        ...replyAttachment,
        url: 'https://cdn.discordapp.com/attachments/1/2/command.webp',
        contentType: 'image/webp',
        name: 'command.webp',
    };
    const reply = {
        content: 'Three racers approach a neon finish line.',
        attachments: new Map([['reply', replyAttachment]]),
    };
    const commandWithoutImage = { attachments: new Map() };
    assert.equal(
        videoPromptFromMessages('', reply),
        'Three racers approach a neon finish line.',
    );
    assert.equal(
        videoPromptFromMessages('Make it rainy.', reply),
        'Context from the replied message:\nThree racers approach a neon finish line.\n\nCurrent instruction (takes priority):\nMake it rainy.',
    );
    assert.equal(
        videoSourceImageFromMessages(commandWithoutImage, reply).url,
        replyAttachment.url,
    );
    assert.equal(
        videoSourceImageFromMessages(
            { attachments: new Map([['command', commandAttachment]]) },
            reply,
        ).url,
        commandAttachment.url,
    );
});

test('frontier keyframe prompt binds frame-zero motion geometry', () => {
    assert.equal(VIDEO_KEYFRAME_MODEL, 'gemini-3-pro-image');
    assert.equal(VIDEO_KEYFRAME_FALLBACK_MODEL, 'gpt-image-2');
    assert.equal(VIDEO_KEYFRAME_REVIEW_MODEL, 'gpt-5.6-sol');
    const prompt = buildVideoKeyframePrompt({
        keyframe: {
            prompt: 'Three named drivers race through a colorful arcade circuit.',
            motion_contract: {
                subject_orientation: 'karts point toward upper right',
                gaze_direction: 'drivers look down-track',
                travel_direction: 'left to right',
                camera_relation: 'rear three-quarter chase view',
                first_second_action: 'accelerate forward without turning',
            },
        },
    });
    assert.match(prompt, /exactly frame 0\.00/);
    assert.match(prompt, /karts point toward upper right/);
    assert.match(prompt, /accelerate forward without turning/);
    assert.match(prompt, /requires no turn, reversal/);
    const review = buildVideoKeyframeReviewPrompt({
        intent: 'The three drivers accelerate down-track.',
        keyframe: {
            prompt: 'Exactly three profile-visible drivers.',
            motion_contract: {
                travel_direction: 'toward the upper-right vanishing point',
            },
        },
        segments: [{ shots: [{
            visual: 'The three karts accelerate down-track.',
            camera: 'Rear three-quarter tracking shot.',
        }] }],
    });
    assert.match(review, /physical front\/nose/);
    assert.match(review, /visible road or path ahead/);
    assert.match(review, /positive-only description/);
});
