import assert from 'node:assert/strict';
import test from 'node:test';

import { Commands } from '../dist/CommandDeclarations.js';
import {
    canViewGlobalVideoQueue,
    formatVideoJob,
    formatVideoStatusPost,
    formatGlobalVideoQueueJob,
    formatVideoRuntime,
    globalVideoQueueChunks,
    globalVideoQueueEmbeds,
    initialVideoRequestStatus,
    isVideoCancellationReaction,
    MEXIMUTT_VIDEO_PLANNER_GUIDANCE,
    OALGO_VIDEO_PLANNER_GUIDANCE,
    completedVideoPost,
    failedVideoPost,
    singleVideoResponderGate,
    videoPromptFromMessages,
    videoJobDirection,
    videoSourceImageFromMessage,
    videoSourceImageFromMessages,
    videoPollDelayMs,
    VIDEO_CANCEL_REACTION,
} from '../dist/VideoGeneration.js';
import {
    VIDEO_DISCORD_BASELINE_UPLOAD_BYTES,
    VIDEO_DISCORD_TIER_2_UPLOAD_BYTES,
    VIDEO_DISCORD_TIER_3_UPLOAD_BYTES,
    VIDEO_IMAGE_ONLY_AUTO_PROMPT,
    VIDEO_MODELS,
    discordVideoUploadLimitBytes,
    isVideoModel,
    parsePauseDuration,
    requestedVideoDurationSeconds,
    sanitizeVideoWorkerText,
} from '../dist/VideoProtocol.js';
import {
    VIDEO_DURATION_DISCIPLINE_INSTRUCTIONS,
    VIDEO_PLAN_SCHEMA,
    VIDEO_PROMPT_ANALYSIS_SCHEMA,
    VIDEO_PROMPT_ANALYZER_INSTRUCTIONS,
    VIDEO_SINGLE_PASS_INSTRUCTIONS,
    VIDEO_SINGLE_PASS_SCHEMA,
    VIDEO_PLANNER_INSTRUCTIONS,
    VIDEO_PLANNER_FAST_MODEL,
    VIDEO_PLANNER_GEMINI_SCHEMA_MODE,
    VIDEO_PLANNER_MODEL,
    UNIQUE_US_PRESIDENTS,
    FrontierPlannerRejectedError,
    compileBestEffortFrontierVideoPlan,
    createFrontierVideoPlan,
    geminiCompatibleResponseSchema,
    configuredVideoPlannerStrategy,
    configuredVideoPlannerVariant,
    expandExhaustiveSequentialPlan,
    reconcileFrontierKeyframeMotionGeometry,
    stageFrontierDialogueVisually,
    stageFrontierVisibleText,
    validateFrontierVideoPlanForKeyframe,
    videoPlannerFingerprint,
    videoPlannerPromptCacheFields,
} from '../dist/VideoFrontierPlanner.js';
import {
    buildVideoKeyframePrompt,
    buildVideoKeyframeReviewPrompt,
    VIDEO_KEYFRAME_FALLBACK_MODEL,
    VIDEO_KEYFRAME_FAST_GATE_HEDGE_DELAY_MS,
    VIDEO_KEYFRAME_FAST_LITE_MODEL,
    VIDEO_KEYFRAME_FAST_MODEL,
    VIDEO_KEYFRAME_MODEL,
    VIDEO_KEYFRAME_REVIEW_MODEL,
    VIDEO_KEYFRAME_REVIEW_TIMEOUT_MS,
    configuredVideoKeyframeStrategy,
    configuredVideoKeyframeVariant,
    createFrontierVideoKeyframe,
    geminiNoImageDetail,
    isRetryableVideoKeyframeGenerationFailure,
    videoKeyframeReviewDetail,
} from '../dist/VideoKeyframeProvider.js';
import {
    VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL,
    videoSegmentKeyframeTargetIndexes,
} from '../dist/VideoSegmentKeyframePlanner.js';

test('video pause durations default to six hours and enforce safe limits', () => {
    assert.equal(parsePauseDuration(undefined), 6 * 60 * 60);
    assert.equal(parsePauseDuration('90m'), 90 * 60);
    assert.equal(parsePauseDuration('2d'), 2 * 24 * 60 * 60);
    assert.throws(() => parsePauseDuration('30s'), /look like/);
    assert.throws(() => parsePauseDuration('8d'), /between 1 minute and 7 days/);
});

test('explicit total video durations are extracted without mistaking shot timing for runtime', () => {
    assert.equal(
        requestedVideoDurationSeconds(
            'Create a 15-second fast-paced character creation timelapse in a drawing interface.',
        ),
        15,
    );
    assert.equal(requestedVideoDurationSeconds('Video duration: 12.5 seconds.'), 12.5);
    assert.equal(requestedVideoDurationSeconds('Produce a 2-minute short film.'), 120);
    assert.equal(
        requestedVideoDurationSeconds(
            '0:00-0:02 rough sketch; 0:02-0:11 color; 0:11-0:15 final polish.',
        ),
        15,
    );
    assert.equal(
        requestedVideoDurationSeconds('Hold for 5 seconds, then make a 15-second video.'),
        15,
    );
    assert.equal(requestedVideoDurationSeconds('Wait 5 seconds before the character moves.'), null);
});

test('Discord video delivery limits follow the guild boost tier', () => {
    assert.equal(discordVideoUploadLimitBytes(undefined), VIDEO_DISCORD_BASELINE_UPLOAD_BYTES);
    assert.equal(discordVideoUploadLimitBytes(0), VIDEO_DISCORD_BASELINE_UPLOAD_BYTES);
    assert.equal(discordVideoUploadLimitBytes(1), VIDEO_DISCORD_BASELINE_UPLOAD_BYTES);
    assert.equal(discordVideoUploadLimitBytes(2), VIDEO_DISCORD_TIER_2_UPLOAD_BYTES);
    assert.equal(discordVideoUploadLimitBytes(3), VIDEO_DISCORD_TIER_3_UPLOAD_BYTES);
});

test('fast segment frame planning targets only independently generated hard cuts', () => {
    assert.equal(VIDEO_SEGMENT_KEYFRAME_PLANNER_MODEL, 'gemini-3.7-flash');
    assert.deepEqual(videoSegmentKeyframeTargetIndexes({
        segments: [
            { transition: 'start' },
            { transition: 'continue' },
            { transition: 'cut' },
            { transition: 'dissolve' },
        ],
    }), [3, 4]);
});

test('video delivery polling is fast only while work is active', () => {
    const idle = {
        worker_online: true,
        worker_busy: false,
        worker_id: 'worker',
        current_job: null,
        paused_until: null,
        queued: 0,
    };
    assert.equal(videoPollDelayMs([], idle), 15_000);
    assert.equal(videoPollDelayMs([], { ...idle, preparation_busy: true }), 3_000);
    assert.equal(videoPollDelayMs([], { ...idle, active_jobs: 1 }), 3_000);
    assert.equal(videoPollDelayMs([{}], idle), 3_000);
});

test('only a video job caller can use its cancellation reaction', () => {
    const reaction = emoji => ({ emoji: { name: emoji } });
    const user = id => ({ id });

    assert.equal(VIDEO_CANCEL_REACTION, '❌');
    assert.equal(isVideoCancellationReaction(reaction('❌'), user('caller'), 'caller'), true);
    assert.equal(isVideoCancellationReaction(reaction('❌'), user('someone-else'), 'caller'), false);
    assert.equal(isVideoCancellationReaction(reaction('👍'), user('caller'), 'caller'), false);
});

test('video planner requests share stable cache routing without retaining prompts by default', () => {
    const analysis = videoPlannerPromptCacheFields('prompt_analysis', {});
    const screenplay = videoPlannerPromptCacheFields('screenplay_repair', {});
    assert.match(analysis.prompt_cache_key, /^video-analysis-[0-9a-f]{32}$/);
    assert.match(screenplay.prompt_cache_key, /^video-screenplay-[0-9a-f]{32}$/);
    assert.equal(analysis.prompt_cache_retention, undefined);
    assert.equal(
        videoPlannerPromptCacheFields('screenplay', { VIDEO_PROMPT_CACHE_24H: '1' }).prompt_cache_retention,
        '24h',
    );
});

test('fast planner and reasoning variants are explicit and fingerprinted', () => {
    assert.deepEqual(configuredVideoPlannerVariant({}), {
        plannerModel: VIDEO_PLANNER_MODEL,
        analysisReasoningEffort: 'high',
        screenplayReasoningEffort: 'high',
    });
    assert.deepEqual(configuredVideoPlannerVariant({}, 'single-pass'), {
        plannerModel: VIDEO_PLANNER_MODEL,
        analysisReasoningEffort: 'low',
        screenplayReasoningEffort: 'low',
    });
    assert.deepEqual(configuredVideoPlannerVariant({
        VIDEO_PLANNER_ANALYSIS_EFFORT: 'high',
        VIDEO_PLANNER_SCREENPLAY_EFFORT: 'high',
    }, 'single-pass'), {
        plannerModel: VIDEO_PLANNER_MODEL,
        analysisReasoningEffort: 'high',
        screenplayReasoningEffort: 'high',
    });
    const fast = configuredVideoPlannerVariant({
        VIDEO_PLANNER_MODEL: VIDEO_PLANNER_FAST_MODEL,
        VIDEO_PLANNER_ANALYSIS_EFFORT: 'low',
        VIDEO_PLANNER_SCREENPLAY_EFFORT: 'medium',
    });
    assert.deepEqual(fast, {
        plannerModel: VIDEO_PLANNER_FAST_MODEL,
        analysisReasoningEffort: 'low',
        screenplayReasoningEffort: 'medium',
    });
    assert.notEqual(
        videoPlannerFingerprint(),
        videoPlannerFingerprint(
            fast.plannerModel,
            fast.analysisReasoningEffort,
            fast.screenplayReasoningEffort,
        ),
    );
    assert.equal(VIDEO_PLANNER_GEMINI_SCHEMA_MODE, 'compatible-structured-v1');
    assert.equal(configuredVideoPlannerStrategy('483470443001413675', {}), 'single-pass');
    assert.equal(configuredVideoPlannerStrategy('other-channel', {}), 'single-pass');
    assert.equal(configuredVideoPlannerStrategy('other-channel', {
        VIDEO_PLANNER_STRATEGY: 'single-pass',
    }), 'single-pass');
    assert.equal(configuredVideoPlannerStrategy('483470443001413675', {
        VIDEO_PLANNER_STRATEGY: 'two-pass',
    }), 'two-pass');
    assert.equal(configuredVideoPlannerStrategy('outside-old-canary', {
        VIDEO_PLANNER_CANARY_CHANNELS: 'canary-one, canary-two',
    }), 'single-pass');
});

