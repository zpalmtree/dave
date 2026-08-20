import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { EmbedBuilder } from 'discord.js';

import { DisplayType, Paginate } from '../dist/Paginate.js';

test('preserves files returned by an embed page display function', async () => {
    const collector = new EventEmitter();
    let sentPayload;
    const sourceMessage = {
        channel: {
            send: async (payload) => {
                sentPayload = payload;
                return {
                    createReactionCollector: () => collector,
                    react: async () => {},
                };
            },
        },
    };
    const file = Buffer.from('image');
    const pages = new Paginate({
        sourceMessage,
        displayType: DisplayType.EmbedData,
        displayFunction: (_item, embed) => {
            embed.setImage('attachment://result.jpg');
            return { files: [file], attachments: [] };
        },
        data: [{}],
        embed: new EmbedBuilder(),
    });

    await pages.sendMessage();

    assert.deepEqual(sentPayload.files, [file]);
    assert.deepEqual(sentPayload.attachments, []);
    assert.equal(sentPayload.embeds[0].data.image.url, 'attachment://result.jpg');
});
