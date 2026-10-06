/* Sol Slugs commands. Only the slugs deployment track registers these (see
 * trackCommands in CommandDeclarations.ts), but this file is kept identical
 * on master and slugs so changes cherry-pick cleanly between them. */

import fetch from 'node-fetch';
import { PublicKey } from '@solana/web3.js';
import {
    EmbedBuilder,
    Message,
    TextChannel,
} from 'discord.js';

import { config } from './Config.js';
import { Args, Command } from './Types.js';
import { pluralize, replyWithMention } from './Utilities.js';

const SLUGS_API_URL = 'https://letsalllovelain.com/slugs/';

const MAGIC_EDEN_STATS_URL = 'https://api-mainnet.magiceden.dev/v2/collections/sol_slugs/stats';

/* Wallets whose burns don't count towards gen 4 or later mints. */
const EXCLUDED_BURNERS = [
    'BnZNCQz3Zqb1o4nrjW3zNGbWdKubSTw7mAU5NGYouJMF',
    'GXgLxgoJ9oNRCHRQZwaY1v5dXqcpys3K2LqNuRtGM6oo',
];

interface BurnWindow {
    start: Date;
    end: Date;
    burnsPerSlug: number;
}

/* Slugs burnt between start and end (inclusive) earn one slug of the next
 * generation per burnsPerSlug burnt. */
const GEN3_WINDOW: BurnWindow = {
    start: new Date('2022-01-01'),
    end: new Date('2022-11-14'),
    burnsPerSlug: 3,
};

const GEN4_WINDOW: BurnWindow = {
    start: new Date('2022-11-14'),
    end: new Date('2024-10-25'),
    burnsPerSlug: 4,
};

const GEN5_WINDOW: BurnWindow = {
    start: new Date('2024-10-25'),
    end: new Date('2030-10-24'),
    burnsPerSlug: 5,
};

interface BurnStatsUser {
    address: string;
    transactions: Array<{ timestamp: string, slugsBurnt: unknown[] }>;
}

function isValidSolAddress(address: string) {
    try {
        const pubkey = new PublicKey(address);
        return PublicKey.isOnCurve(pubkey.toBuffer());
    } catch (error) {
        return false;
    }
}

async function fetchSlugStats(): Promise<any | undefined> {
    const res = await fetch(SLUGS_API_URL);
    return res.ok ? res.json() : undefined;
}

function eligibleBurns(user: BurnStatsUser, window: BurnWindow): number {
    let burns = 0;

    for (const burn of user.transactions) {
        const timestamp = new Date(burn.timestamp);

        if (timestamp >= window.start && timestamp <= window.end) {
            burns += burn.slugsBurnt.length;
        }
    }

    return burns;
}

/* Totals eligible burns and earned slugs, for one wallet if address is
 * non-empty, otherwise across every wallet. */
function tallyBurns(
    users: BurnStatsUser[],
    window: BurnWindow,
    address: string,
    excluded: string[],
): { burns: number, slugs: number } {
    let burns = 0;
    let slugs = 0;

    for (const user of users) {
        if (excluded.includes(user.address)) {
            continue;
        }

        if (address !== '' && user.address !== address) {
            continue;
        }

        const userBurns = eligibleBurns(user, window);

        burns += userBurns;
        slugs += Math.floor(userBurns / window.burnsPerSlug);
    }

    return { burns, slugs };
}

/* Returns the trimmed wallet address argument, or undefined after replying
 * if it isn't a valid address. */
async function walletArgument(msg: Message, args: string): Promise<string | undefined> {
    const address = args.trim();

    if (address !== '' && !isValidSolAddress(address)) {
        await replyWithMention(msg, `That does not appear to be a valid Solana wallet address (${address})`);
        return undefined;
    }

    return address;
}

async function handleGen3CountLegacy(msg: Message, args: string): Promise<void> {
    const address = await walletArgument(msg, args);

    if (address === undefined) {
        return;
    }

    if (address === '') {
        await replyWithMention(msg, `The Generation 3 slug supply will be 800.`);
        return;
    }

    const data = await fetchSlugStats();

    if (!data) {
        await msg.reply('Failed to fetch Gen3 count from API!');
        return;
    }

    const { burns, slugs } = tallyBurns(data.burnStats.users, GEN3_WINDOW, address, []);

    if (slugs === 0) {
        await replyWithMention(
            msg,
            `You have ${burns} eligible ${pluralize(burns, 'burn')}. Unfortunately, you missed out on the gen 3 burn period!`,
        );
    } else {
        await replyWithMention(
            msg,
            `You are currently set to receive ${slugs} generation 3 ${pluralize(slugs, 'slug')}! You have ${burns} eligible burns.`,
        );
    }
}

