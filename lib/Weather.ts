import {
    Message,
    MessageEmbed,
} from 'discord.js';

import * as moment from 'moment';

import fetch from 'node-fetch';

import { stringify } from 'querystring';

import { config } from './Config';

import { capitalizeAllWords } from './Utilities';

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

export async function handleWeather(msg: Message, query: string): Promise<void> {
    query = query.trim();

    /* Prevent leaking our IP */
    if (query.includes('auto:ip')) {
        query = '';
    }

    if (query === '') {
        msg.reply(`No location given. Try \`${config.prefix}weather\` help`);
        return;
    }

    const params = {
        q: query,
        appid: config.weatherApiKey,
        units: 'metric',
    };

    const url = `https://api.openweathermap.org/data/2.5/weather?${stringify(params)}`;

    try {
        const response = await fetch(url);

        const data = await response.json();

        if (data.cod !== 200) {
            msg.reply(data.message);
            return;
        }

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

        const unixTimestamp = Math.round(Date.now() / 1000);

        if (!weatherImage.day) {
            msg.reply(`Unhandled weather ${weather.description} (${weather.id})`);
        }

        const isDayTime = unixTimestamp > data.sys.sunrise && unixTimestamp < data.sys.sunset;

        const image = isDayTime ? weatherImage.day : weatherImage.night;

        const time = moment().utcOffset(data.timezone).format('hh:mm');

        const embed = new MessageEmbed()
            .setTitle(`${data.name}, ${data.sys.country} • ${capitalizeAllWords(weather.description)}`)
            .setFooter(`Lat: ${data.coord.lat}, Long: ${data.coord.lon}`)
            .setThumbnail(`attachment://${image}`)
            .addFields(
                {
                    name: 'Temperature',
                    value: getTempStr(data.main.temp),
                },
                {
                    name: 'Feels Like',
                    value: getTempStr(data.main.feels_like),
                },
                {
                    name: 'Humidity',
                    value: Math.round(data.main.humidity) + '%',
                },
                {
                    name: 'Wind',
                    value: `${toMph(data.wind.speed)} mph, ${Math.round(data.wind.speed)} km/h`,
                },
            )
            .attachFiles([ `images/${image}` ]);

        msg.channel.send(embed);
    } catch (err) {
        msg.reply(`Failed to get weather: ${err.toString()}`);
    }
}
