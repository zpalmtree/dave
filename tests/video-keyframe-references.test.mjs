import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    countVideoKeyframeReferenceRequirements,
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

test('generic and ambiguous character references cannot bind arbitrary public images', async () => {
    const genericDirectory = mkdtempSync(join(tmpdir(), 'dave-video-generic-reference-'));
    const ambiguousDirectory = mkdtempSync(join(tmpdir(), 'dave-video-ambiguous-reference-'));
    let searches = 0;
    let validations = 0;
    const search = async () => {
        searches += 1;
        return [{
            title: 'Be in awe of my tism shirt',
            link: 'https://images.example/shirt.png',
            url: 'https://example.com/shirt',
            displayLink: 'example.com',
        }];
    };
    const download = async () => ({
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        extension: 'png',
    });
    const generic = {
        keyframe: {
            recommended: true,
            reference_requirements: [{
                label: 'alien_character',
                kind: 'character',
                search_query: 'alien character design',
                visual_facts_to_preserve: 'Generic non-human anatomy.',
            }],
        },
    };
    const ambiguous = {
        keyframe: {
            recommended: true,
            reference_requirements: [{
                label: 'Tism',
                kind: 'character',
                search_query: 'Tism character design',
                visual_facts_to_preserve: 'Preserve the named character design.',
            }],
        },
    };

    try {
        assert.equal(countVideoKeyframeReferenceRequirements(generic), 0);
        assert.deepEqual(
            await resolveVideoKeyframeReferences(generic, genericDirectory, search, download),
            [],
        );
        assert.equal(searches, 0);

        assert.deepEqual(await resolveVideoKeyframeReferences(
            ambiguous,
            ambiguousDirectory,
            search,
            download,
            {},
            async () => {
                validations += 1;
                return false;
            },
        ), []);
        assert.equal(searches, 1);
        assert.equal(validations, 1);
    } finally {
        rmSync(genericDirectory, { recursive: true, force: true });
        rmSync(ambiguousDirectory, { recursive: true, force: true });
    }
});

test('an ambiguous reference rejected by validation falls through to later search results', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dave-video-ambiguous-reference-fallback-'));
    const downloaded = [];
    const validated = [];
    const plan = {
        keyframe: {
            recommended: true,
            reference_requirements: [{
                label: 'Tism',
                kind: 'character',
                search_query: 'Tism character design',
                visual_facts_to_preserve: 'Preserve the named character design.',
            }],
        },
    };
    const results = [
        {
            title: 'Unrelated merchandise',
            link: 'https://images.example/shirt.png',
            url: 'https://example.com/shirt',
            displayLink: 'example.com',
        },
        {
            title: 'Canonical character reference',
            link: 'https://images.example/character.png',
            url: 'https://example.com/character',
            displayLink: 'example.com',
        },
    ];

    try {
        const references = await resolveVideoKeyframeReferences(
            plan,
            directory,
            async () => results,
            async result => {
                downloaded.push(result.link);
                return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), extension: 'png' };
            },
            {},
            async (_requirement, result) => {
                validated.push(result.link);
                return result.link.endsWith('/character.png');
            },
        );

        assert.equal(references.length, 1);
        assert.equal(references[0].sourceUrl, 'https://images.example/character.png');
        assert.deepEqual(downloaded, results.map(result => result.link));
        assert.deepEqual(validated, results.map(result => result.link));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
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
