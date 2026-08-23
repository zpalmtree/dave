import assert from 'node:assert/strict';
import test from 'node:test';

import { Commands } from '../dist/CommandDeclarations.js';
import {
    formatVideoJob,
    formatGlobalVideoQueueJob,
    formatVideoRuntime,
    globalVideoQueueChunks,
    completedVideoPost,
    failedVideoPost,
    singleVideoResponderGate,
    videoPromptFromMessages,
    videoJobDirection,
    videoSourceImageFromMessage,
    videoSourceImageFromMessages,
} from '../dist/VideoGeneration.js';
import {
    VIDEO_IMAGE_ONLY_AUTO_PROMPT,
    VIDEO_MODELS,
    isVideoModel,
    parsePauseDuration,
    sanitizeVideoWorkerText,
} from '../dist/VideoProtocol.js';
import {
    VIDEO_PLAN_SCHEMA,
    VIDEO_PROMPT_ANALYSIS_SCHEMA,
    VIDEO_PROMPT_ANALYZER_INSTRUCTIONS,
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
    for (const name of ['ltx', 'ltxfast', 'minimax', 'minimaxfast', 'videoqueue', 'videogen', 'videostats']) {
        const command = Commands.find(candidate => candidate.aliases.includes(name));
        assert.ok(command, `${name} command is present`);
        assert.equal(command.discordOnly, true);
    }
    assert.equal(Commands.some(candidate => candidate.aliases.includes('minimaxdraft')), false);
});

test('test channel video commands have one silent Dave responder', () => {
    for (const name of ['ltx', 'ltxfast', 'minimax', 'minimaxfast', 'videoqueue', 'videogen', 'videostats']) {
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
    assert.match(completedVideoPost({
        id: 'a1869ead-bbac-4733-abc8-c07f4cfec52a',
        model: 'minimaxdraft',
        runtime_seconds: 65.6,
        prompt: 'An anime family battle',
    }), /a1869ead.*completed in \*\*1m 6s\*\*/);
});

test('failed video post is a standalone sanitized reply', () => {
    const text = failedVideoPost({
        id: '09cfe948-165f-43d6-80bf-1f66dd26ee98',
        model: 'minimaxfast',
        runtime_seconds: null,
        prompt: 'baboons at a zoo',
        error: 'Failed at D:\\AI\\private\\video.plan.json',
    });
    assert.match(text, /MiniMax H3 Turbo video \*\*09cfe948\*\* failed/);
    assert.match(text, /> baboons at a zoo/);
    assert.doesNotMatch(text, /D:\\|private|video\.plan/);
});

test('worker progress never exposes local filesystem paths', () => {
    assert.equal(
        sanitizeVideoWorkerText(
            'Completed H3: D:\\AI\\ComfyUI_windows_portable\\output\\segment.mp4',
            'Generating',
        ),
        'H3 segment complete',
    );
    assert.equal(
        sanitizeVideoWorkerText('Loading /home/zp/private/model.safetensors', 'Generating'),
        'Loading [local file]',
    );
    assert.doesNotMatch(
        sanitizeVideoWorkerText('Failed at C:\\Users\\zp\\secret\\frame.png', 'Worker failure', 2000),
        /Users|secret|frame\.png/,
    );
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
        estimate_ready: false,
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

test('global video queue identifies requesters and splits long server queues safely', () => {
    const queued = {
        id: '12345678-1234-1234-1234-123456789abc',
        model: 'minimax',
        prompt: 'Three racers approach a neon finish line.',
        requester_id: '483470443001413675',
        origin_bot_id: 'b',
        channel_id: 'c',
        guild_id: null,
        command_message_id: 'm',
        status_message_id: 's',
        status: 'queued',
        queue_position: 2,
        estimate_low_seconds: 300,
        estimate_high_seconds: 600,
        estimate_ready: true,
        expected_start_at: 2_000_000_000,
        expected_finish_at: 2_000_000_450,
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
        worker_online: true,
        worker_busy: true,
        paused_until: null,
    };
    const formatted = formatGlobalVideoQueueJob(queued);
    assert.match(formatted, /Queue position: \*\*2\*\*/);
    assert.match(formatted, /<@483470443001413675>/);
    assert.match(formatted, /Three racers approach a neon finish line/);

    const chunks = globalVideoQueueChunks(Array.from({ length: 12 }, (_, index) => ({
        ...queued,
        id: `${String(index).padStart(8, '0')}-1234-1234-1234-123456789abc`,
        prompt: `Server-wide queued prompt ${index} ${'x'.repeat(90)}`,
    })), 700);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length <= 700));
    assert.deepEqual(globalVideoQueueChunks([]), ['The server video queue is empty.']);
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
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Treat explicit speaking intent as authority to write speech/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /non-dialogue audio as a chronological production contract/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /physical source, material or timbre/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /segment\.music exactly to N\/A/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /narrative_montage/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /narrative_adaptation/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /rigid_artifact/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Treat visible language as quoted source material/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /first-person confession/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Do not sanitize, rehabilitate, moralize/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /counterfactual fidelity check/);
    assert.doesNotMatch(VIDEO_PLANNER_INSTRUCTIONS, /Never invent dialogue/);
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'object') assert.equal(value.additionalProperties, false);
        for (const child of Object.values(value)) visit(child);
    };
    visit(VIDEO_PLAN_SCHEMA);
    visit(VIDEO_PROMPT_ANALYSIS_SCHEMA);
});

test('image-only jobs show the inferred direction instead of an internal fallback prompt', () => {
    assert.equal(videoJobDirection({
        prompt: VIDEO_IMAGE_ONLY_AUTO_PROMPT,
        planned_intent: null,
    }), 'Auto-directing the attached image.');
    assert.equal(videoJobDirection({
        prompt: VIDEO_IMAGE_ONLY_AUTO_PROMPT,
        planned_intent: 'A meme remains readable while its pictured dog blinks.',
    }), 'Auto-direction: A meme remains readable while its pictured dog blinks.');
    assert.equal(videoJobDirection({
        prompt: 'Make the dog run.',
        planned_intent: 'Ignored for explicit prompts.',
    }), 'Make the dog run.');
});

test('frontier prompt analysis classifies intent independently before screenplay planning', () => {
    assert.deepEqual(VIDEO_PROMPT_ANALYSIS_SCHEMA.properties.request_form.enum, [
        'visual_direction',
        'verbatim_utterance',
        'speaker_script',
        'conversation_topic',
        'mixed',
        'image_only',
    ]);
    assert.deepEqual(VIDEO_PROMPT_ANALYSIS_SCHEMA.properties.dialogue_contract.properties.mode.enum, [
        'none',
        'verbatim',
        'generated',
        'mixed',
    ]);
    assert.deepEqual(VIDEO_PROMPT_ANALYSIS_SCHEMA.properties.source_image_strategy.enum, [
        'none',
        'continuous_scene',
        'narrative_montage',
        'premise_reenactment',
        'narrative_adaptation',
        'rigid_artifact',
        'motion_graphic',
    ]);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /Classify these axes independently/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /prompt can itself be an utterance/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /Copy every user-supplied spoken line exactly/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /production directions, not speakers/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /generic reinterpretations/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /narrative affordances/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /narrative_montage/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /concrete event with an activity and consequence/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /small but legible logos, uniforms, tools/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Do not default every meme or screenshot/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /mini-event with a setup, physical action, and visible consequence/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /accessory adjustment, or panel pan is not sufficient/);
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