async function handleGen4Count(msg: Message, args: string): Promise<void> {
    const address = await walletArgument(msg, args);

    if (address === undefined) {
        return;
    }

    if (address === '') {
        await replyWithMention(msg, `The current projected Generation 4 slug supply is 411.`);
        return;
    }

    const data = await fetchSlugStats();

    if (!data) {
        await msg.reply('Failed to fetch Gen4 count from API!');
        return;
    }

    const { burns, slugs } = tallyBurns(data.burnStats.users, GEN4_WINDOW, address, EXCLUDED_BURNERS);

    if (slugs === 0) {
        await replyWithMention(
            msg,
            `You have ${burns} eligible ${pluralize(burns, 'burn')}. Every four slugs burnt will get you one generation 4 slug. Unfortunately, you missed the gen4 burn cutoff!`
        );
    } else {
        await replyWithMention(
            msg,
            `You are currently set to receive ${slugs} generation 4 ${pluralize(slugs, 'slug')}! You have ${burns} eligible burns.`,
        );
    }
}

async function handleGen5Count(msg: Message, args: string): Promise<void> {
    const address = await walletArgument(msg, args);

    if (address === undefined) {
        return;
    }

    const data = await fetchSlugStats();

    if (!data) {
        await msg.reply('Failed to fetch Gen5 count from API!');
        return;
    }

    const { burns, slugs } = tallyBurns(data.burnStats.users, GEN5_WINDOW, address, EXCLUDED_BURNERS);

    if (address === '') {
        await replyWithMention(msg, `The current projected Generation 5 slug supply is ${slugs}`);
        return;
    }

    const burnsForNextSlug = GEN5_WINDOW.burnsPerSlug - (burns % GEN5_WINDOW.burnsPerSlug);
    const slugStr = pluralize(burnsForNextSlug, 'slug');

    if (slugs === 0) {
        await replyWithMention(
            msg,
            `You have ${burns} eligible ${pluralize(burns, 'burn')}. Every five slugs burnt will get you one generation 5 slug. Burn ${burnsForNextSlug} ${burns > 0 ? 'more ' : ''}${slugStr} to be eligible for your first generation 5 slug.`
        );
    } else {
        await replyWithMention(
            msg,
            `You are currently set to receive ${slugs} generation 5 ${pluralize(slugs, 'slug')}! You have ${burns} eligible burns. Burn ${burnsForNextSlug} more ${slugStr} to be eligible for another generation 5 slug.`,
        );
    }
}

async function sendLeaderboard(msg: Message, generation: number, window: BurnWindow): Promise<void> {
    const data = await fetchSlugStats();

    if (!data) {
        await msg.reply('Failed to fetch burn stats from API!');
        return;
    }

    const eligibility = new Map<string, number>();

    for (const user of data.burnStats.users as BurnStatsUser[]) {
        if (EXCLUDED_BURNERS.includes(user.address)) {
            continue;
        }

        eligibility.set(user.address, Math.floor(eligibleBurns(user, window) / window.burnsPerSlug));
    }

    const topUsers = Array.from(eligibility.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle(`Top 10 Gen${generation} Eligibility`)
        .setDescription(topUsers.map(([address, slugs], index) =>
            `${index + 1}. ${address}\n   Eligible: ${slugs}`).join('\n\n'));

    await (msg.channel as TextChannel).send({ embeds: [embed] });
}

async function handleBurnt(msg: Message, args: string): Promise<void> {
    const address = await walletArgument(msg, args);

    if (address === undefined) {
        return;
    }

    const data = await fetchSlugStats();

    if (!data) {
        await msg.reply('Failed to fetch burnt count from API!');
        return;
    }

    if (address === '') {
        await replyWithMention(msg, `${data.slugs.burnt.length} slugs have been burnt!`);
        return;
    }

    let burns = 0;

    for (const user of data.burnStats.users as BurnStatsUser[]) {
        if (user.address !== address) {
            continue;
        }

        for (const burn of user.transactions) {
            burns += burn.slugsBurnt.length;
        }
    }

    if (burns === 0) {
        await msg.reply(`${address} hasn't burnt any slugs yet. What are they playing at?`);
    } else {
        await msg.reply(`${address} has burnt ${burns} ${pluralize(burns, 'slug')}. Good job!`);
    }
}

async function handleSupply(msg: Message): Promise<void> {
    const data = await fetchSlugStats();

    if (!data) {
        await msg.reply('Failed to fetch supply count from API!');
        return;
    }

    await replyWithMention(msg, `Current slug supply: ${data.slugStats.slugCount}`);
}

async function handleSlugFloor(msg: Message): Promise<void> {
    try {
        const res = await fetch(MAGIC_EDEN_STATS_URL);

        if (!res.ok) {
            await replyWithMention(msg, 'Failed to fetch Sol Slugs floor price from Magic Eden!');
            return;
        }

        const data = await res.json();

        /* Magic Eden reports lamports */
        const floorPriceSOL = (data.floorPrice / 1e9).toFixed(2);

        await replyWithMention(msg, `The current Sol Slugs floor price is ${floorPriceSOL} SOL`);
    } catch (error) {
        await replyWithMention(msg, 'An error occurred while fetching the floor price!');
        console.error('Error fetching Sol Slugs floor price:', error);
    }
}

async function handleCock(msg: Message): Promise<void> {
    const guwap = '238350296093294592';

    if (msg.author.id === guwap) {
        msg.reply(`Nice balls!`);
    } else {
        msg.reply(`Nice cock!`);
    }
}

function replyWith(reply: string): (msg: Message) => Promise<void> {
    return (msg: Message) => replyWithMention(msg, reply);
}

function staticReplyCommand(aliases: string[], description: string, reply: string): Command {
    return {
        aliases,
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: replyWith(reply),
            description,
        },
    };
}

