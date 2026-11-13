import assert from 'node:assert/strict';
import test from 'node:test';
import moment from 'moment';

import {
    buildWeatherEmbed,
    cleanWeatherQuery,
    compassDirection,
    fetchCurrentWeather,
    parseCoordinates,
    parseLocationHint,
    pickPlace,
    resolveLocation,
} from '../dist/Weather.js';

test('conversational filler is stripped without eating place names', () => {
    for (const [input, expected] of [
        ["what's the weather in nyc rn?", 'nyc'],
        ['weather like in London today', 'London'],
        ['in Paris, Texas', 'Paris, Texas'],
        ['Weatherford', 'Weatherford'],
        ['Bern', 'Bern'],
        ['Inverness', 'Inverness'],
        ['Fort Worth now', 'Fort Worth'],
        ['  SW1A   1AA ', 'SW1A 1AA'],
    ]) {
        assert.equal(cleanWeatherQuery(input), expected, input);
    }
});

test('coordinates are accepted directly and validated', () => {
    assert.deepEqual(parseCoordinates('51.5, -0.12'), { name: '51.500, -0.120', latitude: 51.5, longitude: -0.12 });
    assert.equal(parseCoordinates('-33.9 151.2')?.longitude, 151.2);
    assert.equal(parseCoordinates('95, 10'), null);
    assert.equal(parseCoordinates('10001'), null);
});

test('areas outrank same-named shops and amenities', () => {
    const place = pickPlace([
        { name: 'Paris Texas', addresstype: 'amenity', lat: '47.48', lon: '19.06',
            address: { city: 'Budapest', country: 'Hungary' } },
        { name: 'Paris', addresstype: 'town', lat: '33.66', lon: '-95.55',
            address: { town: 'Paris', county: 'Lamar County', state: 'Texas', country: 'United States' } },
    ]);
    assert.deepEqual(place, { name: 'Paris, Texas, United States', latitude: 33.66, longitude: -95.55 });

    const landmark = pickPlace([{ name: 'Eiffel Tower', addresstype: 'man_made', lat: '48.85', lon: '2.29',
        address: { city: 'Paris', state: 'Ile-de-France', country: 'France' } }]);
    assert.equal(landmark.name, 'Eiffel Tower, Paris, Ile-de-France, France');
    assert.equal(pickPlace([]), null);
});

test('model hints are validated', () => {
    assert.deepEqual(parseLocationHint('{"found":true,"query":" Birmingham, England ","country_code":"GB"}'),
        { query: 'Birmingham, England', countryCode: 'gb' });
    assert.deepEqual(parseLocationHint('{"found":true,"query":"Europe","country_code":"europe"}'),
        { query: 'Europe', countryCode: '' });
    assert.deepEqual(parseLocationHint('{"found":false,"query":"","country_code":""}'), { query: '', countryCode: '' });
    assert.equal(parseLocationHint('not json'), null);
});

test('the model rewrite is searched first, with its country', async () => {
    const urls = [];
    const place = await resolveLocation('test-zip 10001', {
        interpret: async () => ({ query: '10001, United States', countryCode: 'us' }),
        fetchJson: async url => {
            urls.push(new URL(url));
            return [{ name: '10001', addresstype: 'postcode', lat: '40.74', lon: '-73.99',
                address: { city: 'New York', state: 'New York', country: 'United States' } }];
        },
    });
    assert.equal(place.name, '10001, New York, United States');
    assert.equal(urls.length, 1);
    assert.equal(urls[0].searchParams.get('q'), '10001, United States');
    assert.equal(urls[0].searchParams.get('countrycodes'), 'us');
});

test('the raw text is searched when the model is unavailable, and results are cached', async () => {
    const queries = [];
    const deps = {
        interpret: async () => null,
        fetchJson: async url => {
            queries.push(new URL(url).searchParams.get('q'));
            return [{ name: 'Cachetown', addresstype: 'town', lat: '1', lon: '2', address: { country: 'Nowhere' } }];
        },
    };
    assert.equal((await resolveLocation('Cachetown', deps)).name, 'Cachetown, Nowhere');
    assert.equal((await resolveLocation('cachetown', deps)).name, 'Cachetown, Nowhere');
    assert.deepEqual(queries, ['Cachetown']);
});

test('nothing found returns null', async () => {
    const place = await resolveLocation('qwertyuiop zzz', {
        interpret: async () => ({ query: '', countryCode: '' }),
        fetchJson: async () => [],
    });
    assert.equal(place, null);
});

test('current conditions become an embed in local time', async () => {
    const weather = await fetchCurrentWeather({ name: 'X', latitude: 1, longitude: 2 }, async url => {
        const params = new URL(url).searchParams;
        assert.equal(params.get('timezone'), 'auto');
        assert.ok(params.get('current').includes('weather_code'));
        return {
            utc_offset_seconds: -21600,
            timezone_abbreviation: 'CST',
            current: { temperature_2m: 17.2, apparent_temperature: 13, relative_humidity_2m: 27,
                is_day: 0, weather_code: 63, cloud_cover: 88, wind_speed_10m: 12,
                wind_direction_10m: 225, wind_gusts_10m: 40 },
            daily: { temperature_2m_max: [18], temperature_2m_min: [7] },
        };
    });
    const embed = buildWeatherEmbed({ name: 'Paris, Texas, United States' }, weather,
        moment.utc('2026-11-13T22:25:00Z')).toJSON();
    assert.equal(embed.title, 'Paris, Texas, United States • Rain');
    assert.equal(embed.description, '🕒 Fri 4:25 PM CST');
    assert.ok(embed.thumbnail.url.endsWith('rainy-5.png'));
    const fields = Object.fromEntries(embed.fields.map(field => [field.name, field.value]));
    assert.equal(fields.Temperature, '63°F / 17°C');
    assert.equal(fields.Wind, '7 mph / 12 km/h SW\nGusts 25 mph / 40 km/h');
    assert.equal(fields.Today, '↑ 64°F / 18°C\n↓ 45°F / 7°C');
});

test('compass directions wrap', () => {
    assert.equal(compassDirection(0), 'N');
    assert.equal(compassDirection(359), 'N');
    assert.equal(compassDirection(90), 'E');
    assert.equal(compassDirection(-45), 'NW');
});
