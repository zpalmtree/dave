#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GoogleGenAI } from '@google/genai';

import { AI_MODELS } from '../dist/AIModels.js';
import { config } from '../dist/Config.js';

const planPath = process.argv[2];
const outputRoot = process.argv[3];

if (!planPath || !outputRoot) {
    console.error('Usage: compare-video-keyframes.mjs PLAN_JSON OUTPUT_DIR');
    process.exit(2);
}

const plan = JSON.parse(await readFile(planPath, 'utf8'));
const keyframe = plan.keyframe;
const motion = keyframe.motion_contract;
const prompt = [
    keyframe.prompt,
    'This is exactly frame 0.00 of a video.',
    `Subject orientation: ${motion.subject_orientation}`,
    `Gaze: ${motion.gaze_direction}`,
    `Travel direction: ${motion.travel_direction}`,
    `Camera: ${motion.camera_relation}`,
    `First-second continuation: ${motion.first_second_action}`,
    'Compose the still so that continuation requires no turn, reversal, gaze snap, axis crossing, or reframe.',
].join('\n');

await mkdir(outputRoot, { recursive: true });

async function timed(name, operation) {
    const started = Date.now();
    try {
        const result = await operation();
        console.log(`${name}: ${((Date.now() - started) / 1000).toFixed(1)}s -> ${result}`);
        return result;
    } catch (error) {
        console.error(`${name}: failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

async function generateOpenAI() {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${config.openaiApiKey}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: AI_MODELS.openAIImage,
            prompt,
            size: '1536x864',
            quality: 'high',
            output_format: 'png',
            moderation: 'low',
            n: 1,
        }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || `OpenAI HTTP ${response.status}`);
    const encoded = body?.data?.[0]?.b64_json;
    if (!encoded) throw new Error('OpenAI returned no image data');
    const output = path.join(outputRoot, 'cimage-gpt-image-2.png');
    await writeFile(output, Buffer.from(encoded, 'base64'));
    return output;
}

async function generateGrok() {
    const response = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${config.grokApiKey}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: AI_MODELS.grokImage,
            prompt,
            aspect_ratio: '16:9',
            resolution: '2k',
            quality: 'medium',
            n: 1,
            response_format: 'url',
        }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || `xAI HTTP ${response.status}`);
    const encoded = body?.data?.[0]?.b64_json;
    const url = body?.data?.[0]?.url;
    let bytes;
    if (encoded) {
        bytes = Buffer.from(encoded, 'base64');
    } else if (url) {
        const imageResponse = await fetch(url);
        if (!imageResponse.ok) throw new Error(`xAI image download HTTP ${imageResponse.status}`);
        bytes = Buffer.from(await imageResponse.arrayBuffer());
    } else {
        throw new Error('xAI returned no image data');
    }
    const output = path.join(outputRoot, 'grokimage-imagine-2.png');
    await writeFile(output, bytes);
    return output;
}

async function generateGemini() {
    const client = new GoogleGenAI({
        apiKey: config.geminiApiKey,
        apiVersion: 'v1alpha',
    });
    const response = await client.models.generateContent({
        model: AI_MODELS.geminiImage,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
            responseModalities: ['IMAGE'],
            imageConfig: {
                aspectRatio: '16:9',
                imageSize: '2K',
            },
        },
    });
    const imagePart = response.candidates
        ?.flatMap(candidate => candidate.content?.parts || [])
        .find(part => part.inlineData?.mimeType?.startsWith('image/') && part.inlineData?.data);
    if (!imagePart?.inlineData?.data) throw new Error('Gemini returned no image data');
    const extension = imagePart.inlineData.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const output = path.join(outputRoot, `gimage-gemini-3-pro.${extension}`);
    await writeFile(output, Buffer.from(imagePart.inlineData.data, 'base64'));
    return output;
}

const results = await Promise.all([
    timed('cimage / GPT Image 2', generateOpenAI),
    timed('grokimage / Grok Imagine Image 2.0', generateGrok),
    timed('gimage / Gemini 3 Pro Image', generateGemini),
]);

if (results.every(result => result === null)) process.exit(1);