const BURN_INFO = `A lot of slug utility comes from burning a slug.
**Why burn a slug?**
* Help be part of the most deflationary collection on Solana - with over 5300 slugs burnt!
* Access to alpha, whitelist, and other burner only channels.
* Alpha bots - Find trending magiceden collections, new twitter accounts, and just created mints.
* Free stuff - Sometimes we will raffle 1/1s, airdrops, or other valuable items. Burners come first whenever this happens.
* Merch - This is still in the works, but slug burners will have the first access to slug merch.
* Future slug generations - As part of the slugs deflationary mechanism, burning enough slugs entitles you to a mint from the next slug generation. The current rate is 4:1, for generation four.`;

const UTILITY_INFO = `**Why buy a slug?**
* Gain benefits on our sleek portfolio tracker, slime: <https://slime.cx/>
* Enjoy the slug supply constantly decreasing. It's already shrunk from 10,000 to 7,200!
* Try out the slug AI image generator and chat bots
* Burn your slug for more benefits! Try \`${config.prefix}burn\` for more info.
* Chill in one of the most active chats in Solana. No more gm spam!
* Help support the <https://sol-incinerator.com/>'s free operation.`;

const TRENDING_INFO = `The trending bot is separated into 6 different channels, by window of time. The 1m channel, for example, will show the hottest collections within a 1 minute interval. A hot collection is defined as having the greatest NUMBER of sales within that interval.

So a collection that sells 100 units in 1 minute would be hotter than one that sold 50 units in 1 minute.

The colors indicate the sold to listed balance.

Green: Sold > Listed
Yellow: Sold = Listed
Red: Sold < Listed

Volume is the total amount of Solana transacted within the interval. Low is the lowest sale price, High is the highest sale price, and Average is the average sale price.

It is useful to look at how these collections are trending - is the number of sold going up each interval, for example? Is there a high average, indicating people are sniping rares? There's a strategy to develop using the trending bot, but if use effectively, can lead to great trading success.`;

const FROZEN_INFO = `Some scam tokens are freezing the token accounts so you can’t get burn or transfer them. Our dev has posted about the issue on Solana’s GitHub in hopes they fix it, but we will be pushing an update soon with our redesign that makes it more obvious the token is frozen and cannot be burnt.\n\nIf you have a GitHub account, you could let the Solana devs know you would like to see this fixed - <https://github.com/solana-labs/solana-program-library/issues/3295>`;

const INCINERATOR_FAQ = `Q. Where is the money coming from?
A. Its liberating a small storage fee

Q. I only got 0.002 for an NFT. What gives!?
A. The MAJORITY of NFTs give 0.01. Non-master editions(non unique) tokens, like scams, still give 0.002

Q. Theres an NFT in my wallet that wont burn. Why?
A. Some nfts, scams in particular, abuse the freeze instruction - you cant send them out or burn them.

Q. I burned and it doesnt seem like I got anything. What happened?
A. The amount you get is very small, unless youre burning a lot of NFTs. You need to burn at least 100 to get 1 sol!`;

