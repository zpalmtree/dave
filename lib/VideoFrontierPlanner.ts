import { createHash } from 'crypto';

import { config } from './Config.js';
import { VIDEO_MODELS, VideoModelId } from './VideoProtocol.js';

export const VIDEO_PLANNER_MODEL = 'gpt-5.6-sol';

export const VIDEO_PLAN_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'continuity_bible', 'keyframe', 'segments'],
    properties: {
        intent: { type: 'string' },
        continuity_bible: { type: 'string' },
        keyframe: {
            type: 'object',
            additionalProperties: false,
            required: ['recommended', 'reason', 'prompt', 'motion_contract'],
            properties: {
                recommended: { type: 'boolean' },
                reason: { type: 'string' },
                prompt: { type: 'string' },
                motion_contract: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                        'subject_orientation',
                        'gaze_direction',
                        'travel_direction',
                        'camera_relation',
                        'first_second_action',
                    ],
                    properties: {
                        subject_orientation: { type: 'string' },
                        gaze_direction: { type: 'string' },
                        travel_direction: { type: 'string' },
                        camera_relation: { type: 'string' },
                        first_second_action: { type: 'string' },
                    },
                },
            },
        },
        segments: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'transition', 'target_seconds', 'music', 'shots'],
                properties: {
                    title: { type: 'string' },
                    transition: { type: 'string', enum: ['start', 'continue', 'cut', 'dissolve'] },
                    target_seconds: { type: 'number', minimum: 1, maximum: 20 },
                    music: { type: 'string' },
                    shots: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 4,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['duration_seconds', 'visual', 'camera', 'audio', 'dialogue'],
                            properties: {
                                duration_seconds: { type: 'number', minimum: 0.5, maximum: 20 },
                                visual: { type: 'string' },
                                camera: { type: 'string' },
                                audio: { type: 'string' },
                                dialogue: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        additionalProperties: false,
                                        required: ['speaker_id', 'language', 'delivery', 'text'],
                                        properties: {
                                            speaker_id: { type: 'string' },
                                            language: { type: 'string' },
                                            delivery: { type: 'string' },
                                            text: { type: 'string' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
} as const;

export const VIDEO_PLANNER_INSTRUCTIONS = `You are the quality-first screenplay planner for a local generative-video pipeline. A render costs 5-30 minutes, so preserve intent and make the plan physically coherent before rendering.

Treat every content-bearing word in the request as material. Preserve every explicitly named game, franchise, work, person, place, product, style, count, time range, modifier, and quoted line. A request shaped like "X, but replace Y with Z" preserves X's name, defining presentation, camera language, world, rules, props, and actions, and replaces only Y. Do not generalize a named reference into a generic scene. Infer enough visible participants for a group concept to read clearly, but do not infer an exhaustive roster unless explicitly requested.

Choose the shortest natural finished duration that makes the idea legible, capped by the supplied total and per-segment limits. A segment is one independently generated clip, while shots inside a segment are directions that one generative pass must perform itself. Keep ordinary camera-angle, framing, or lens changes within the same continuous location, cast, lighting, and action as shots in one segment. Every hard scene change involving a different location, time, cast, environment, independent action, or deliberately discontinuous visual state must begin a new segment even when the total duration fits one model generation. Use transition=continue only when the next segment should inherit the preceding final frame and can physically continue from it; use cut for a fresh scene and dissolve only for an intentional soft transition. Do not split a continuous action merely to add another camera angle. The sum of shot durations within each segment should equal target_seconds.

Treat explicit speaking intent as authority to write speech. When the user asks subjects to speak, talk, discuss, converse, argue, debate, interview, narrate, announce, shout, sing, or otherwise vocalize but leaves some or all wording unspecified, write the shortest natural original dialogue or lyrics needed to express the requested topic and interaction. Give distinct participants concise turn-taking lines, identify the correct speaker and language, and make the corresponding shot.visual describe visible speaking or singing with synchronized mouth movement. If the user supplies quoted spoken wording, reproduce that wording verbatim for its intended turn: never paraphrase, censor, translate, extend, or pad a quoted line. Do not add speech when the request does not call for it. The shot.audio field contains only ambience, sound effects, and non-speech sound; all words belong in dialogue.

Treat non-dialogue audio as a chronological production contract, not a generic list. In each shot.audio, synchronize every prominent visible action to its audible consequence and describe the physical source, material or timbre, distance, acoustic space, stereo movement when relevant, and the sound's attack or decay. Establish a continuous environmental bed, then prioritize only the few foreground effects that make the action readable; keep ambience underneath them and avoid an impossible pile-up of unrelated sounds. Describe changes in intensity as the action develops. Do not invent a non-diegetic score unless the user requests music or the named presentation inherently requires it; otherwise set segment.music exactly to N/A. When music is justified, specify instrumentation, tempo, dynamics, and how it yields to important action sounds rather than merely naming a mood.

Recommend a generated keyframe when faces, identity, recurring subjects, exact wardrobe or props, product geometry, or deliberate composition benefit from a stable anchor. Avoid it for transformations, fluid motion, explosions, or chaotic abstract motion unless identity dominates. The keyframe prompt is the exact still at 0.00 seconds, not a sequence.

When a user-supplied start image accompanies the request, inspect it as the immutable frame at 0.00 seconds and set keyframe.recommended to false. Use keyframe.prompt to describe the observed frame rather than redesigning it. Plan the first shot to continue the visible pose, subject orientation, gaze, travel vector, screen direction, camera side and framing without a turn, reversal, gaze snap, axis crossing, teleport or unexplained reframe. The requested action may develop from the image, but it must not contradict the image at the transition.

Design the keyframe and first shot together. Define the dominant subject's orientation, gaze, travel vector and screen direction, camera side/angle/distance, and exact first-second action. Leave visual lead room in the direction of gaze or travel. The first shot must continue those facts without turning around, reversing, snapping gaze, teleporting, crossing the camera axis, or unexplained reframing. For a chase view, the vehicle must already point away/down-track with the camera behind it. For an approach, it must already face and travel toward the camera.

For forward-moving subjects, the physical front or vehicle nose, visible road/path ahead, track vanishing direction, gaze, and declared travel vector must all agree. Never compose a vehicle with its nose toward the camera while the visible track continues behind it. When identity or faces matter during lateral travel, prefer a true side-profile tracking view or a rear three-quarter view that still reveals profile faces; do not put the camera ahead merely to show faces.

The keyframe is generated by a positive-only diffusion prompt that may draw even explicitly negated names. When the request replaces a named franchise's original cast, preserve the exact franchise name in intent, continuity and video shots, but do not put the franchise name, original character names, or unwanted character/mascot/logo tokens anywhere in keyframe.prompt, including exclusions. Instead describe only the wanted replacement cast plus a concrete paraphrase of the franchise's world, presentation, rules, props and camera language. State the wanted cast positively as closed. If the user did not specify a count, anchor at most three identity-critical people in the keyframe and introduce other representatives in later shots; recognizable identities matter more than crowd size.

Make all requested evidence visibly verifiable in the actual shot visual and camera fields, not only in intent or continuity prose. Do not rely on titles, captions, logos, or on-screen text unless the request or named presentation requires them.`;

export function videoPromptRequestsSpeech(prompt: string): boolean {
    const normalized = prompt.replace(/\s+/g, ' ').trim();
    if (/\b(?:no|without)\s+(?:dialogue|speech|speaking|talking|words|vocals?)\b/i.test(normalized)
        || /\b(?:silent|silently|pantomime|mime)\b/i.test(normalized)) {
        return false;
    }
    return /\b(?:say|says|saying|speak|speaks|speaking|talk|talks|talking|discuss|discusses|discussed|discussing|discussion|conversation|converse|conversing|argue|argues|arguing|debate|debates|debating|interview|interviews|interviewing|narrate|narrates|narrating|announce|announces|announcing|shout|shouts|shouting|sing|sings|singing)\b/i.test(normalized);
}

function planHasDialogue(plan: any): boolean {
    return plan?.segments?.some((segment: any) => segment?.shots?.some(
        (shot: any) => shot?.dialogue?.some((line: any) => String(line?.text || '').trim()),
    ));
}

export interface VideoPlanSourceImage {
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    data: Buffer;
}

function extractOutputText(response: any): string {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) {
        return response.output_text.trim();
    }
    for (const item of response?.output || []) {
        if (item?.type !== 'message') continue;
        for (const content of item.content || []) {
            if (content?.type === 'output_text' && typeof content.text === 'string') {
                return content.text.trim();
            }
        }
    }
    throw new Error(response?.error?.message || 'GPT-5.6 Sol returned no screenplay.');
}

export async function createFrontierVideoPlan(
    prompt: string,
    model: VideoModelId,
    requesterId: string,
    sourceImage?: VideoPlanSourceImage,
): Promise<Record<string, unknown>> {
    const definition = VIDEO_MODELS[model];
    const isH3 = definition.generatorModel === 'h3';
    const speechRequired = videoPromptRequestsSpeech(prompt);
    const segmentMaximum = isH3 ? 15 : 20;
    const segmentMinimum = isH3 ? 5 : 3;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4 * 60 * 1000);
    try {
        const content: any[] = [{
            type: 'input_text',
            text: [
                'Aspect ratio: 16:9.',
                `Target video model: ${definition.displayName}.`,
                `Per-segment duration: ${segmentMinimum}-${segmentMaximum} seconds.`,
                'Choose an automatic total duration no longer than 30 seconds.',
                sourceImage
                    ? 'The accompanying image is the user-supplied immutable frame at 0.00 seconds.'
                    : 'No user-supplied starting image is present.',
                speechRequired
                    ? 'Dialogue requirement: the request explicitly calls for vocal interaction. Supply concise spoken dialogue for every unspecified vocal turn; do not replace it with pantomime.'
                    : 'Dialogue requirement: do not add speech unless the request explicitly calls for it.',
                `User request: ${prompt}`,
            ].join('\n'),
        }];
        if (sourceImage) {
            content.push({
                type: 'input_image',
                image_url: `data:${sourceImage.mimeType};base64,${sourceImage.data.toString('base64')}`,
                detail: 'high',
            });
        }
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${config.openaiApiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: VIDEO_PLANNER_MODEL,
                reasoning: { effort: 'high' },
                instructions: VIDEO_PLANNER_INSTRUCTIONS,
                input: [{
                    role: 'user',
                    content,
                }],
                text: {
                    verbosity: 'low',
                    format: {
                        type: 'json_schema',
                        name: 'local_video_screenplay',
                        strict: true,
                        schema: VIDEO_PLAN_SCHEMA,
                    },
                },
                max_output_tokens: 8000,
                safety_identifier: `video_${createHash('sha256').update(requesterId).digest('hex').slice(0, 24)}`,
                store: false,
            }),
        });
        const body: any = await response.json();
        if (!response.ok) {
            throw new Error(body?.error?.message || `OpenAI returned HTTP ${response.status}.`);
        }
        const plan = JSON.parse(extractOutputText(body));
        if (!plan || typeof plan !== 'object' || !Array.isArray(plan.segments)) {
            throw new Error('GPT-5.6 Sol returned an invalid screenplay object.');
        }
        if (speechRequired && !planHasDialogue(plan)) {
            throw new Error('GPT-5.6 Sol omitted dialogue required by the vocal interaction request.');
        }
        const usage = body?.usage;
        if (usage) {
            console.log(
                `[Video planner] ${VIDEO_PLANNER_MODEL}: ${Number(usage.input_tokens || 0)} input, `
                + `${Number(usage.output_tokens || 0)} output tokens`,
            );
        }
        return plan;
    } finally {
        clearTimeout(timeout);
    }
}
