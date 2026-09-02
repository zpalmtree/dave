import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import test from 'node:test';

import { Commands } from '../dist/CommandDeclarations.js';
import { handleGooning } from '../dist/CommandImplementations.js';

test('gooning command posts the bundled video', async () => {
    const command = Commands.find(candidate => candidate.aliases.includes('gooning'));
    assert.ok(command, 'gooning command is present');
    assert.equal(command.primaryCommand.implementation, handleGooning);

    let sentPayload;
    await handleGooning({
        channel: {
            send: async (payload) => {
                sentPayload = payload;
            },
        },
    });

    assert.equal(sentPayload.files.length, 1);
    assert.equal(sentPayload.files[0].attachment, './images/gooning.mp4');
    assert.equal(sentPayload.files[0].name, 'gooning.mp4');

    const video = await stat(sentPayload.files[0].attachment);
    assert.ok(video.size > 0, 'bundled video is not empty');
});