export const slugCommands: Command[] = [
    staticReplyCommand(
        ['gen3', 'gen3count', 'gen3supply'],
        'Displays the current Generation 3 slug supply',
        `Generation 3 slugs can be found by filtering for Shipwreck, Submarine, Fish Tank, Underwater Cult, and Night Shift backgrounds. They are part of the same slugs collection, with new, rarer, underwater themed traits. They were awarded to users who burnt three slugs.`,
    ),
    {
        aliases: ['gen3legacy'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGen3CountLegacy,
            description: 'Displays the historical Generation 3 eligiblity',
        },
    },
    {
        aliases: ['gen4', 'gen4count', 'gen4supply'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGen4Count,
            description: 'Displays the current Generation 4 slug supply',
        },
    },
    {
        aliases: ['gen4leaderboard', 'leaderboard'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: (msg: Message) => sendLeaderboard(msg, 4, GEN4_WINDOW),
            description: 'Display users getting the most gen4 slugs',
        },
    },
    {
        aliases: ['gen5', 'gen5count', 'gen5supply'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleGen5Count,
            description: 'Displays the current Generation 5 slug supply',
        },
    },
    {
        aliases: ['gen5leaderboard'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: (msg: Message) => sendLeaderboard(msg, 5, GEN5_WINDOW),
            description: 'Display users getting the most gen5 slugs',
        },
    },
    {
        aliases: ['burnt', 'burned'],
        primaryCommand: {
            argsFormat: Args.Combined,
            implementation: handleBurnt,
            description: 'Displays the current number of slugs burnt by the incinerator',
        },
    },
    {
        aliases: ['cock', 'downbad', 'stepbro'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleCock,
            description: 'get a compliment',
        },
    },
    staticReplyCommand(['burn'], 'Explain why you might burn a slug', BURN_INFO),
    staticReplyCommand(['utility', 'whybuy'], 'Explain why you might buy a slug', UTILITY_INFO),
    staticReplyCommand(
        ['3dslugs', '3d'],
        'Get info on 3d slugs',
        `3D slugs or Slugs Regenesis are a separate collection by the same team but the supply is much lower. As a free mint for rug victims, they don't have any defined utility yet, but they've got rocket launchers and katanas, they're cool as fuck. <https://magiceden.io/marketplace/slugs_regenesis>`,
    ),
    staticReplyCommand(
        ['gen2', 'generation2'],
        'Get info on gen 2',
        `Generation 2 slugs can be found by filtering for Arena, Temple, and Pyramid backgrounds. They are part of the same slugs collection, with new, rarer, god of death themed traits. They were awarded to users who burnt two slugs.`,
    ),
    staticReplyCommand(['buy', 'market'], 'Get a link to markets', `<https://www.tensor.trade/trade/sol_slugs>`),
    staticReplyCommand(['verify'], 'Get a verify link', `Get your holder and burner roles here: <https://solslugs.com/#/verify>`),
    staticReplyCommand(['incinerator'], 'Get incinerator link', `Burn your slugs, rugs, or scams here: <https://sol-incinerator.com/>`),
    staticReplyCommand(['trending'], 'Get info on using the trending bot', TRENDING_INFO),
    staticReplyCommand(
        ['sign', 'tapthesign', 'tapsign', 'chill'],
        'Tap the sign',
        'https://media.discordapp.net/attachments/483470443001413675/1064019335955365918/sign.png',
    ),
    {
        aliases: ['clowns', 'sendintheclowns'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: (msg: Message) => msg.reply('https://www.youtube.com/watch?v=ZG15oP7q4fI'),
            description: 'Send in the clowns',
        },
    },
    staticReplyCommand(['frozen', 'freeze'], 'Get info on frozen tokens', FROZEN_INFO),
    staticReplyCommand(['incin', 'incinfaq'], 'Frequently asked questions about the incinerator', INCINERATOR_FAQ),
    staticReplyCommand(['slime'], 'Get a link to slime', 'https://slime.cx/'),
    staticReplyCommand(['info', 'gitbook'], 'Get a link to the slugs gitbook', 'https://solana-slugs.gitbook.io/solana-slugs/'),
    staticReplyCommand(
        ['howtoai', 'aiinfo', 'aitut'],
        'Get info on using the AI image bot',
        'https://media.discordapp.net/attachments/891081746186113024/1074511672401731724/image.png',
    ),
    {
        aliases: ['floor'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleSlugFloor,
            description: 'Get sol slugs floor price',
        },
    },
    {
        aliases: ['slugpride'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: (msg: Message) => (msg.channel as TextChannel).send('https://cdn.discordapp.com/attachments/891081495706480690/1114374514005004489/slugpride.mp4?ex=672acf24&is=67297da4&hm=a46182d421d814a509b4e386b0392a19e1d9146ecca433789a1ae18c986287d8'),
            description: 'Get slug pride video',
        },
    },
    {
        aliases: ['supply'],
        primaryCommand: {
            argsFormat: Args.DontNeed,
            implementation: handleSupply,
            description: 'Get current sol slugs supply',
        },
    },
];