test('Gemini planner schema keeps nested types while removing complexity constraints', () => {
    const schema = geminiCompatibleResponseSchema({
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
            items: {
                type: 'array', minItems: 1, maxItems: 4,
                items: {
                    type: 'object', additionalProperties: false, required: ['score'],
                    properties: { score: { type: 'number', minimum: 1, maximum: 10 } },
                },
            },
        },
    });
    assert.deepEqual(schema, {
        type: 'object',
        required: ['items'],
        properties: {
            items: {
                type: 'array',
                items: {
                    type: 'object', required: ['score'],
                    properties: { score: { type: 'number', minimum: 1, maximum: 10 } },
                },
            },
        },
    });
});

test('local video commands are declared as Discord-only', () => {
    for (const name of ['ltx', 'ltxfast', 'minimax', 'minimaxfast', 'oalgo', 'meximutt', 'minimutt', 'videoqueue', 'videogen', 'videostats']) {
        const command = Commands.find(candidate => candidate.aliases.includes(name));
        assert.ok(command, `${name} command is present`);
        assert.equal(command.discordOnly, true);
    }
    const oalgo = Commands.find(candidate => candidate.aliases.includes('oalgo'));
    assert.deepEqual(oalgo.aliases, ['oalgo', 'minimutt']);
    const meximutt = Commands.find(candidate => candidate.aliases.includes('meximutt'));
    assert.deepEqual(meximutt.aliases, ['meximutt']);
    assert.notEqual(meximutt.primaryCommand.implementation, oalgo.primaryCommand.implementation);
    for (const phrase of ['o algo', 'mayne', 'wey', 'puta pinche', 'no mames wey']) {
        assert.match(OALGO_VIDEO_PLANNER_GUIDANCE, new RegExp(phrase));
    }
    assert.match(OALGO_VIDEO_PLANNER_GUIDANCE, /explicitly requested verbatim/);
    assert.match(MEXIMUTT_VIDEO_PLANNER_GUIDANCE, /Every dialogue turn/);
    assert.match(MEXIMUTT_VIDEO_PLANNER_GUIDANCE, /Spanglish accent in dialogue\.delivery/);
    assert.match(MEXIMUTT_VIDEO_PLANNER_GUIDANCE, /including dialogue supplied verbatim/);
    assert.match(MEXIMUTT_VIDEO_PLANNER_GUIDANCE, /characters other than OALGO/);
    assert.match(MEXIMUTT_VIDEO_PLANNER_GUIDANCE, /exaggerated, unmistakable cholo\/ese-style Mexican-American Spanglish accent/);
    assert.match(MEXIMUTT_VIDEO_PLANNER_GUIDANCE, /hard-edged, streetwise cadence/);
    assert.match(MEXIMUTT_VIDEO_PLANNER_GUIDANCE, /bold, over-the-top street caricature/);
    for (const phrase of ['ese', 'güey', 'cabrón', 'pinche', 'no mames']) {
        assert.match(MEXIMUTT_VIDEO_PLANNER_GUIDANCE, new RegExp(phrase));
    }
    assert.match(MEXIMUTT_VIDEO_PLANNER_GUIDANCE, /Keep user-supplied dialogue text verbatim/);
    assert.equal(Commands.some(candidate => candidate.aliases.includes('minimaxdraft')), false);
});

test('test channel video commands have one silent Dave responder', () => {
    for (const name of ['ltx', 'ltxfast', 'minimax', 'minimaxfast', 'oalgo', 'meximutt', 'minimutt', 'videoqueue', 'videogen', 'videostats']) {
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

test('only test-channel moderators can view the global video queue', () => {
    const message = ({
        channelId = '483470443001413675',
        authorId = 'ordinary-user',
        canManageMessages = false,
    } = {}) => ({
        channel: { id: channelId },
        author: { id: authorId },
        member: {
            permissions: {
                has: () => canManageMessages,
            },
        },
    });

    assert.equal(canViewGlobalVideoQueue(message({ canManageMessages: true })), true);
    assert.equal(canViewGlobalVideoQueue(message()), false);
    assert.equal(canViewGlobalVideoQueue(message({
        channelId: 'another-channel',
        canManageMessages: true,
    })), false);
});

test('video runtime is formatted for the delivered post', () => {
    assert.equal(formatVideoRuntime(null), null);
    assert.equal(formatVideoRuntime(8.4), '8s');
    assert.equal(formatVideoRuntime(65.6), '1m 6s');
    assert.equal(formatVideoRuntime(3661), '1h 1m 1s');
    assert.match(completedVideoPost({
        id: 'a1869ead-bbac-4733-abc8-c07f4cfec52a',
        model: 'minimax',
        runtime_seconds: 65.6,
        prompt: 'An anime family battle',
    }), /a1869ead.*completed in \*\*1m 6s\*\*/);
    assert.match(completedVideoPost({
        id: 'legacy-draft-job',
        model: 'minimaxdraft',
        runtime_seconds: 65.6,
        prompt: 'A historical completed request',
    }), /^Retired video model video/);
    assert.match(completedVideoPost({
        id: 'a1869ead-bbac-4733-abc8-c07f4cfec52a',
        model: 'minimaxfast',
        runtime_seconds: 65.6,
        prompt: 'An anime family battle',
        generation_notice: 'The screenplay was truncated.',
    }), /\*\*Note:\*\* The screenplay was truncated\./);
});

test('video replies preserve the full accepted prompt', () => {
    const prompt = `Opening scene. ${'Keep this exact requested detail. '.repeat(50)}Final instruction.`;
    const job = {
        id: 'a1869ead-bbac-4733-abc8-c07f4cfec52a',
        model: 'minimax',
        runtime_seconds: 65.6,
        prompt,
        prompt_tease: 'Pervert.',
        generation_notice: 'The screenplay was prepared successfully.',
        error: 'A detailed worker failure occurred while preparing the requested video. '.repeat(20),
        status: 'queued',
        queue_position: 2,
        paused_until: null,
        dispatch_paused: false,
        worker_online: true,
        estimate_ready: true,
        expected_finish_at: 2_000_000_450,
        has_source_image: false,
    };

    const status = formatVideoStatusPost(job);
    const completed = completedVideoPost(job);
    const failed = failedVideoPost(job);
    for (const reply of [status, completed, failed]) {
        assert.ok(reply.length <= 1999);
        assert.ok(reply.endsWith(`> ${prompt}`));
    }
    assert.doesNotMatch(status, /Pervert/);
    assert.match(completed, /\nPervert\.\n> /);
    assert.doesNotMatch(failed, /Pervert/);
});

test('video replies fit when a referenced prompt uses Discord\'s full content allowance', () => {
    const prompt = 'Maximum-length replied-message prompt. '.repeat(60).slice(0, 2000).padEnd(2000, 'x');
    const job = {
        id: 'a1869ead-bbac-4733-abc8-c07f4cfec52a',
        model: 'minimax',
        runtime_seconds: 65.6,
        prompt,
        prompt_tease: 'Pervert.',
        generation_notice: 'The screenplay was prepared successfully.',
        error: 'A detailed worker failure occurred while preparing the requested video.',
        status: 'queued',
        queue_position: 2,
        paused_until: null,
        dispatch_paused: false,
        worker_online: true,
        estimate_ready: true,
        expected_finish_at: 2_000_000_450,
        has_source_image: false,
    };

    const replies = [
        formatVideoStatusPost(job),
        completedVideoPost(job),
        failedVideoPost(job),
    ];
    for (const reply of replies) {
        assert.ok(reply.length <= 1999);
        assert.match(reply, /^(?:\*\*)?MiniMax/);
        assert.match(reply, /\n> Maximum-length replied-message prompt\./);
        assert.ok(reply.endsWith('…'));
    }
});

test('failed video post is a standalone sanitized reply', () => {
    const text = failedVideoPost({
        id: '09cfe948-165f-43d6-80bf-1f66dd26ee98',
        model: 'minimaxfast',
        runtime_seconds: null,
        prompt: 'baboons at a zoo',
        error: 'Failed at D:\\AI\\private\\video.plan.json',
    });
    assert.match(text, /MiniMax FastH3 video \*\*09cfe948\*\* failed/);
    assert.match(text, /> baboons at a zoo/);
    assert.doesNotMatch(text, /D:\\|private|video\.plan/);
});

test('generic worker failures include the last reported pipeline stage', () => {
    const job = {
        id: 'e2b81b99-1f4f-42ae-9ac1-0a350f991aef',
        model: 'minimaxfast',
        runtime_seconds: null,
        prompt: 'A test video',
        error: 'Generator exited with code 1.',
        stage: 'First frame ready from gemini / gemini-3-pro-image',
        status: 'failed',
    };
    assert.match(
        failedVideoPost(job),
        /Generator exited with code 1\. Last reported stage: First frame ready from gemini \/ gemini-3-pro-image\./,
    );
    assert.match(formatVideoJob(job), /Last reported stage: First frame ready from gemini/);
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
    assert.equal(isVideoModel('ltxfast'), true);
    assert.equal(isVideoModel('minimaxfast'), true);
    assert.equal(isVideoModel('minimaxdraft'), false);
});

test('initial and offline queue messages always expose a clearly qualified rough ETA', () => {
    assert.match(initialVideoRequestStatus('minimax'), /Rough ETA: \*\*10m–30m\*\*/);
    assert.match(initialVideoRequestStatus('minimax'), /plus any work already queued/);
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
        dispatch_paused: false,
    });
    assert.match(text, /Queue position: \*\*2\*\*/);
    assert.match(text, /offline/);
    assert.match(text, /Rough render ETA: \*\*10s–20s\*\*/);
    assert.doesNotMatch(text, /Expected (start|finish)/);
});

test('global video queue identifies same-server requesters without exposing cross-server identities', () => {
    const queued = {
        id: '12345678-1234-1234-1234-123456789abc',
        model: 'minimax',
        prompt: 'Three racers approach a neon finish line.',
        requester_id: '483470443001413675',
        origin_bot_id: 'b',
        channel_id: 'c',
        guild_id: 'guild-a',
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
        dispatch_paused: false,
    };
    const formatted = formatGlobalVideoQueueJob(queued, 'guild-a');
    assert.match(formatted, /\*\*#2 · Queued\*\*/);
    assert.match(formatted, /ETA <t:2000000450:R>/);
    assert.doesNotMatch(formatted, /Rough ETA|Dispatch paused/);
    assert.doesNotMatch(formatted, /Expected start|estimate.*-/i);
    assert.doesNotMatch(formatted, /MiniMax H3|12345678/);
    assert.match(formatted, /<@483470443001413675>/);
    assert.match(formatted, /Three racers approach a neon finish line/);
    assert.equal(formatted.split('\n').length, 2);

    const embeds = globalVideoQueueEmbeds([queued], 'guild-a', 700);
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0].title, 'Video queue · 1 job');
    assert.equal(embeds[0].description, formatted);
    assert.equal(embeds[0].color, 0x5865F2);

    const dispatchPaused = formatGlobalVideoQueueJob({ ...queued, dispatch_paused: true }, 'guild-a');
    assert.match(dispatchPaused, /\*\*#2 · Queued\*\*/);
    assert.doesNotMatch(dispatchPaused, /Dispatch paused/);
    const pausedEmbeds = globalVideoQueueEmbeds([queued], 'guild-a', 700, false, true);
    assert.deepEqual(pausedEmbeds[0].footer, { text: 'Dispatch paused' });

    const fullPrompt = `A complete queue prompt ${'with every requested detail '.repeat(12)}`;
    const fullPromptChunks = globalVideoQueueChunks([{ ...queued, prompt: fullPrompt }], 'guild-a', 700);
    assert.equal(fullPromptChunks.length, 1);
    assert.match(fullPromptChunks[0], new RegExp(fullPrompt.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const crossServer = formatGlobalVideoQueueJob({
        ...queued,
        requester_id: '975310864209753108',
        guild_id: 'guild-b',
    }, 'guild-a');
    assert.match(crossServer, /requester hidden/);
    assert.doesNotMatch(crossServer, /975310864209753108/);
    const moderatorGlobalView = globalVideoQueueChunks([{
        ...queued,
        requester_id: '975310864209753108',
        guild_id: 'guild-b',
    }], 'guild-a', 700, true);
    assert.match(moderatorGlobalView[0], /<@975310864209753108>/);
    assert.doesNotMatch(moderatorGlobalView[0], /requester hidden/);

    const chunks = globalVideoQueueChunks(Array.from({ length: 12 }, (_, index) => ({
        ...queued,
        id: `${String(index).padStart(8, '0')}-1234-1234-1234-123456789abc`,
        prompt: `Server-wide queued prompt ${index} ${'x'.repeat(90)}`,
    })), 'guild-a', 700);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length <= 700));
    const oversized = globalVideoQueueChunks([{
        ...queued,
        prompt: `An oversized prompt ${'x'.repeat(2000)}`,
    }], 'guild-a', 700);
    assert.equal(oversized.length, 1);
    assert.ok(oversized[0].length <= 700);
    assert.match(oversized[0], /…$/);
    assert.deepEqual(globalVideoQueueChunks([], 'guild-a'), ['The server video queue is empty.']);
});

test('active video status shows only rough progress and one completion ETA', () => {
    const job = {
        id: '12345678-1234-1234-1234-123456789abc',
        model: 'minimaxfast',
        prompt: 'A concise test video.',
        requester_id: 'u',
        origin_bot_id: 'b',
        channel_id: 'c',
        guild_id: null,
        command_message_id: 'm',
        status_message_id: 's',
        status: 'running',
        queue_position: null,
        estimate_low_seconds: 120,
        estimate_high_seconds: 300,
        estimate_ready: true,
        expected_start_at: 2_000_000_000,
        expected_finish_at: 2_000_000_210,
        stage: 'Sampling [##########----------] 50.0% | ETA 2m-5m',
        progress: 0.426,
        progress_scope: 'job',
        segment_index: 4,
        segment_count: 9,
        segment_progress: 0.83,
        error: null,
        result_path: null,
        result_bytes: null,
        has_source_image: false,
        created_at: 1,
        updated_at: 1,
        started_at: 2,
        completed_at: null,
        runtime_seconds: null,
        delivered_at: null,
        worker_online: true,
        worker_busy: true,
        paused_until: null,
        dispatch_paused: false,
        gpu_queue_state: 'admitted',
        gpu_queue_submitted_at: 1_999_999_900,
        gpu_admitted_at: 2_000_000_000,
        gpu_queue_wait_seconds: 100,
    };
    const text = formatVideoJob(job);
    assert.match(text, /roughly 43% complete/);
    assert.match(text, /Segment \*\*4\/9\*\*/);
    assert.match(text, /Estimated completion/);
    assert.doesNotMatch(text, /Sampling|2m-5m|Expected start/);

    const waiting = formatVideoJob({
        ...job,
        status: 'leased',
        estimate_ready: false,
        expected_start_at: null,
        expected_finish_at: null,
        progress: null,
        gpu_queue_state: 'queued',
        gpu_admitted_at: null,
        gpu_queue_wait_seconds: null,
        gpu_queue_position: 3,
        gpu_queue_jobs_ahead: 2,
        gpu_estimated_admission_low_at: 2_000_000_120,
        gpu_estimated_admission_high_at: 2_000_000_240,
    });
    assert.match(waiting, /Waiting in the GPU queue/);
    assert.match(waiting, /GPU queue position: \*\*3\*\*/);
    assert.match(waiting, /\*\*2\*\* jobs ahead/);
    assert.match(waiting, /Rough render ETA: \*\*2m–5m\*\*/);
    assert.match(waiting, /includes the GPU work currently ahead/);
    assert.match(waiting, /higher-priority submissions or external GPU pressure/);
    assert.doesNotMatch(waiting, /Estimated completion <t:/);
});

test('drained queue messages retain a rough ETA and explain its assumption', () => {
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
        queue_position: 1,
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
        worker_online: true,
        worker_busy: true,
        paused_until: null,
        dispatch_paused: true,
    });
    assert.match(text, /Dispatch is temporarily paused/);
    assert.match(text, /Rough render ETA: \*\*10s–20s\*\*/);
    assert.match(text, /assumes dispatch resumes now/);
    assert.doesNotMatch(text, /Accepted and processing/);
});

