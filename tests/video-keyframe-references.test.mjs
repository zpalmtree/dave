import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    resolveVideoKeyframeReferences,
    searchVideoKeyframeReferenceImages,
} from '../dist/VideoKeyframeReferences.js';

test('video reference search uses the configured Google image endpoint and keeps provenance', async () => {
    let requestedUrl = '';
    const results = await searchVideoKeyframeReferenceImages(
        'distinctive fictional racer official character',
        async url => {
            requestedUrl = String(url);
            return {
                ok: true,
                json: async () => ({
                    items: [{
                        title: 'Official character',
                        link: 'https://images.example/character.png',
                        displayLink: 'example.com',
                        mime: 'image/png',
                        image: {
                            contextLink: 'https://example.com/character',
                            thumbnailLink: 'https://encrypted-tbn0.gstatic.com/character',
                            byteSize: 1234,
                        },
                    }],
                }),
            };
        },
    );

    const url = new URL(requestedUrl);
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/customsearch/v1');
    assert.equal(url.searchParams.get('searchType'), 'image');
    assert.equal(url.searchParams.get('q'), 'distinctive fictional racer official character');
    assert.equal(results.length, 1);
    assert.equal(results[0].link, 'https://images.example/character.png');
    assert.equal(results[0].url, 'https://example.com/character');
});

test('video keyframe references are bounded, downloaded, and reused from the job cache', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-references-'));
    const searches = [];
    let downloads = 0;
    const plan = {
        keyframe: {
            recommended: true,
            reference_requirements: [{
                label: 'Distinctive hero',
                kind: 'character',
                search_query: 'distinctive hero official art',
                visual_facts_to_preserve: 'Blue helmet, crescent visor, and orange scarf.',
            }],
        },
    };
    const search = async query => {
        searches.push(query);
        return [{
            title: 'Reference',
            link: 'https://images.example/hero.png',
            url: 'https://example.com/hero',
            displayLink: 'example.com',
            thumbnailLink: 'https://encrypted-tbn0.gstatic.com/hero',
        }];
    };
    const download = async () => {
        downloads += 1;
        return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), extension: 'png' };
    };

    try {
        const first = await resolveVideoKeyframeReferences(plan, directory, search, download);
        const second = await resolveVideoKeyframeReferences(plan, directory, search, download);
        assert.equal(first.length, 1);
        assert.equal(first[0].label, 'Distinctive hero');
        assert.equal(first[0].kind, 'character');
        assert.equal(first[0].mimeType, 'image/png');
        assert.equal(first[0].sourceUrl, 'https://images.example/hero.png');
        assert.deepEqual(second, first);
        assert.deepEqual(searches, ['distinctive hero official art']);
        assert.equal(downloads, 1);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('identical reference contracts are reused across job directories without another search', async () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), 'dave-video-reference-first-job-'));
    const secondDirectory = mkdtempSync(join(tmpdir(), 'dave-video-reference-second-job-'));
    let searches = 0;
    let downloads = 0;
    const plan = {
        keyframe: {
            recommended: true,
            reference_requirements: [{
                label: 'Cross-job cache identity',
                kind: 'identity',
                search_query: 'cross-job cache identity exact contract 2026',
                visual_facts_to_preserve: 'A unique exact-contract face used only by this test.',
            }],
        },
    };
    const search = async () => {
        searches += 1;
        return [{
            title: 'Cross-job reference',
            link: 'https://images.example/cross-job-reference.png',
            url: 'https://example.com/cross-job-reference',
            displayLink: 'example.com',
            thumbnailLink: 'https://encrypted-tbn0.gstatic.com/cross-job-reference',
        }];
    };
    const download = async () => {
        downloads += 1;
        return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), extension: 'png' };
    };

    try {
        const first = await resolveVideoKeyframeReferences(plan, firstDirectory, search, download);
        const second = await resolveVideoKeyframeReferences(plan, secondDirectory, search, download);
        assert.deepEqual(second, first);
        assert.equal(searches, 1);
        assert.equal(downloads, 1);
        assert.deepEqual(
            readFileSync(join(secondDirectory, 'references', 'reference_1.png')),
            first[0].bytes,
        );
    } finally {
        rmSync(firstDirectory, { recursive: true, force: true });
        rmSync(secondDirectory, { recursive: true, force: true });
    }
});
