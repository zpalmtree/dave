import {
    Message,
    MessageEmbed,
    MessageReaction,
    ReactionCollector,
    User,
} from 'discord.js';

import { Database } from 'sqlite3';

import {
    MILLISECONDS_PER_TICK,
    DEFAULT_STARTING_HP,
    POINTS_PER_MOVE,
} from './Constants';

import {
    Paginate,
    DisplayType,
} from '../Paginate';

import {
    selectOneQuery,
    insertQuery,
} from '../Database';

export enum PerkType {
    Medic = 0,
    Kamikaze = 1,
    Sonic = 2,
    Juggernaut = 3,
}

export interface Perk {
    name: string;

    description: string;

    perkType: PerkType;
}

export const perks = [
    {
        name: 'Medic',
        description: `Every ${Math.floor(MILLISECONDS_PER_TICK / 1000 / 60)} minutes, ` +
            `you regenerate 2 health points.`,
        perkType: PerkType.Medic,
    },
    {
        name: 'Kamikaze',
        description: `At any time, you may shoot yourself, to self destruct, killing ` +
            `yourself, and causing ${Math.floor(DEFAULT_STARTING_HP / 2)} damage to the immediately ` +
            `surrounding tiles.`,
        perkType: PerkType.Kamikaze
    },
    {
        name: 'Sonic',
        description: `It only costs you ${Math.floor(POINTS_PER_MOVE / 2)} points to move ` +
            `a single tile, instead of ${POINTS_PER_MOVE} points.`,
        perkType: PerkType.Sonic,
    },
    {
        name: 'Juggernaut',
        description: `Your starting health is doubled, from ${DEFAULT_STARTING_HP}, ` +
            `to ${Math.floor(DEFAULT_STARTING_HP * 2)}. It costs you ` +
            `${Math.floor(POINTS_PER_MOVE * 2)} points to move a single tile, ` +
            `instead of ${POINTS_PER_MOVE} points.`,
        perkType: PerkType.Juggernaut,
    },
];

export async function loadPerk(userId: string, db: Database) {
    const perk = await selectOneQuery(
        `SELECT
            perk
        FROM
            tank_preferences
        WHERE
            user_id = ?`,
        db,
        [
            userId,
        ],
    );

    if (perk) {
        return (perk as any).perk;
    }

    return 0;
}

export async function savePerk(userId: string, perk: PerkType, db: Database) {
    await insertQuery(
        `INSERT INTO tank_preferences (
            user_id,
            perk
        ) VALUES (
            ?,
            ?
        ) ON CONFLICT (
            user_id
        )
        DO UPDATE
        SET
            perk = excluded.perk`,
        db,
        [
            userId,
            perk,
        ]
    );
}

export async function customizePerk(msg: Message, db: Database) {
    const currentPerk = await loadPerk(msg.author.id, db);

    const embed = new MessageEmbed()
        .setTitle('Modify your Turtle Tank Perk')
        .setDescription('Scroll through the perks and react with 👍 to confirm your chosen perk.');

    const f = async function(this: Paginate<Perk>, item: Perk, embed: MessageEmbed) {
        embed.setDescription('Scroll through the perks and react with 👍 to confirm your chosen perk.')

        return {
            name: item.name,
            value: item.description,
        };
    }

    const pages = new Paginate({
        sourceMessage: msg,
        displayType: DisplayType.EmbedFieldData,
        displayFunction: f,
        data: perks,
        embed,
        customReactions: ['👍'],
        customReactionFunction: async (items: Perk[], embed: MessageEmbed, reaction: MessageReaction, user: User) => {
            const { perkType } = items[0];

            await savePerk(msg.author.id, perkType, db);

            embed.setDescription('Perk updated. Will not effect currently running games.');

            return embed;
        },
        permittedUsers: [msg.author.id],
    });

    pages.setPage(perks.findIndex((x) => x.perkType === currentPerk) as number);

    await pages.sendMessage();
}