test('frontier video planning uses Sol and a strict recursive screenplay schema', () => {
    assert.equal(VIDEO_PLANNER_MODEL, 'gpt-5.6-sol');
    assert.match(VIDEO_DURATION_DISCIPLINE_INSTRUCTIONS, /exactly one segment containing exactly one shot/);
    assert.match(VIDEO_DURATION_DISCIPLINE_INSTRUCTIONS, /5-7 seconds/);
    assert.match(VIDEO_DURATION_DISCIPLINE_INSTRUCTIONS, /Do not force an idea into that shape/);
    assert.match(VIDEO_DURATION_DISCIPLINE_INSTRUCTIONS, /multi-character discovery/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /exactly one segment containing exactly one shot/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /vehicle nose, visible road\/path ahead/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /positive-only diffusion prompt/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /do not put the franchise name/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /at most three identity-critical people/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /user-supplied start image/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /source image as the sole authority/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /generic wide-eyed, bulging-eyed, or toothy expression/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /preserve observed facial anatomy rather than a generic genre face/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /restat(?:e|ing) this concrete source identity in every shot after a cut/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Preserve information state across reveals/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /before that knowledge/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Every hard scene change/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /one independently generated clip/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Treat explicit speaking intent as authority to write speech/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /clean 0\.35-second visual lead-in/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /from 00:00\.000 until 00:00\.350/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Apply this lead-in consistently in shot\.visual and keyframe\.motion_contract\.first_second_action/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Use dialogue\.delivery only for vocal and performance qualities/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /dialogue turn can overrun its authored shot boundary/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /reserve a small overflow margin/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /do not take that margin from the following payoff/);
    assert.doesNotMatch(VIDEO_PLANNER_INSTRUCTIONS, /make it begin immediately/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /non-dialogue audio as a chronological production contract/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /physical source, material or timbre/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /segment\.music exactly to N\/A/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Budget action density for reliable generation/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /a spoken turn also consumes beat time/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /do not stack them in one authored shot/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /already-achieved aftermath\/reaction/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /explicit entry\/exit state across each cut/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /one decisive representative mini-story/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /trace the moving subject's leading edge/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /placing it on a new backing plate/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /do not swap identities and call that an exact reset/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /show their own material visibly bridge/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /never imply conservation by reversing already expelled material upstream/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /complete precomposed layer enclosed in straight English double quotes/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /let it land through a readable hold and silent physical reaction/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Copy its exact spine phrase into continuity and the shot directions/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /When mode=none, stage the request naturally/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /narrative_montage/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /narrative_adaptation/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /rigid_artifact/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Treat visible language as quoted source material/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Frame-zero immutability constrains only the instant/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /stationary subject is compatible with a motivated pull-back/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /first-person confession/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /Unquoted third-person narrative or scene prose is visual direction/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /does not ask a narrator to recite that sentence/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /add concise original in-world dialogue/);
    assert.match(VIDEO_PLANNER_INSTRUCTIONS, /memorable line, reaction, or brief exchange/);
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
    visit(VIDEO_SINGLE_PASS_SCHEMA);
    assert.match(VIDEO_SINGLE_PASS_INSTRUCTIONS, /binding contract/);
});

test('broker-side frontier validation rejects plans the desktop would reject before making a keyframe', () => {
    const plan = {
        intent: 'A speaker delivers one line.',
        continuity_bible: 'Same speaker and room.',
        keyframe: {
            recommended: true, reason: 'Identity anchor', prompt: 'Speaker facing camera.',
            motion_contract: {
                subject_orientation: 'front', gaze_direction: 'camera', travel_direction: 'stationary',
                camera_relation: 'eye level', first_second_action: 'begins speaking without moving',
            },
        },
        segments: [{
            transition: 'start', target_seconds: 5,
            shots: [{
                duration_seconds: 5, visual: 'Speaker talks.', camera: 'Medium close-up.',
                audio: 'The speaker says: hello world',
                dialogue: [{ speaker_id: 'S1', language: 'English', delivery: 'natural', text: 'hello world' }],
            }],
        }],
    };
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimaxfast'),
        /repeated dialogue in the non-speech audio field/,
    );
    plan.segments[0].shots[0].audio = 'Quiet room tone under the clear voice.';
    assert.doesNotThrow(() => validateFrontierVideoPlanForKeyframe(plan, 'minimaxfast'));
    plan.prompt_analysis = { dialogue_contract: { mode: 'none', lines: [] } };
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(
            plan,
            'minimaxfast',
            'And there she was, the captain herself leading the fleet into a better tomorrow.',
        ),
        /added dialogue.*found no speech/,
    );
    const creativeBrief = 'And there she was, the captain herself leading the fleet into a better tomorrow.';
    plan.prompt_analysis.dialogue_contract.mode = 'generated';
    plan.segments[0].shots[0].dialogue[0].text = creativeBrief;
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimaxfast', creativeBrief),
        /recited the visual creative brief as dialogue/,
    );
    plan.segments[0].shots[0].dialogue[0].text = 'Hold formation!';
    assert.doesNotThrow(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimaxfast', creativeBrief),
    );
});

