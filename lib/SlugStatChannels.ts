/* Keeps the Sol Slugs floor price and total volume channel names current.
 * Slugs track only: master's Config has no priceChannel or volumeChannel. */

import fetch from 'node-fetch';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Client, GuildChannel } from 'discord.js';

import { config } from './Config.js';
import { numberWithCommas } from './Utilities.js';

const MAGIC_EDEN_SOL_SLUGS_STATS_URL = 'https://api-mainnet.magiceden.dev/rpc/getCollectionEscrowStats/sol_slugs';
const TENSOR_SOL_SLUGS_STATS_URL = 'https://api.mainnet.tensordev.io/api/v1/collections?sortBy=statsV2.volumeAll:desc&limit=1&slugDisplays=sol_slugs';

const UPDATE_INTERVAL_MS = 60 * 1000;

async function fetchMagicEdenSolSlugsStats(): Promise<any> {
    const res = await fetch(MAGIC_EDEN_SOL_SLUGS_STATS_URL);

    if (!res.ok) {
        throw new Error('failed to fetch from API');
    }

    const data = await res.json();

    return data?.results ?? data;
}

async function fetchTensorSolSlugsStats(): Promise<any> {
    if (!process.env.TENSOR_API_KEY) {
        throw new Error('TENSOR_API_KEY is not configured.');
    }

    const res = await fetch(TENSOR_SOL_SLUGS_STATS_URL, {
        headers: {
            'x-tensor-api-key': process.env.TENSOR_API_KEY,
        },
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch Tensor stats: ${res.status}`);
    }

    const data = await res.json();
    const stats = data?.collections?.[0]?.stats;

    if (!stats) {
        throw new Error('Tensor response is missing collection stats.');
    }

    return stats;
}

async function updateFloorPriceChannel(client: Client, magicEdenStats: any) {
    const channel = client.channels.cache.get(config.priceChannel) as GuildChannel;

    if (!channel) {
        return;
    }

    const floorPriceLamports = Number(magicEdenStats?.floorPrice);

    if (!Number.isFinite(floorPriceLamports)) {
        console.log('Skipping floor price channel update: Magic Eden response is missing floorPrice.');
        return;
    }

    const price = floorPriceLamports / LAMPORTS_PER_SOL;
    await channel.setName(`Floor Price: ◎${price}`);
}

async function updateTotalVolumeChannel(client: Client, tensorStats: any) {
    const channel = client.channels.cache.get(config.volumeChannel) as GuildChannel;

    if (!channel) {
        return;
    }

    const volumeAllLamports = Number(tensorStats?.volumeAll);

    if (!Number.isFinite(volumeAllLamports)) {
        console.log('Skipping total volume channel update: Tensor response is missing volumeAll.');
        return;
    }

    const volume = numberWithCommas((Math.round(volumeAllLamports / LAMPORTS_PER_SOL)).toString());
    await channel.setName(`Total Volume: ◎${volume}`);
}

export async function startSlugStatChannels(client: Client): Promise<void> {
    try {
        await updateFloorPriceChannel(client, await fetchMagicEdenSolSlugsStats());
    } catch (err) {
        console.log(err);
    }

    try {
        await updateTotalVolumeChannel(client, await fetchTensorSolSlugsStats());
    } catch (err) {
        console.log(err);
    }

    setTimeout(() => startSlugStatChannels(client), UPDATE_INTERVAL_MS);
}
