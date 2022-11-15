import {
    Message,
    EmbedBuilder,
} from 'discord.js';

import moment from 'moment';

import fetch from 'node-fetch';

import { stringify } from 'querystring';

import { config } from './Config.js';

import { capitalizeAllWords } from './Utilities.js';

import {
    Paginate,
    DisplayType,
} from './Paginate.js';

export interface IWeatherIcon {
    day: string;
    night: string;
}

export interface IWeatherIcons {
    [weatherCode: number]: IWeatherIcon;
}

export const weatherIconMapping: IWeatherIcons = {
    '200': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '201': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '202': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '210': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '211': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '212': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '221': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '230': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '231': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '232': {
        day: 'thunder.png',
        night: 'thunder.png',
    },
    '300': {
        day: 'rainy-1.png',
        night: 'rainy-5.png',
    },
    '301': {
        day: 'rainy-1.png',
        night: 'rainy-5.png',
    },
    '302': {
        day: 'rainy-2.png',
        night: 'rainy-4.png',
    },
    '310': {
        day: 'rainy-1.png',
        night: 'rainy-5.png',
    },
    '311': {
        day: 'rainy-2.png',
        night: 'rainy-4.png',
    },
    '312': {
        day: 'rainy-3.png',
        night: 'rainy-5.png',
    },
    '313': {
        day: 'rainy-2.png',
        night: 'rainy-4.png',
    },
    '314': {
        day: 'rainy-3.png',
        night: 'rainy-5.png',
    },
    '321': {
        day: 'rainy-2.png',
        night: 'rainy-4.png',
    },
    '500': {
        day: 'rainy-2.png',
        night: 'rainy-4.png',
    },
    '501': {
        day: 'rainy-3.png',
        night: 'rainy-5.png',
    },
    '502': {
        day: 'rainy-6.png',
        night: 'rainy-6.png',
    },
    '503': {
        day: 'rainy-6.png',
        night: 'rainy-6.png',
    },
    '504': {
        day: 'rainy-6.png',
        night: 'rainy-6.png',
    },
    '511': {
        day: 'rainy-7.png',
        night: 'rainy-7.png',
    },
    '520': {
        day: 'rainy-1.png',
        night: 'rainy-5.png',
    },
    '521': {
        day: 'rainy-2.png',
        night: 'rainy-4.png',
    },
    '522': {
        day: 'rainy-3.png',
        night: 'rainy-5.png',
    },
    '531': {
        day: 'rainy-2.png',
        night: 'rainy-4.png',
    },
    '600': {
        day: 'snowy-2.png',
        night: 'snowy-4.png',
    },
    '601': {
        day: 'snowy-3.png',
        night: 'snowy-5.png',
    },
    '602': {
        day: 'snowy-6.png',
        night: 'snowy-6.png',
    },
    '611': {
        day: 'rainy-7.png',
        night: 'rainy-7.png',
    },
    '612': {
        day: 'rainy-7.png',
        night: 'rainy-7.png',
    },
    '613': {
        day: 'rainy-7.png',
        night: 'rainy-7.png',
    },
    '615': {
        day: 'rainy-7.png',
        night: 'rainy-7.png',
    },
    '616': {
        day: 'rainy-7.png',
        night: 'rainy-7.png',
    },
    '620': {
        day: 'snowy-2.png',
        night: 'snowy-4.png',
    },
    '621': {
        day: 'snowy-2.png',
        night: 'snowy-4.png',
    },
    '622': {
        day: 'snowy-6.png',
        night: 'snowy-6.png',
    },
    '701': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '711': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '721': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '731': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '741': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '751': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '761': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '762': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '771': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '781': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
    '800': {
        day: 'day.png',
        night: 'night.png',
    },
    '801': {
        day: 'cloudy-day-1.png',
        night: 'cloudy-night-1.png',
    },
    '802': {
        day: 'cloudy-day-2.png',
        night: 'cloudy-night-2.png',
    },
    '803': {
        day: 'cloudy-day-3.png',
        night: 'cloudy-night-3.png',
    },
    '804': {
        day: 'cloudy.png',
        night: 'cloudy.png',
    },
};

function displayWeather(embed: EmbedBuilder, data: any, cityData: any) {
    embed.setFields([]);

    const weather = data.weather[0];

    const toF = (temp: number) => {
        return Math.round((temp * 1.8) + 32);
    }

    const toMph = (kph: number) => {
        return Math.round(kph / 1.609344);
    }

    const getTempStr = (c: number) => {
        return `${toF(c)}°F, ${Math.round(c)}°C`;
    }

    const weatherImage = weatherIconMapping[weather.id as number];

    if (!weatherImage.day) {
        throw new Error(`Unhandled weather ${weather.description} (${weather.id})`);
    }

    /* Timezone offset is given in seconds, convert it to minutes for moment. */
    const minuteOffset = cityData.timezone / 60;

    const forecastTime = moment.unix(data.dt).utcOffset(minuteOffset);

    const image = forecastTime.hour() > 6 && forecastTime.hour() < 18
        ? weatherImage.day
        : weatherImage.night;

    embed.setTitle(`${cityData.name}, ${cityData.country} • ${capitalizeAllWords(weather.description)}`)
        /* We can't use local images with attachment:// since there is no
         * way to remove an attachment - so changing images doesn't work. */
        .setThumbnail(config.imageHostPath + image)
        .addFields(
            {
                name: 'Local Time',
                value: forecastTime.format('ddd, hA'),
                inline: true,
            },
            {
                name: 'Temperature',
                value: getTempStr(data.main.temp),
                inline: true,
            },
            {
                name: 'Feels Like',
                value: getTempStr(data.main.feels_like),
                inline: true,
            },
            {
                name: 'Humidity',
                value: Math.round(data.main.humidity) + '%',
                inline: true,
            },
            {
                name: 'Wind',
                value: `${toMph(data.wind.speed)} mph, ${Math.round(data.wind.speed)} km/h`,
                inline: true,
            },
            {
                name: 'Cloudiness',
                value: Math.round(data.clouds.all) + '%',
                inline: true,
            },
        );
}

export async function handleWeather(msg: Message, args: string): Promise<void> {
    let query = args.trim();

    /* Prevent leaking our IP */
    if (query.includes('auto:ip')) {
        query = '';
    }

    if (query === '') {
        msg.reply(`No location given. Try \`${config.prefix}weather help\``);
        return;
    }

    const params = {
        q: query,
        appid: config.weatherApiKey,
        units: 'metric',
    };

    const url = `https://api.openweathermap.org/data/2.5/forecast?${stringify(params)}`;

    try {
        const response = await fetch(url);

        const data = await response.json();

        if (data.cod !== '200') {
            msg.reply(data.message);
            return;
        }

        const cityData = data.city;

        const embed = new EmbedBuilder();

        const pages = new Paginate({
            sourceMessage: msg,
            embed,
            data: data.list,
            displayType: DisplayType.EmbedData,
            displayFunction: (item: any, embed: EmbedBuilder) => {
                displayWeather(embed, item, cityData);
            }
        });

        await pages.sendMessage();
    } catch (err) {
        msg.reply(`Failed to get weather: ${(err as any).toString()}`);
    }
}