test('frontier validation enforces an extracted finished-duration contract', () => {
    const plan = {
        intent: 'A fifteen-second drawing timelapse.',
        continuity_bible: 'The cursor continuously builds one character.',
        keyframe: {
            recommended: true, reason: 'Blank-canvas anchor', prompt: 'A blank drawing canvas.',
            motion_contract: {
                subject_orientation: 'Canvas faces viewer', gaze_direction: 'N/A', travel_direction: 'N/A',
                camera_relation: 'Screen recording', first_second_action: 'Cursor begins the rough sketch',
            },
        },
        segments: [{
            transition: 'start', target_seconds: 15, output_seconds: 15,
            shots: [{
                duration_seconds: 15, visual: 'A cursor completes the character in a fast timelapse.',
                camera: 'Stable screen recording.', audio: 'Pen strokes and interface clicks.', dialogue: [],
            }],
        }],
    };
    assert.doesNotThrow(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimax', '', 15),
    );
    plan.segments[0].output_seconds = 14;
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimax', '', 15),
        /explicit duration contract requires 15s exactly/,
    );
});

test('frontier dialogue staging makes every speaking shot visually explicit without a model call', () => {
    const plan = {
        segments: [{
            shots: [{
                visual: 'The worker takes a sip and faces the monitor.',
                dialogue: [{
                    speaker_id: 'office_worker',
                    language: 'English',
                    delivery: 'dry',
                    text: 'Okay, Monday. You get one cup.',
                }],
            }, {
                visual: 'Two racers cross the line.',
                dialogue: [
                    { speaker_id: 'red_racer', text: 'Not today!' },
                    { speaker_id: 'blue-racer', text: 'Next time.' },
                ],
            }],
        }],
    };
    assert.equal(stageFrontierDialogueVisually(plan), 2);
    assert.match(plan.segments[0].shots[0].visual, /office worker remains visible/);
    assert.match(plan.segments[0].shots[0].visual, /synchronized mouth movement/);
    assert.match(plan.segments[0].shots[1].visual, /red racer and blue racer/);
    assert.equal(stageFrontierDialogueVisually(plan), 0);
});

test('frontier visible-text staging normalizes exact words and validates the motion spine', () => {
    const analysis = frontierAnalysis();
    analysis.visible_text_contract = {
        mode: 'required_only',
        items: [{ text: 'NO VACANCY', role: 'sign', timing: 'held from 0-3 seconds' }],
    };
    analysis.motion_design_contract = {
        mode: 'visual_spine',
        spine: 'red neon border road',
        style_invariants: ['red neon line', 'no hard cut during the transformation'],
        transition_rules: ['the sign border extends into the desert road'],
    };
    const plan = frontierPlan();
    plan.prompt_analysis = analysis;
    plan.segments[0].shots[0].visual = 'A motel sign reads “NO VACANCY” above the road.';
    assert.equal(stageFrontierVisibleText(plan, analysis), 1);
    assert.match(plan.segments[0].shots[0].visual, /"NO VACANCY"/);
    assert.equal(stageFrontierVisibleText(plan, analysis), 0);
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimaxfast', 'A sign reads "NO VACANCY".'),
        /omitted the required visual motion spine/,
    );
    plan.continuity_bible += ' The red neon border road is the continuous transition device.';
    assert.doesNotThrow(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimaxfast', 'A sign reads "NO VACANCY".'),
    );
    plan.segments[0].shots[0].visual += ' A second label reads "OPEN".';
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimaxfast', 'A sign reads "NO VACANCY".'),
        /added unrequested visible text/,
    );
});

test('frontier keyframe geometry deterministically follows an unambiguous motion contract', () => {
    const plan = {
        keyframe: {
            prompt: 'A left-facing knight moves screen right while a dragon watches from screen left.',
            motion_contract: {
                subject_orientation: 'The knight is pointed screen right.',
            },
        },
    };
    assert.equal(reconcileFrontierKeyframeMotionGeometry(plan), 1);
    assert.match(plan.keyframe.prompt, /right-facing knight moves screen right/);
    assert.match(plan.keyframe.prompt, /dragon watches from screen left/);
    assert.equal(reconcileFrontierKeyframeMotionGeometry(plan), 0);

    const opposedCast = {
        keyframe: {
            prompt: 'One racer faces screen left and another faces screen right.',
            motion_contract: {
                subject_orientation: 'One racer faces screen left; another faces screen right.',
            },
        },
    };
    assert.equal(reconcileFrontierKeyframeMotionGeometry(opposedCast), 0);
});

function frontierAnalysis(dialogueMode = 'none') {
    return {
        request_form: dialogueMode === 'none' ? 'visual_direction' : 'conversation_topic',
        source_image_type: 'none',
        source_image_strategy: 'none',
        source_narrative_beats: [],
        presentation: 'cinematic live action',
        literalness: 'literal',
        tone: ['playful'],
        subjects: ['a dog'],
        actions: ['runs'],
        distinctive_details: [],
        inferred_staging: ['a park'],
        audio_requirements: ['park ambience'],
        dialogue_contract: { mode: dialogueMode, lines: [] },
        coverage_contract: {
            mode: 'representative',
            members: [],
            presentation: 'simultaneous',
            per_member_dialogue: false,
            per_member_label: false,
        },
        visible_text_contract: { mode: 'none', items: [] },
        motion_design_contract: {
            mode: 'none',
            spine: 'N/A',
            style_invariants: [],
            transition_rules: [],
        },
        prohibited_substitutions: [],
        resolved_intent: 'A dog runs through a park.',
        frontier_handling: {
            disposition: 'fulfill',
            reason_code: 'none',
            reason: 'N/A',
        },
    };
}

function frontierPlan(dialogue = []) {
    return {
        intent: 'A dog runs through a park.',
        continuity_bible: 'The same brown dog remains in the same sunny park.',
        keyframe: {
            recommended: true,
            reason: 'Keep the dog stable.',
            prompt: 'A brown dog poised to run through a sunny park.',
            reference_requirements: [],
            motion_contract: {
                subject_orientation: 'The dog faces screen right.',
                gaze_direction: 'The dog looks down the path.',
                travel_direction: 'The dog travels screen right.',
                camera_relation: 'Side profile at dog height.',
                first_second_action: 'The dog begins running screen right.',
            },
        },
        segments: [{
            title: 'Run', overlay_label: 'N/A', transition: 'start',
            target_seconds: 5, output_seconds: 5, music: 'N/A',
            shots: [{
                duration_seconds: 5,
                visual: dialogue.length ? 'A cat and dog visibly speak about cheese.' : 'The dog runs through the park.',
                camera: 'Side-profile tracking shot.',
                audio: 'Paws strike the path beneath quiet park ambience.',
                dialogue,
            }],
        }],
    };
}

function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

test('frontier planner retries incomplete structured output with a larger token budget', async () => {
    const requests = [];
    const replies = [
        { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierAnalysis()), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan()), model: VIDEO_PLANNER_MODEL },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return jsonResponse(replies.shift());
    };
    try {
        const result = await createFrontierVideoPlan(
            'A dog runs through a park.', 'minimaxfast', 'requester-1', undefined,
        );
        assert.equal(result.intent, 'A dog runs through a park.');
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(requests.length, 3);
    assert.equal(requests[0].max_output_tokens, 8000);
    assert.equal(requests[1].max_output_tokens, 16000);
    assert.equal(requests[2].max_output_tokens, 16000);
});

test('frontier planner applies experimental guidance to both passes and fingerprints it', async () => {
    const requests = [];
    const replies = [
        { status: 'completed', output_text: JSON.stringify(frontierAnalysis()), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan()), model: VIDEO_PLANNER_MODEL },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return jsonResponse(replies.shift());
    };
    try {
        const result = await createFrontierVideoPlan(
            'A dog runs through a park.', 'minimaxfast', 'requester-guidance', undefined,
            { plannerGuidance: 'Keep the dog visible.' },
        );
        assert.match(requests[0].input[0].content[0].text, /Keep the dog visible/);
        assert.match(requests[1].input[0].content[0].text, /Keep the dog visible/);
        assert.notEqual(result._planner_fingerprint, videoPlannerFingerprint());
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('single-pass frontier planner returns validated analysis and screenplay from one call', async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return jsonResponse({
            status: 'completed',
            output_text: JSON.stringify({
                prompt_analysis: frontierAnalysis(),
                plan: frontierPlan(),
            }),
            model: VIDEO_PLANNER_MODEL,
        });
    };
    try {
        const result = await createFrontierVideoPlan(
            'A dog runs through a park.',
            'minimaxfast',
            'requester-single-pass',
            undefined,
            { plannerStrategy: 'single-pass' },
        );
        assert.equal(requests.length, 1);
        assert.equal(requests[0].text.format.name, 'local_video_analysis_and_screenplay');
        assert.equal(requests[0].reasoning.effort, 'low');
        assert.equal('service_tier' in requests[0], false);
        assert.equal(result.planner_metrics.single_pass, true);
        assert.equal(result.planner_metrics.screenplay_attempts, 1);
        assert.deepEqual(result.prompt_analysis, frontierAnalysis());
        assert.notEqual(result._planner_fingerprint, videoPlannerFingerprint());
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('single-pass frontier planner streams a complete provisional keyframe before completion', async () => {
    const combined = {
        prompt_analysis: frontierAnalysis(),
        plan: frontierPlan(),
    };
    combined.plan.keyframe.prompt = 'A left-facing brown dog poised to run screen right.';
    const expectedKeyframe = structuredClone(combined.plan.keyframe);
    reconcileFrontierKeyframeMotionGeometry({ keyframe: expectedKeyframe });
    const outputText = JSON.stringify(combined);
    const requests = [];
    const provisionalValues = [];
    let streamController;
    let announceProvisional;
    const provisionalSeen = new Promise(resolve => { announceProvisional = resolve; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(init.body));
        const stream = new ReadableStream({
            start(controller) {
                streamController = controller;
                controller.enqueue(new TextEncoder().encode(
                    `event: response.output_text.delta\ndata: ${JSON.stringify({
                        type: 'response.output_text.delta',
                        delta: outputText,
                    })}\n\n`,
                ));
            },
        });
        return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });
    };
    try {
        const planning = createFrontierVideoPlan(
            'A dog runs through a park.',
            'minimaxfast',
            'requester-streaming-single-pass',
            undefined,
            {
                plannerStrategy: 'single-pass',
                onProvisionalKeyframe: value => {
                    provisionalValues.push(value);
                    announceProvisional();
                },
            },
        );
        await provisionalSeen;
        assert.equal(requests[0].stream, true);
        assert.equal(provisionalValues.length, 1);
        assert.deepEqual(provisionalValues[0].promptAnalysis, combined.prompt_analysis);
        assert.deepEqual(provisionalValues[0].keyframe, expectedKeyframe);
        streamController.enqueue(new TextEncoder().encode(
            `event: response.completed\ndata: ${JSON.stringify({
                type: 'response.completed',
                response: {
                    status: 'completed',
                    output_text: outputText,
                    model: VIDEO_PLANNER_MODEL,
                    service_tier: 'priority',
                    usage: {
                        input_tokens: 100,
                        output_tokens: 200,
                        input_tokens_details: { cached_tokens: 80 },
                    },
                },
            })}\n\n`,
        ));
        streamController.close();
        const result = await planning;
        assert.equal(result.planner_metrics.single_pass, true);
        assert.deepEqual(result.keyframe, expectedKeyframe);
    } finally {
        globalThis.fetch = originalFetch;
        try {
            streamController?.close?.();
        } catch {
            // The successful path already closed the synthetic stream.
        }
    }
});

test('invalid single-pass output falls back to the unchanged two-pass planner', async () => {
    const requests = [];
    const replies = [
        {
            status: 'completed',
            output_text: JSON.stringify({
                prompt_analysis: frontierAnalysis('generated'),
                plan: frontierPlan(),
            }),
            model: VIDEO_PLANNER_MODEL,
        },
        { status: 'completed', output_text: JSON.stringify(frontierAnalysis()), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan()), model: VIDEO_PLANNER_MODEL },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return jsonResponse(replies.shift());
    };
    try {
        const result = await createFrontierVideoPlan(
            'A dog runs through a park.',
            'minimaxfast',
            'requester-single-fallback',
            undefined,
            {
                plannerStrategy: 'single-pass',
                analysisReasoningEffort: 'medium',
                screenplayReasoningEffort: 'medium',
            },
        );
        assert.equal(requests.length, 3);
        assert.equal(requests[0].text.format.name, 'local_video_analysis_and_screenplay');
        assert.equal(requests[1].text.format.name, 'local_video_prompt_analysis');
        assert.equal(requests[2].text.format.name, 'local_video_screenplay');
        assert.equal(requests[0].reasoning.effort, 'medium');
        assert.equal(requests[1].reasoning.effort, 'high');
        assert.equal(requests[2].reasoning.effort, 'high');
        assert.ok(result.planner_metrics.single_pass_fallback_seconds >= 0);
        assert.equal(result.planner_metrics.single_pass, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('frontier planner repairs a complete screenplay that violates its dialogue contract', async () => {
    const requests = [];
    const spoken = [{
        speaker_id: 'dog', language: 'English', delivery: 'curious', text: 'Cheese is our future.',
    }];
    const replies = [
        { status: 'completed', output_text: JSON.stringify(frontierAnalysis('generated')), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan()), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan(spoken)), model: VIDEO_PLANNER_MODEL },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return jsonResponse(replies.shift());
    };
    try {
        const result = await createFrontierVideoPlan(
            'A cat and dog discuss cheese.', 'minimaxfast', 'requester-2', undefined,
        );
        assert.equal(result.planner_metrics.screenplay_attempts, 2);
        assert.equal(result.segments[0].shots[0].dialogue[0].text, 'Cheese is our future.');
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(requests.length, 3);
    assert.match(requests[2].input[1].content[0].text, /omitted dialogue required/);
});

test('frontier planner replaces creative-brief recitation with original scene dialogue', async () => {
    const requests = [];
    const analysis = frontierAnalysis('generated');
    analysis.request_form = 'visual_direction';
    analysis.resolved_intent = 'A captain leads her fleet into a better tomorrow.';
    const inventedNarration = [{
        speaker_id: 'narrator', language: 'English', delivery: 'dramatic',
        text: 'And there she was, the captain herself leading the fleet into a better tomorrow.',
    }];
    const originalDialogue = [{
        speaker_id: 'captain', language: 'English', delivery: 'commanding', text: 'Hold formation!',
    }];
    const replies = [
        { status: 'completed', output_text: JSON.stringify(analysis), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan(inventedNarration)), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan(originalDialogue)), model: VIDEO_PLANNER_MODEL },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return jsonResponse(replies.shift());
    };
    try {
        const result = await createFrontierVideoPlan(
            'And there she was, the captain herself leading the fleet into a better tomorrow.',
            'minimaxfast',
            'requester-visual-prose',
            undefined,
        );
        assert.equal(result.planner_metrics.screenplay_attempts, 2);
        assert.equal(result.segments[0].shots[0].dialogue[0].text, 'Hold formation!');
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(requests.length, 3);
    assert.match(requests[2].input[1].content[0].text, /recited the visual creative brief as dialogue/);
});

test('frontier planner compiles the second invalid completed screenplay instead of failing', async () => {
    const replies = [
        { status: 'completed', output_text: JSON.stringify(frontierAnalysis('generated')), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan()), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan()), model: VIDEO_PLANNER_MODEL },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse(replies.shift());
    try {
        const result = await createFrontierVideoPlan(
            'A cat and dog discuss cheese.', 'minimaxfast', 'requester-best-effort', undefined,
        );
        assert.equal(result.planner_metrics.screenplay_attempts, 2);
        assert.equal(result.planner_metrics.best_effort_compiled, true);
        assert.match(result.generation_notice, /rendered best-effort/);
        assert.ok(result.segments[0].shots[0].dialogue[0].text);
        assert.doesNotThrow(
            () => validateFrontierVideoPlanForKeyframe(
                result, 'minimaxfast', 'A cat and dog discuss cheese.',
            ),
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('frontier analysis can explicitly route a rejected request to local planning', async () => {
    const analysis = frontierAnalysis();
    analysis.frontier_handling = {
        disposition: 'reject',
        reason_code: 'provider_policy',
        reason: 'This frontier path cannot preserve the request faithfully.',
    };
    const replies = [
        { status: 'completed', output_text: JSON.stringify(analysis), model: VIDEO_PLANNER_MODEL },
    ];
    const attempts = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse(replies.shift());
    try {
        await assert.rejects(
            () => createFrontierVideoPlan(
                'A request routed locally.', 'minimaxfast', 'requester-rejected', undefined,
                { onAttempt: attempt => attempts.push(attempt) },
            ),
            error => error instanceof FrontierPlannerRejectedError
                && error.reasonCode === 'provider_policy',
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(replies.length, 0);
    assert.ok(attempts.some(attempt =>
        attempt.stage === 'prompt_analysis_decision' && attempt.outcome === 'rejected'));
});

test('two protected-dialogue fidelity failures route local instead of compiling counter-speech', async () => {
    const analysis = frontierAnalysis('verbatim');
    analysis.request_form = 'verbatim_utterance';
    analysis.dialogue_contract.lines = [{
        speaker_hint: 'speaker', text: 'Hello there.', verbatim: true,
    }];
    const counterSpeech = [{
        speaker_id: 'speaker', language: 'English', delivery: 'firm', text: 'I will say something else.',
    }];
    const replies = [
        { status: 'completed', output_text: JSON.stringify(analysis), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan(counterSpeech)), model: VIDEO_PLANNER_MODEL },
        { status: 'completed', output_text: JSON.stringify(frontierPlan(counterSpeech)), model: VIDEO_PLANNER_MODEL },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse(replies.shift());
    try {
        await assert.rejects(
            () => createFrontierVideoPlan(
                'Say exactly: Hello there.', 'minimaxfast', 'requester-counter-speech', undefined,
            ),
            error => error instanceof FrontierPlannerRejectedError
                && error.reasonCode === 'cannot_faithfully_fulfill',
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('best-effort compiler truncates automatic screenplays to two minutes', () => {
    const plan = frontierPlan();
    plan.segments = Array.from({ length: 8 }, (_, index) => ({
        ...structuredClone(plan.segments[0]),
        title: `Beat ${index + 1}`,
        transition: index === 0 ? 'start' : 'cut',
        target_seconds: 20,
        shots: [{ ...structuredClone(plan.segments[0].shots[0]), duration_seconds: 20 }],
    }));
    const compiled = compileBestEffortFrontierVideoPlan(
        plan,
        frontierAnalysis(),
        'A dog runs through three stages.',
        'ltxfast',
    );
    assert.equal(compiled.segments.reduce((sum, segment) => sum + segment.target_seconds, 0), 120);
    assert.equal(compiled.segments.length, 6);
    assert.match(compiled.generation_notice, /120-second generation budget.*truncated/);
    assert.doesNotThrow(
        () => validateFrontierVideoPlanForKeyframe(
            compiled, 'ltxfast', 'A dog runs through three stages.',
        ),
    );
});

test('exhaustive sequential coverage rejects rosters that exceed the generated-footage cap', () => {
    const analysis = frontierAnalysis('verbatim');
    analysis.presentation = 'video game character selection screen';
    analysis.dialogue_contract.lines = [{
        speaker_hint: 'each roster member', text: 'Present.', verbatim: true,
    }];
    analysis.coverage_contract = {
        mode: 'exhaustive',
        members: [...UNIQUE_US_PRESIDENTS],
        presentation: 'sequential',
        per_member_dialogue: true,
        per_member_label: true,
    };
    const plan = frontierPlan([{
        speaker_id: 'each roster member',
        language: 'English',
        delivery: 'clear',
        text: 'Present.',
    }]);
    assert.throws(
        () => expandExhaustiveSequentialPlan(plan, analysis, 'minimax'),
        /needs at least 225s of generated footage.*120s generation limit/,
    );
});

test('frontier validation rejects any screenplay above the generated-footage cap', () => {
    const plan = frontierPlan();
    plan.segments = Array.from({ length: 25 }, (_, index) => ({
        ...structuredClone(plan.segments[0]),
        title: `Generated beat ${index + 1}`,
        transition: index === 0 ? 'start' : 'cut',
        target_seconds: 5,
        shots: [{ ...structuredClone(plan.segments[0].shots[0]), duration_seconds: 5 }],
    }));
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimax'),
        /125\.0s of generated footage.*120s generation limit/,
    );
});

test('broker rejects a representative screenplay for an explicit every-president request', () => {
    const plan = frontierPlan([{
        speaker_id: 'presidents', language: 'English', delivery: 'clear', text: 'Present.',
    }]);
    plan.semantic_analysis = {
        coverage_contract: {
            mode: 'representative',
            members: [],
            presentation: 'simultaneous',
            per_member_dialogue: false,
            per_member_label: false,
        },
    };
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(
            plan,
            'minimax',
            'Every president says "Present" in a character selection screen.',
        ),
        /did not preserve the explicit every-president roster/,
    );
});

test('exhaustive sequential coverage rejects silent roster omission', () => {
    const analysis = frontierAnalysis('verbatim');
    analysis.dialogue_contract.lines = [{
        speaker_hint: 'each roster member', text: 'Present.', verbatim: true,
    }];
    analysis.coverage_contract = {
        mode: 'exhaustive',
        members: ['First Member', 'Second Member', 'Third Member'],
        presentation: 'sequential',
        per_member_dialogue: true,
        per_member_label: true,
    };
    const plan = frontierPlan([{
        speaker_id: 'each roster member', language: 'English', delivery: 'clear', text: 'Present.',
    }]);
    expandExhaustiveSequentialPlan(plan, analysis, 'minimax');
    plan.prompt_analysis = analysis;
    plan.segments.pop();
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimax'),
        /missing: Third Member|expected 3 labeled member segments/,
    );
});

test('best-effort compiler preserves required visible text and the visual motion spine', () => {
    const analysis = frontierAnalysis();
    analysis.visible_text_contract = {
        mode: 'required',
        items: [{ text: 'NIGHT OWL', role: 'wordmark', timing: 'final hold' }],
    };
    analysis.motion_design_contract = {
        mode: 'visual_spine',
        spine: 'crescent-shaped steam trail',
        style_invariants: ['cream vapor on indigo'],
        transition_rules: ['steam carries the scene transition'],
    };
    const compiled = compileBestEffortFrontierVideoPlan(
        frontierPlan(),
        analysis,
        'A brand film for "NIGHT OWL" using a crescent-shaped steam trail.',
        'minimaxfast',
        'missing audiovisual contracts',
    );
    assert.match(compiled.segments[0].shots[0].visual, /"NIGHT OWL"/);
    assert.match(compiled.continuity_bible, /crescent-shaped steam trail/);
    assert.doesNotThrow(() => validateFrontierVideoPlanForKeyframe(
        compiled,
        'minimaxfast',
        'A brand film for "NIGHT OWL" using a crescent-shaped steam trail.',
    ));
});

test('broker validation catches long H3 dialogue and literal omissions before desktop dispatch', () => {
    const plan = frontierPlan([{
        speaker_id: 'dog', language: 'English', delivery: 'fast',
        text: Array.from({ length: 50 }, (_, index) => `word${index}`).join(' '),
    }]);
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(plan, 'minimaxfast'),
        /needs .* dialogue, above the 15s model limit/,
    );
    const literalPlan = frontierPlan();
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(literalPlan, 'minimaxfast', 'Show 623996725509750785 saying "hello".'),
        /omitted quoted wording/,
    );
});

test('broker validation requires one short verbatim H3 line in the first shot', () => {
    const analysis = frontierAnalysis('verbatim');
    analysis.dialogue_contract.lines = [{
        speaker_hint: 'racer',
        text: 'Not today!',
        verbatim: true,
    }];
    const plan = frontierPlan([]);
    plan.prompt_analysis = analysis;
    plan.segments[0].shots.push({
        duration_seconds: 2,
        visual: 'The racer glances at a rival and speaks.',
        camera: 'Cockpit close-up.',
        audio: 'Low engine hum.',
        dialogue: [{
            speaker_id: 'racer',
            language: 'English',
            delivery: 'defiant',
            text: 'Not today!',
        }],
    });
    assert.throws(
        () => validateFrontierVideoPlanForKeyframe(
            plan,
            'minimax',
            'A racer says "Not today!"',
        ),
        /move it to the beginning/,
    );
    assert.doesNotThrow(() => validateFrontierVideoPlanForKeyframe(
        plan,
        'minimax',
        'After crossing the finish line, a racer says "Not today!"',
    ));
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
    assert.equal(videoJobDirection({
        prompt: 'Context from the replied message:\nOld context.\n\nCurrent instruction (takes priority):\nMake the dog run.',
        planned_intent: null,
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
    assert.deepEqual(VIDEO_PROMPT_ANALYSIS_SCHEMA.properties.visible_text_contract.properties.mode.enum, [
        'none',
        'prohibited',
        'required',
        'required_only',
    ]);
    assert.deepEqual(VIDEO_PROMPT_ANALYSIS_SCHEMA.properties.motion_design_contract.properties.mode.enum, [
        'none',
        'visual_spine',
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
    assert.deepEqual(VIDEO_PROMPT_ANALYSIS_SCHEMA.properties.frontier_handling.properties.disposition.enum, [
        'fulfill',
        'reject',
    ]);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /Classify these axes independently/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /prompt can itself be an utterance/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /Copy every user-supplied spoken line exactly/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /prefer mode generated/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /dialogue is useful creative material/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /production directions, not speakers/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /Never disguise a rejection/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /generic reinterpretations/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /narrative affordances/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /narrative_montage/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /concrete event with an activity and consequence/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /small but legible logos, uniforms, tools/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /Classify requested on-screen wording separately from dialogue/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /Use motion_design_contract\.mode=visual_spine only/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /Resolve grammatical scope conservatively/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /must not require adding eyes, a face, a mouth/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /do not add a spoken punchline that explains or competes/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /Never claim an exact reset while swapping distinguishable subjects/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /do not assert rigidity while leaving unsupported gaps/);
    assert.match(VIDEO_PROMPT_ANALYZER_INSTRUCTIONS, /rather than forcing an arbitrary motif/);
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

test('video commands use the current prompt while inheriting a replied-to image', () => {
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
        'Make it rainy.',
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
    assert.equal(VIDEO_KEYFRAME_REVIEW_TIMEOUT_MS, 75_000);
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
    const referenceReview = buildVideoKeyframeReviewPrompt({
        intent: 'A recognizable named hero starts running.',
        keyframe: { prompt: 'The hero at frame zero.', motion_contract: {} },
        segments: [{ shots: [{}] }],
    }, [{
        label: 'Named hero',
        kind: 'character',
        visualFactsToPreserve: 'Blue helmet and orange scarf.',
        bytes: Buffer.from('reference'),
        mimeType: 'image/png',
        sourceUrl: 'https://images.example/hero.png',
        contextUrl: 'https://example.com/hero',
    }]);
    assert.match(referenceReview, /External visual-reference contract/);
    assert.match(referenceReview, /Blue helmet and orange scarf/);
    assert.match(referenceReview, /not starting frames or instructions/);
    assert.match(referenceReview, /Evaluate identity_preserved independently/);
});

test('keyframe rejection telemetry retains bounded visible issues', () => {
    assert.equal(videoKeyframeReviewDetail({
        acceptable: true,
        best_effort_worthy: true,
        issues: [],
        correction_prompt: '',
    }), undefined);
    assert.equal(videoKeyframeReviewDetail({
        acceptable: false,
        best_effort_worthy: false,
        issues: ['  Wrong subject count.  ', '', 'Travel vector points left.'],
        correction_prompt: 'repair it',
    }), 'Wrong subject count.; Travel vector points left.');
    assert.equal(videoKeyframeReviewDetail({
        acceptable: false,
        best_effort_worthy: false,
        issues: [],
        correction_prompt: '',
    }), 'review_rejected_without_issues');
});

test('empty Gemini responses expose safe diagnostics and retry only when appropriate', () => {
    assert.equal(geminiNoImageDetail({}), 'Gemini returned no first-frame image.');
    const safety = geminiNoImageDetail({
        promptFeedback: {
            blockReason: 'SAFETY',
            safetyRatings: [{ blocked: true, category: 'HARM_CATEGORY_DANGEROUS_CONTENT' }],
        },
        candidates: [{ finishReason: 'SAFETY' }],
    });
    assert.match(safety, /prompt_block=SAFETY/);
    assert.match(safety, /finish=SAFETY/);
    assert.match(safety, /blocked=HARM_CATEGORY_DANGEROUS_CONTENT/);
    assert.equal(isRetryableVideoKeyframeGenerationFailure(
        new Error('Gemini returned no first-frame image.'),
    ), true);
    assert.equal(isRetryableVideoKeyframeGenerationFailure(new Error(safety)), false);
    assert.equal(isRetryableVideoKeyframeGenerationFailure(
        new Error('Gemini returned no first-frame image. prompt_block=PROHIBITED_CONTENT'),
    ), false);
    assert.equal(isRetryableVideoKeyframeGenerationFailure(
        new Error('Gemini returned no first-frame image. finish=BLOCKLIST'),
    ), false);
    assert.equal(isRetryableVideoKeyframeGenerationFailure(
        new Error('Gemini returned no first-frame image. finish=NO_IMAGE'),
    ), true);
    assert.equal(isRetryableVideoKeyframeGenerationFailure(
        new Error('Gemini returned unsupported image type image/tiff.'),
    ), false);
});

test('serial keyframes retry generic Gemini no-image responses then use reviewed GPT fallback', async t => {
    const urls = [];
    const attempts = [];
    t.mock.method(console, 'warn', () => {});
    t.mock.method(globalThis, 'fetch', async input => {
        const url = String(input);
        urls.push(url);
        if (url.includes('generativelanguage.googleapis.com')) {
            return new Response(JSON.stringify({
                candidates: [{ finishReason: 'NO_IMAGE' }],
                usageMetadata: { promptTokenCount: 10 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/v1/images/generations')) {
            return new Response(JSON.stringify({
                model: VIDEO_KEYFRAME_FALLBACK_MODEL,
                data: [{ b64_json: Buffer.from('generated-image').toString('base64') }],
                usage: { input_tokens: 10, output_tokens: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/v1/responses')) {
            return new Response(JSON.stringify({
                model: VIDEO_KEYFRAME_REVIEW_MODEL,
                service_tier: 'priority',
                output_text: JSON.stringify({
                    acceptable: true,
                    best_effort_worthy: true,
                    issues: [],
                    correction_prompt: '',
                }),
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    input_tokens_details: { cached_tokens: 0 },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected provider request: ${url}`);
    });

    const result = await createFrontierVideoKeyframe({
        intent: 'A dog begins running.',
        keyframe: { prompt: 'A dog at frame zero.', motion_contract: {} },
        segments: [{ shots: [{ visual: 'The dog runs.', camera: 'Wide tracking shot.' }] }],
    }, [], {
        strategy: 'serial-v1',
        serviceTier: 'fast',
        onAttempt: attempt => attempts.push(attempt),
    });

    assert.equal(result.provider, 'openai');
    assert.equal(result.reviewStatus, 'accepted');
    assert.equal(urls.filter(url => url.includes('generativelanguage.googleapis.com')).length, 2);
    assert.deepEqual(attempts.map(attempt => [
        attempt.stage,
        attempt.attempt,
        attempt.outcome,
        attempt.detail,
    ]), [
        ['keyframe_candidate_gemini', 1, 'error', 'Gemini returned no first-frame image. finish=NO_IMAGE'],
        ['keyframe_candidate_gemini', 2, 'error', 'Gemini returned no first-frame image. finish=NO_IMAGE'],
        ['keyframe_candidate_openai', 1, 'success', undefined],
        ['keyframe_review', 1, 'accepted', undefined],
    ]);
});

test('fast-gated keyframes review and reuse a prefetched candidate without regenerating it', async t => {
    let providerCalls = 0;
    t.mock.method(globalThis, 'fetch', async input => {
        const url = String(input);
        if (!url.endsWith('/v1/responses')) {
            providerCalls += 1;
            throw new Error(`Unexpected image generation request: ${url}`);
        }
        return new Response(JSON.stringify({
            model: VIDEO_KEYFRAME_REVIEW_MODEL,
            service_tier: 'priority',
            output_text: JSON.stringify({
                acceptable: true,
                best_effort_worthy: true,
                issues: [],
                correction_prompt: '',
            }),
            usage: {
                input_tokens: 10,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 0 },
            },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const prefetched = {
        bytes: Buffer.from('prefetched-fast-frame'),
        mimeType: 'image/png',
        provider: 'gemini',
        model: VIDEO_KEYFRAME_FAST_LITE_MODEL,
    };
    const result = await createFrontierVideoKeyframe({
        intent: 'A dog begins running.',
        keyframe: { prompt: 'A dog at frame zero.', motion_contract: {} },
        segments: [{ shots: [{ visual: 'The dog runs.', camera: 'Wide tracking shot.' }] }],
    }, [], {
        strategy: 'fast-gated-v3',
        serviceTier: 'fast',
        initialCandidate: Promise.resolve(prefetched),
    });

    assert.equal(providerCalls, 0);
    assert.deepEqual(result.bytes, prefetched.bytes);
    assert.equal(result.model, VIDEO_KEYFRAME_FAST_LITE_MODEL);
    assert.equal(result.reviewStatus, 'accepted');
});

test('reviewed best-effort keyframes stop before repair and baseline generation', async t => {
    let reviewCalls = 0;
    let generationCalls = 0;
    t.mock.method(globalThis, 'fetch', async input => {
        const url = String(input);
        if (!url.endsWith('/v1/responses')) {
            generationCalls += 1;
            throw new Error(`Unexpected image generation request: ${url}`);
        }
        reviewCalls += 1;
        return new Response(JSON.stringify({
            model: VIDEO_KEYFRAME_REVIEW_MODEL,
            service_tier: 'priority',
            output_text: JSON.stringify({
                acceptable: false,
                best_effort_worthy: true,
                issues: ['One incidental background prop is missing.'],
                correction_prompt: 'Show one additional background prop.',
            }),
            usage: {
                input_tokens: 10,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 0 },
            },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const candidate = {
        bytes: Buffer.from('minor-reviewed-frame'),
        mimeType: 'image/png',
        provider: 'gemini',
        model: VIDEO_KEYFRAME_FAST_LITE_MODEL,
    };
    const result = await createFrontierVideoKeyframe({
        intent: 'A coherent opening scene with one incidental prop mismatch.',
        keyframe: { prompt: 'A coherent opening frame.', motion_contract: {} },
        segments: [{ shots: [{ visual: 'The action begins.', camera: 'Wide shot.' }] }],
    }, [], {
        strategy: 'fast-gated-v3',
        serviceTier: 'fast',
        initialCandidate: Promise.resolve(candidate),
    });

    assert.equal(result.reviewStatus, 'best_effort');
    assert.deepEqual(result.bytes, candidate.bytes);
    assert.equal(reviewCalls, 1);
    assert.equal(generationCalls, 0);
});

test('exhausted keyframe repairs retain a supplied identity instead of falling back to T2V', async t => {
    let generationCalls = 0;
    let reviewCalls = 0;
    t.mock.method(globalThis, 'fetch', async input => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com')) {
            generationCalls += 1;
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{
                    inlineData: {
                        mimeType: 'image/png',
                        data: Buffer.from(`gemini-${generationCalls}`).toString('base64'),
                    },
                }] } }],
                usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/v1/images/edits')) {
            generationCalls += 1;
            return new Response(JSON.stringify({
                model: VIDEO_KEYFRAME_FALLBACK_MODEL,
                data: [{ b64_json: Buffer.from('identity-safe-final').toString('base64') }],
                usage: { input_tokens: 10, output_tokens: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/v1/responses')) {
            reviewCalls += 1;
            return new Response(JSON.stringify({
                model: VIDEO_KEYFRAME_REVIEW_MODEL,
                service_tier: 'priority',
                output_text: JSON.stringify({
                    acceptable: false,
                    best_effort_worthy: false,
                    identity_preserved: true,
                    issues: ['The cast faces away from the required travel path.'],
                    correction_prompt: 'Align the cast with the forward travel path.',
                }),
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    input_tokens_details: { cached_tokens: 0 },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected provider request: ${url}`);
    });

    const result = await createFrontierVideoKeyframe({
        intent: 'The recurring hero leads a party toward a fortress.',
        keyframe: { prompt: 'The same hero at frame zero.', motion_contract: {} },
        segments: [{ shots: [{ visual: 'The party advances.', camera: 'Wide shot.' }] }],
    }, [{
        label: 'Recurring cast identity from frame zero',
        kind: 'identity',
        visualFactsToPreserve: 'Preserve the recognizable recurring hero.',
        bytes: Buffer.from('source-identity'),
        mimeType: 'image/png',
        sourceUrl: 'user-attachment',
        contextUrl: 'user-attachment',
    }], {
        strategy: 'serial-v1',
        serviceTier: 'fast',
    });

    assert.equal(generationCalls, 3);
    assert.equal(reviewCalls, 3);
    assert.equal(result.provider, 'openai');
    assert.equal(result.bytes.toString(), 'identity-safe-final');
    assert.equal(result.reviewStatus, 'best_effort');
});

test('keyframe review timeout retries the quality gate before accepting a candidate', async t => {
    const attempts = [];
    let reviewCalls = 0;
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com')) {
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{
                    inlineData: {
                        mimeType: 'image/png',
                        data: Buffer.from('reviewed-after-timeout').toString('base64'),
                    },
                }] } }],
                usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/v1/responses')) {
            reviewCalls += 1;
            if (reviewCalls === 1) {
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => {
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                    }, { once: true });
                });
            }
            return new Response(JSON.stringify({
                model: VIDEO_KEYFRAME_REVIEW_MODEL,
                service_tier: 'priority',
                output_text: JSON.stringify({
                    acceptable: true,
                    best_effort_worthy: true,
                    issues: [],
                    correction_prompt: '',
                }),
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    input_tokens_details: { cached_tokens: 0 },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected provider request: ${url}`);
    });

    const result = await createFrontierVideoKeyframe({
        intent: 'A dog begins running.',
        keyframe: { prompt: 'A dog at frame zero.', motion_contract: {} },
        segments: [{ shots: [{ visual: 'The dog runs.', camera: 'Wide tracking shot.' }] }],
    }, [], {
        strategy: 'serial-v1',
        serviceTier: 'fast',
        reviewTimeoutMs: 10,
        onAttempt: attempt => attempts.push(attempt),
    });

    assert.equal(result.reviewStatus, 'accepted');
    assert.equal(reviewCalls, 2);
    assert.deepEqual(attempts.map(attempt => [
        attempt.stage,
        attempt.attempt,
        attempt.outcome,
        attempt.detail,
    ]), [
        ['keyframe_candidate_gemini', 1, 'success', undefined],
        ['keyframe_review', 1, 'error', 'First-frame visual review timed out.'],
        ['keyframe_review', 2, 'accepted', undefined],
    ]);
});

test('fast keyframes retry one reviewed Flash Lite correction before the baseline pipeline', async t => {
    const attempts = [];
    const geminiBodies = [];
    let geminiCalls = 0;
    let reviewCalls = 0;
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com')) {
            geminiCalls += 1;
            geminiBodies.push(String(init?.body || ''));
            return new Response(JSON.stringify({
                candidates: [{
                    content: { parts: [{
                        inlineData: {
                            mimeType: 'image/png',
                            data: Buffer.from(`flash-lite-${geminiCalls}`).toString('base64'),
                        },
                    }] },
                }],
                usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/v1/responses')) {
            reviewCalls += 1;
            const acceptable = reviewCalls === 2;
            return new Response(JSON.stringify({
                model: VIDEO_KEYFRAME_REVIEW_MODEL,
                service_tier: 'priority',
                output_text: JSON.stringify({
                    acceptable,
                    best_effort_worthy: acceptable,
                    issues: acceptable ? [] : ['The podium path has no usable ramp.'],
                    correction_prompt: acceptable
                        ? ''
                        : 'Show a shallow ramp directly ahead of the right-facing duck.',
                }),
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    input_tokens_details: { cached_tokens: 0 },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected provider request: ${url}`);
    });

    const result = await createFrontierVideoKeyframe({
        intent: 'A duck walks up to a podium.',
        keyframe: { prompt: 'A right-facing duck on a path.', motion_contract: {} },
        segments: [{ shots: [{ visual: 'The duck walks up a ramp.', camera: 'Wide tracking shot.' }] }],
    }, [], {
        strategy: 'fast-gated-v3',
        serviceTier: 'fast',
        onAttempt: attempt => attempts.push(attempt),
    });

    assert.equal(result.provider, 'gemini');
    assert.equal(result.model, VIDEO_KEYFRAME_FAST_LITE_MODEL);
    assert.equal(result.bytes.toString(), 'flash-lite-2');
    assert.equal(result.reviewStatus, 'accepted');
    assert.equal(geminiCalls, 2);
    assert.equal(reviewCalls, 2);
    assert.match(geminiBodies[1], /shallow ramp directly ahead/);
    assert.deepEqual(attempts.map(attempt => [
        attempt.stage,
        attempt.attempt,
        attempt.outcome,
    ]), [
        ['keyframe_candidate_gemini', 1, 'success'],
        ['keyframe_review', 1, 'rejected'],
        ['keyframe_candidate_gemini', 3, 'success'],
        ['keyframe_review', 2, 'accepted'],
    ]);
});

test('rejected fast correction preserves the reviewed full-quality fallback', async t => {
    const attempts = [];
    let geminiCalls = 0;
    let reviewCalls = 0;
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'fetch', async input => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com')) {
            geminiCalls += 1;
            return new Response(JSON.stringify({
                candidates: [{
                    content: { parts: [{
                        inlineData: {
                            mimeType: 'image/png',
                            data: Buffer.from(`candidate-${geminiCalls}`).toString('base64'),
                        },
                    }] },
                }],
                usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/v1/responses')) {
            reviewCalls += 1;
            const acceptable = reviewCalls === 3;
            return new Response(JSON.stringify({
                model: VIDEO_KEYFRAME_REVIEW_MODEL,
                service_tier: 'priority',
                output_text: JSON.stringify({
                    acceptable,
                    best_effort_worthy: acceptable,
                    issues: acceptable ? [] : ['The frame still contradicts the motion contract.'],
                    correction_prompt: acceptable ? '' : 'Show all subjects aligned with the forward path.',
                }),
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    input_tokens_details: { cached_tokens: 0 },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected provider request: ${url}`);
    });

    const result = await createFrontierVideoKeyframe({
        intent: 'Three racers accelerate forward.',
        keyframe: { prompt: 'Exactly three racers at frame zero.', motion_contract: {} },
        segments: [{ shots: [{ visual: 'They accelerate.', camera: 'Rear tracking shot.' }] }],
    }, [], {
        strategy: 'fast-gated-v3',
        serviceTier: 'fast',
        onAttempt: attempt => attempts.push(attempt),
    });

    assert.equal(result.model, VIDEO_KEYFRAME_MODEL);
    assert.equal(result.bytes.toString(), 'candidate-3');
    assert.equal(result.reviewStatus, 'accepted');
    assert.equal(geminiCalls, 3);
    assert.equal(reviewCalls, 3);
    assert.deepEqual(
        attempts.filter(attempt => attempt.stage === 'keyframe_candidate_gemini')
            .map(attempt => [attempt.model, attempt.attempt]),
        [
            [VIDEO_KEYFRAME_FAST_LITE_MODEL, 1],
            [VIDEO_KEYFRAME_FAST_LITE_MODEL, 3],
            [VIDEO_KEYFRAME_MODEL, 1],
        ],
    );
});

test('slow rejected fast review overlaps the unchanged full-quality candidate', async t => {
    const events = [];
    let fastCalls = 0;
    let reviewCalls = 0;
    let releaseSecondReview;
    const reviewResponse = acceptable => new Response(JSON.stringify({
        model: VIDEO_KEYFRAME_REVIEW_MODEL,
        service_tier: 'priority',
        output_text: JSON.stringify({
            acceptable,
            best_effort_worthy: acceptable,
            issues: acceptable ? [] : ['The frame contradicts the motion contract.'],
            correction_prompt: acceptable ? '' : 'Align every racer with the forward path.',
        }),
        usage: {
            input_tokens: 10,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
        },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'fetch', async input => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com')) {
            if (url.includes(VIDEO_KEYFRAME_MODEL)) {
                events.push('full-quality-started');
                releaseSecondReview();
                return new Response(JSON.stringify({
                    candidates: [{ content: { parts: [{
                        inlineData: {
                            mimeType: 'image/png',
                            data: Buffer.from('full-quality').toString('base64'),
                        },
                    }] } }],
                    usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 1 },
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            fastCalls += 1;
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{
                    inlineData: {
                        mimeType: 'image/png',
                        data: Buffer.from(`fast-${fastCalls}`).toString('base64'),
                    },
                }] } }],
                usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/v1/responses')) {
            reviewCalls += 1;
            if (reviewCalls === 2) {
                events.push('second-review-started');
                return new Promise(resolve => {
                    releaseSecondReview = () => {
                        events.push('second-review-rejected');
                        resolve(reviewResponse(false));
                    };
                });
            }
            return reviewResponse(reviewCalls === 3);
        }
        throw new Error(`Unexpected provider request: ${url}`);
    });

    const result = await createFrontierVideoKeyframe({
        intent: 'Three racers accelerate forward.',
        keyframe: { prompt: 'Exactly three racers at frame zero.', motion_contract: {} },
        segments: [{ shots: [{ visual: 'They accelerate.', camera: 'Rear tracking shot.' }] }],
    }, [], {
        strategy: 'fast-gated-v3',
        serviceTier: 'fast',
        fastGateHedgeDelayMs: 0,
    });

    assert.equal(result.model, VIDEO_KEYFRAME_MODEL);
    assert.equal(result.bytes.toString(), 'full-quality');
    assert.deepEqual(events, [
        'second-review-started',
        'full-quality-started',
        'second-review-rejected',
    ]);
    assert.equal(reviewCalls, 3);
});

test('accepted corrected fast review aborts its delayed full-quality hedge', async t => {
    const attempts = [];
    let fastCalls = 0;
    let reviewCalls = 0;
    let releaseSecondReview;
    const reviewResponse = acceptable => new Response(JSON.stringify({
        model: VIDEO_KEYFRAME_REVIEW_MODEL,
        service_tier: 'priority',
        output_text: JSON.stringify({
            acceptable,
            best_effort_worthy: acceptable,
            issues: acceptable ? [] : ['The path is blocked.'],
            correction_prompt: acceptable ? '' : 'Show a clear forward path.',
        }),
        usage: {
            input_tokens: 10,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
        },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com')) {
            if (url.includes(VIDEO_KEYFRAME_MODEL)) {
                releaseSecondReview();
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => {
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                    }, { once: true });
                });
            }
            fastCalls += 1;
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{
                    inlineData: {
                        mimeType: 'image/png',
                        data: Buffer.from(`fast-${fastCalls}`).toString('base64'),
                    },
                }] } }],
                usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 1 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/v1/responses')) {
            reviewCalls += 1;
            if (reviewCalls === 2) {
                return new Promise(resolve => {
                    releaseSecondReview = () => resolve(reviewResponse(true));
                });
            }
            return reviewResponse(false);
        }
        throw new Error(`Unexpected provider request: ${url}`);
    });

    const result = await createFrontierVideoKeyframe({
        intent: 'A duck walks toward a podium.',
        keyframe: { prompt: 'A duck at frame zero.', motion_contract: {} },
        segments: [{ shots: [{ visual: 'The duck advances.', camera: 'Wide shot.' }] }],
    }, [], {
        strategy: 'fast-gated-v3',
        serviceTier: 'fast',
        fastGateHedgeDelayMs: 0,
        onAttempt: attempt => attempts.push(attempt),
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(result.model, VIDEO_KEYFRAME_FAST_LITE_MODEL);
    assert.equal(result.bytes.toString(), 'fast-2');
    assert.equal(result.reviewStatus, 'accepted');
    assert.ok(attempts.some(attempt => (
        attempt.stage === 'keyframe_candidate_gemini'
        && attempt.model === VIDEO_KEYFRAME_MODEL
        && attempt.outcome === 'cancelled'
        && attempt.detail === 'Speculative full-quality candidate was no longer needed.'
    )));
});

test('keyframe experiment variants are opt-in and enforce supported resolution', () => {
    assert.deepEqual(configuredVideoKeyframeVariant({}), {
        geminiModel: VIDEO_KEYFRAME_MODEL,
        imageSize: '2K',
    });
    assert.deepEqual(configuredVideoKeyframeVariant({
        VIDEO_KEYFRAME_GEMINI_MODEL: VIDEO_KEYFRAME_FAST_MODEL,
        VIDEO_KEYFRAME_IMAGE_SIZE: '1K',
    }), {
        geminiModel: VIDEO_KEYFRAME_FAST_MODEL,
        imageSize: '1K',
    });
    assert.deepEqual(configuredVideoKeyframeVariant({
        VIDEO_KEYFRAME_GEMINI_MODEL: VIDEO_KEYFRAME_FAST_LITE_MODEL,
        VIDEO_KEYFRAME_IMAGE_SIZE: '2K',
    }), {
        geminiModel: VIDEO_KEYFRAME_FAST_LITE_MODEL,
        imageSize: '1K',
    });
    assert.deepEqual(configuredVideoKeyframeVariant({
        VIDEO_KEYFRAME_GEMINI_MODEL: 'invented-model',
        VIDEO_KEYFRAME_IMAGE_SIZE: '512K',
    }), {
        geminiModel: VIDEO_KEYFRAME_MODEL,
        imageSize: '2K',
    });
});

test('review-gated fast keyframes default globally and every override is reversible', () => {
    assert.equal(VIDEO_KEYFRAME_FAST_GATE_HEDGE_DELAY_MS, 12_000);
    assert.equal(configuredVideoKeyframeStrategy('483470443001413675', {}), 'fast-gated-v3');
    assert.equal(configuredVideoKeyframeStrategy('other-channel', {}), 'fast-gated-v3');
    assert.equal(configuredVideoKeyframeStrategy('other-channel', {
        VIDEO_KEYFRAME_STRATEGY: 'conditional-v2',
    }), 'conditional-v2');
    assert.equal(configuredVideoKeyframeStrategy('483470443001413675', {
        VIDEO_KEYFRAME_STRATEGY: 'serial-v1',
    }), 'serial-v1');
    assert.equal(configuredVideoKeyframeStrategy('outside-old-canary', {
        VIDEO_KEYFRAME_CANARY_CHANNELS: 'canary-one, canary-two',
    }), 'fast-gated-v3');
});
