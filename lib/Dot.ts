import fetch from 'node-fetch';

import { Canvas, createCanvas } from 'canvas';

import { RGB } from './Types.js';

import {
    hexToRGB,
    rgbToHex
} from './Utilities.js';

const DOT_WIDTH = 120;
const DOT_HEIGHT = 120;

const DOT_GRAPH_WIDTH = 400;
const DOT_GRAPH_HEIGHT = 150;

const SHADOW_BLUR = 2.75;

const GCP2_API_URL = 'https://rng.observer/api/gcp2';
const GCP2_CACHE_MS = 5000;
const DOT_GRAPH_MAX_TIMESPAN = 86400;
const DOT_GRAPH_MIN_CORE_HEIGHT = 1.1 / DOT_GRAPH_HEIGHT;
const DOT_GRAPH_MIN_FADE_HEIGHT = 3.5 / DOT_GRAPH_HEIGHT;
const DOT_GRAPH_SMOOTH_RADIUS = 2;
const DOT_GRAPH_SPINE_WIDTH = 1.4;

const GRAPH_COLOR_STOPS: { offset: number, color: string }[] = [
    { offset: 0.00, color: '#FF00FF' },
    { offset: 0.01, color: '#FF0000' },
    { offset: 0.035, color: '#FF4000' },
    { offset: 0.06, color: '#FF7500' },
    { offset: 0.11, color: '#FFB000' },
    { offset: 0.22, color: '#FFFF00' },
    { offset: 0.50, color: '#00DF00' },
    { offset: 0.90, color: '#00DF00' },
    { offset: 0.94, color: '#00EEFF' },
    { offset: 0.99, color: '#0034F4' },
    { offset: 1.00, color: '#440088' },
];

const COLORS: {color1: string, color2: string}[] = [
    {color1: '#CDCDCD', color2: '#505050'},
    {color1: '#FFA8C0', color2: '#FF0064'},
    {color1: '#FF1E1E', color2: '#840607'},
    {color1: '#FFB82E', color2: '#C95E00'},
    {color1: '#FFD517', color2: '#C69000'},
    {color1: '#FFFA40', color2: '#C6C300'},
    {color1: '#F9FA00', color2: '#B0CC00'},
    {color1: '#AEFA00', color2: '#88C200'},
    {color1: '#64FA64', color2: '#00A700'},
    {color1: '#64FAAB', color2: '#00B5C9'},
    {color1: '#ACF2FF', color2: '#21BCF1'},
    {color1: '#0EEEFF', color2: '#0786E1'},
    {color1: '#24CBFD', color2: '#0000FF'},
    {color1: '#5655CA', color2: '#2400A0'}
];

// generate dot color stops
let DOT_IMAGES: Canvas[] = [];
let DOT_COLORS: { tail: number, mc: Canvas }[] = [];

interface Gcp2Aggregate {
    end_epoch: number | string
    netvar_aggregate: string
}

interface Gcp2Response {
    currentNetvar?: {
        netvar?: { netvar: string }[]
    }
    netvarAggregate24H?: {
        aggregates?: Gcp2Aggregate[]
    }
}

interface DotGraphPoint {
    epoch: number
    value: number
}

interface DotGraphRenderPoint extends DotGraphPoint {
    index: number
}

interface DotGraphBand {
    top: number
    bottom: number
    q1: number
    q3: number
    a: number
}

let gcp2Cache: { expiresAt: number, promise: Promise<Gcp2Response> } | undefined;

export async function initDot() {
    if (DOT_IMAGES.length === 0) {
        DOT_IMAGES = await generateDotImages();
        DOT_COLORS = [
            {tail: 0.00,    mc: DOT_IMAGES[1]},
            {tail: 0.01,    mc: DOT_IMAGES[2]},
            {tail: 0.05,    mc: DOT_IMAGES[3]},
            {tail: 0.08,    mc: DOT_IMAGES[4]},
            {tail: 0.15,    mc: DOT_IMAGES[5]},
            {tail: 0.23,    mc: DOT_IMAGES[6]},
            {tail: 0.30,    mc: DOT_IMAGES[7]},
            {tail: 0.40,    mc: DOT_IMAGES[8]},
            {tail: 0.90,    mc: DOT_IMAGES[9]},
            {tail: 0.9125,  mc: DOT_IMAGES[10]},
            {tail: 0.93,    mc: DOT_IMAGES[11]},
            {tail: 0.98,    mc: DOT_IMAGES[12]},
            {tail: 1.00,    mc: DOT_IMAGES[13]}
        ];
    }
}

async function generateDotImages(): Promise<Canvas[]> {
    const images: Canvas[] = [];

    for (const { color1, color2 } of COLORS) {
        const dotCanvas = createCanvas(DOT_WIDTH, DOT_HEIGHT);
        const ctx = dotCanvas.getContext('2d');

        // soft drop shadow
        ctx.save();
        ctx.filter = `blur(${SHADOW_BLUR}px)`;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.arc(DOT_WIDTH / 2, DOT_HEIGHT * 0.49, DOT_WIDTH * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // base gradient
        const grad = ctx.createRadialGradient(
            DOT_WIDTH * 0.3,
            DOT_HEIGHT * 0.9,
            0,
            DOT_WIDTH * 0.5,
            DOT_HEIGHT * 0.45,
            DOT_WIDTH * 0.55
        );
        grad.addColorStop(0, color1);
        grad.addColorStop(1, color2);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(DOT_WIDTH / 2, DOT_HEIGHT * 0.45, DOT_WIDTH * 0.45, 0, Math.PI * 2);
        ctx.fill();

        // glossy highlight on top
        ctx.save();
        ctx.beginPath();
        ctx.arc(DOT_WIDTH / 2, DOT_HEIGHT * 0.4, DOT_WIDTH * 0.37, 0, Math.PI * 2);
        ctx.clip();

        const highlight = ctx.createRadialGradient(
            DOT_WIDTH * 0.5,
            DOT_HEIGHT * 0.1,
            0,
            DOT_WIDTH * 0.5,
            DOT_HEIGHT * 0.1,
            DOT_WIDTH * 0.6
        );
        highlight.addColorStop(0, 'rgba(255,255,255,0.95)');
        highlight.addColorStop(0.6, 'rgba(255,255,255,0.35)');
        highlight.addColorStop(1, 'rgba(255,255,255,0)');

        ctx.filter = 'blur(6px)';
        ctx.fillStyle = highlight;
        ctx.fillRect(0, 0, DOT_WIDTH, DOT_HEIGHT);
        ctx.restore();

        images.push(dotCanvas);
    }

    return images;
}

async function fetchGcp2Data(): Promise<Gcp2Response> {
    const now = Date.now();

    if (gcp2Cache && gcp2Cache.expiresAt > now) {
        return gcp2Cache.promise;
    }

    const promise = (async () => {
        const response = await fetch(GCP2_API_URL, {
            headers: {
                accept: 'application/json',
                'user-agent': 'dave-discord-bot/1.1',
            },
        });

        const body = await response.text();

        if (!response.ok) {
            throw new Error(`GCP 2.0 API returned ${response.status} ${response.statusText}`);
        }

        try {
            const parsed = JSON.parse(body);

            if (!parsed || typeof parsed !== 'object') {
                throw new Error('response root is not an object');
            }

            return parsed as Gcp2Response;
        } catch (err) {
            throw new Error(`GCP 2.0 API returned invalid JSON: ${(err as Error).message}`);
        }
    })();

    gcp2Cache = {
        expiresAt: now + GCP2_CACHE_MS,
        promise,
    };

    try {
        return await promise;
    } catch (err) {
        if (gcp2Cache?.promise === promise) {
            gcp2Cache = undefined;
        }

        throw err;
    }
}

function finiteNumber(value: unknown): number | null {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function parseHistory(data: Gcp2Response): DotGraphPoint[] {
    const aggregates = data.netvarAggregate24H?.aggregates;

    if (!Array.isArray(aggregates)) {
        throw new Error('GCP 2.0 API response is missing 24h graph data');
    }

    const history = aggregates.flatMap((item) => {
        const epoch = finiteNumber(item.end_epoch);
        const value = finiteNumber(item.netvar_aggregate);

        return epoch === null || value === null ? [] : [{ epoch, value }];
    }).sort((a, b) => a.epoch - b.epoch);

    if (history.length === 0) {
        throw new Error('GCP 2.0 API response did not include usable graph data');
    }

    return history;
}

function getCurrentNetvar(data: Gcp2Response, history: DotGraphPoint[]): number {
    const currentNetvar = finiteNumber(data.currentNetvar?.netvar?.[0]?.netvar);

    if (currentNetvar !== null) {
        return currentNetvar;
    }

    return history[history.length - 1].value;
}

function calculatePercentile(value: number, history: DotGraphPoint[]): number {
    const sorted = history.map((point) => point.value).sort((a, b) => a - b);
    let count = 0;

    for (const item of sorted) {
        if (item <= value) {
            count++;
        } else {
            break;
        }
    }

    return clamp(count / sorted.length, 0, 1);
}

async function getDotStats(): Promise<{ currentNetvar: number, currentDotValue: number, history: DotGraphPoint[] }> {
    const data = await fetchGcp2Data();
    const history = parseHistory(data);
    const currentNetvar = getCurrentNetvar(data, history);

    return {
        currentNetvar,
        currentDotValue: calculatePercentile(currentNetvar, history),
        history,
    };
}

function renderDotCanvas(currentDotValue: number): [string, Canvas] {
    const dotValue = clamp(currentDotValue, 0, 1);

    const dotCanvas = createCanvas(DOT_WIDTH, DOT_HEIGHT);
    const dotContext = dotCanvas.getContext('2d');

    let blendRGB: RGB = {r: 255, g: 255, b: 255};
    for (let i = 0; i < DOT_COLORS.length - 1; i++) {
        const opacity = (dotValue - DOT_COLORS[i].tail) / (DOT_COLORS[i + 1].tail - DOT_COLORS[i].tail);

        if (opacity >= 0 && opacity <= 1) {
            blendRGB = hexToRGB(COLORS[i + 1].color2);
            dotContext.drawImage(DOT_COLORS[i].mc, 0, 0);

            if (DOT_COLORS[i].mc !== DOT_COLORS[i + 1].mc) {
                const color_RGB = hexToRGB(COLORS[i + 2].color2);
                const inv_opacity = 1 - opacity;

                blendRGB.r = Math.floor(
                  color_RGB.r * opacity + inv_opacity * blendRGB.r
                );
                blendRGB.g = Math.floor(
                  color_RGB.g * opacity + inv_opacity * blendRGB.g
                );
                blendRGB.b = Math.floor(
                  color_RGB.b * opacity + inv_opacity * blendRGB.b
                );

                dotContext.globalAlpha = opacity;
                dotContext.drawImage(DOT_COLORS[i + 1].mc, 0, 0);
            }

            break;
        }
    }

    return [ rgbToHex(blendRGB), dotCanvas ];
}

export async function renderDot(): Promise<[string, number, Canvas]> {
    const { currentDotValue } = await getDotStats();
    const [ currentDotColor, dotCanvas ] = renderDotCanvas(currentDotValue);

    return [ currentDotColor, currentDotValue, dotCanvas ];
};

function selectGraphPoints(history: DotGraphPoint[], timespan: number): DotGraphPoint[] {
    const latestEpoch = history[history.length - 1].epoch;
    const requestedTimespan = Math.abs(timespan) || DOT_GRAPH_MAX_TIMESPAN;
    const graphTimespan = Math.min(requestedTimespan, DOT_GRAPH_MAX_TIMESPAN);
    const cutoff = latestEpoch - Math.max(graphTimespan, 60);
    const points = history.filter((point) => point.epoch >= cutoff);

    if (points.length >= 2) {
        return points;
    }

    return history.slice(-Math.min(history.length, 2));
}

function calculateVariance(values: number[]): number {
    if (values.length < 2) {
        return 0;
    }

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const numerator = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0);

    return numerator / (values.length - 1);
}

function upperBound(values: number[], target: number): number {
    let low = 0;
    let high = values.length;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);

        if (values[mid] <= target) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return low;
}

function calculateGraphIndex(value: number, sortedValues: number[]): number {
    return clamp(upperBound(sortedValues, value) / sortedValues.length, 0, 1);
}

function getGraphPoints(points: DotGraphPoint[], history: DotGraphPoint[]): DotGraphRenderPoint[] {
    const sortedValues = history.map((point) => point.value).sort((a, b) => a - b);

    return points.map((point) => ({
        ...point,
        index: calculateGraphIndex(point.value, sortedValues),
    }));
}

function interpolateGraphIndex(points: DotGraphRenderPoint[], epoch: number): number {
    if (points.length === 1 || epoch <= points[0].epoch) {
        return points[0].index;
    }

    const lastPoint = points[points.length - 1];

    if (epoch >= lastPoint.epoch) {
        return lastPoint.index;
    }

    let low = 0;
    let high = points.length - 1;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);

        if (points[mid].epoch < epoch) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    const nextPoint = points[low];
    const previousPoint = points[low - 1];
    const epochRange = nextPoint.epoch - previousPoint.epoch;

    if (epochRange <= 0) {
        return nextPoint.index;
    }

    const ratio = (epoch - previousPoint.epoch) / epochRange;

    return previousPoint.index + (nextPoint.index - previousPoint.index) * ratio;
}

function quantile(sortedValues: number[], q: number): number {
    if (sortedValues.length === 1) {
        return sortedValues[0];
    }

    const position = (sortedValues.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const ratio = position - lower;

    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * ratio;
}

function getGraphBand(values: number[]): DotGraphBand {
    const sorted = values.sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = quantile(sorted, 0.5);
    const q1Value = quantile(sorted, 0.25);
    const q3Value = quantile(sorted, 0.75);
    const coreHalfHeight = Math.max((q3Value - q1Value) / 2, DOT_GRAPH_MIN_CORE_HEIGHT);
    const fadeHalfHeight = Math.max((max - min) * 0.55, coreHalfHeight + DOT_GRAPH_MIN_FADE_HEIGHT);
    const top = clamp(median - fadeHalfHeight, 0, 1);
    const bottom = clamp(median + fadeHalfHeight, 0, 1);

    return {
        top,
        bottom,
        q1: clamp(median - coreHalfHeight, top, bottom),
        q3: clamp(median + coreHalfHeight, top, bottom),
        a: median,
    };
}

function smoothGraphBands(bands: DotGraphBand[]): DotGraphBand[] {
    const smoothed = bands.map((band, index) => {
        let weightTotal = 0;
        let center = 0;
        let coreHalfHeight = 0;
        let fadeHalfHeight = 0;

        for (let offset = DOT_GRAPH_SMOOTH_RADIUS * -1; offset <= DOT_GRAPH_SMOOTH_RADIUS; offset++) {
            const sampleIndex = Math.max(0, Math.min(bands.length - 1, index + offset));
            const sample = bands[sampleIndex];
            const weight = DOT_GRAPH_SMOOTH_RADIUS + 1 - Math.abs(offset);

            weightTotal += weight;
            center += sample.a * weight;
            coreHalfHeight += ((sample.q3 - sample.q1) / 2) * weight;
            fadeHalfHeight += ((sample.bottom - sample.top) / 2) * weight;
        }

        center /= weightTotal;
        coreHalfHeight = Math.max(coreHalfHeight / weightTotal, DOT_GRAPH_MIN_CORE_HEIGHT);
        fadeHalfHeight = Math.max(fadeHalfHeight / weightTotal, coreHalfHeight + DOT_GRAPH_MIN_FADE_HEIGHT);

        const top = clamp(center - fadeHalfHeight, 0, 1);
        const bottom = clamp(center + fadeHalfHeight, 0, 1);

        return {
            top,
            bottom,
            q1: clamp(center - coreHalfHeight, top, bottom),
            q3: clamp(center + coreHalfHeight, top, bottom),
            a: center,
        };
    });

    return smoothed.map((band, index) => {
        const previous = smoothed[Math.max(0, index - 1)];
        const next = smoothed[Math.min(smoothed.length - 1, index + 1)];
        const coreHalfHeight = Math.max((band.q3 - band.q1) / 2, DOT_GRAPH_MIN_CORE_HEIGHT);
        const topCenter = Math.min(previous.a, band.a, next.a);
        const bottomCenter = Math.max(previous.a, band.a, next.a);
        const top = clamp(Math.min(band.top, topCenter - DOT_GRAPH_MIN_FADE_HEIGHT), 0, 1);
        const bottom = clamp(Math.max(band.bottom, bottomCenter + DOT_GRAPH_MIN_FADE_HEIGHT), 0, 1);

        return {
            top,
            bottom,
            q1: clamp(Math.min(band.q1, topCenter - coreHalfHeight), top, bottom),
            q3: clamp(Math.max(band.q3, bottomCenter + coreHalfHeight), top, bottom),
            a: band.a,
        };
    });
}

function synthesizeGraphBands(points: DotGraphPoint[], history: DotGraphPoint[]): DotGraphBand[] {
    const graphPoints = getGraphPoints(points, history);
    const firstEpoch = graphPoints[0].epoch;
    const lastEpoch = graphPoints[graphPoints.length - 1].epoch;
    const epochRange = lastEpoch - firstEpoch || 1;
    const bands: DotGraphBand[] = [];
    let pointIndex = 0;

    for (let x = 0; x < DOT_GRAPH_WIDTH; x++) {
        const startEpoch = firstEpoch + (x / DOT_GRAPH_WIDTH) * epochRange;
        const endEpoch = x === DOT_GRAPH_WIDTH - 1
            ? lastEpoch
            : firstEpoch + ((x + 1) / DOT_GRAPH_WIDTH) * epochRange;
        const midpointEpoch = startEpoch + (endEpoch - startEpoch) / 2;
        const values = [interpolateGraphIndex(graphPoints, midpointEpoch)];

        while (pointIndex < graphPoints.length && graphPoints[pointIndex].epoch < startEpoch) {
            pointIndex++;
        }

        for (let i = pointIndex; i < graphPoints.length && graphPoints[i].epoch <= endEpoch; i++) {
            values.push(graphPoints[i].index);
        }

        bands.push(getGraphBand(values));
    }

    return smoothGraphBands(bands);
}

function drawGraphSpine(context: ReturnType<Canvas['getContext']>, graphData: DotGraphBand[], background: CanvasGradient): void {
    context.save();
    context.strokeStyle = background;
    context.globalAlpha = 0.92;
    context.lineWidth = DOT_GRAPH_SPINE_WIDTH;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.beginPath();

    for (let x = 0; x < graphData.length; x++) {
        const y = clamp(graphData[x].a, 0, 1) * DOT_GRAPH_HEIGHT;

        if (x === 0) {
            context.moveTo(x, y);
        } else {
            context.lineTo(x, y);
        }
    }

    context.stroke();
    context.restore();
}

function renderGraphCanvas(points: DotGraphPoint[], history: DotGraphPoint[]): Canvas {
    const inv_ch = 1.0 / DOT_GRAPH_HEIGHT;
    const canvasData = createCanvas(DOT_GRAPH_WIDTH, DOT_GRAPH_HEIGHT);
    const context = canvasData.getContext('2d');
    const outCanvas = createCanvas(DOT_GRAPH_WIDTH, DOT_GRAPH_HEIGHT);
    const outContext = outCanvas.getContext('2d');
    const background = context.createLinearGradient(0, 0, 0, DOT_GRAPH_HEIGHT);
    const graphData = synthesizeGraphBands(points, history);

    for (const stop of GRAPH_COLOR_STOPS) {
        background.addColorStop(stop.offset, stop.color);
    }

    context.fillStyle = background;
    context.fillRect(0, 0, DOT_GRAPH_WIDTH, DOT_GRAPH_HEIGHT);

    const imgBuffer = context.getImageData(0, 0, DOT_GRAPH_WIDTH, DOT_GRAPH_HEIGHT);

    for (let i = 3; i < imgBuffer.data.length; i += 4) {
        imgBuffer.data[i] = 0;
    }

    for (let x = 0; x < graphData.length; x++) {
        let { top } = graphData[x];
        const { bottom, q1, q3 } = graphData[x];

        if ((bottom - top) < inv_ch && top > 0.5) {
            top -= inv_ch;
        }

        const startY = Math.max(0, Math.floor(top * DOT_GRAPH_HEIGHT));
        const endY = Math.min(DOT_GRAPH_HEIGHT, Math.ceil(bottom * DOT_GRAPH_HEIGHT));

        for (let y = startY; y < endY; y++) {
            const ys = y / DOT_GRAPH_HEIGHT;
            let alpha = 0;

            if ((ys > q1 && ys <= q3) || (bottom - top) < inv_ch * 1.5) {
                alpha = 1;
            } else if (ys > top && ys <= q1) {
                alpha = q1 === top ? 1 : (ys - top) / (q1 - top);
            } else if (ys > q3 && ys <= bottom) {
                alpha = q3 === bottom ? 1 : (bottom - ys) / (bottom - q3);
            }

            const alphaIndex = (x + y * DOT_GRAPH_WIDTH) * 4 + 3;
            imgBuffer.data[alphaIndex] = Math.max(imgBuffer.data[alphaIndex], 255 * alpha);
        }
    }

    context.putImageData(imgBuffer, 0, 0);
    drawGraphSpine(context, graphData, background);

    outContext.fillStyle = '#2F3136';
    outContext.fillRect(0, 0, outCanvas.width, outCanvas.height);
    outContext.drawImage(canvasData, 0, 0);

    return outCanvas;
}

export async function renderDotGraph(timespan: number): Promise<[ number, Canvas ]> {
    const { history } = await getDotStats();
    const graphPoints = selectGraphPoints(history, timespan);
    const values = synthesizeGraphBands(graphPoints, history).map((point) => point.a);
    const variance = calculateVariance(values);

    return [ variance, renderGraphCanvas(graphPoints, history) ];
}

// the following code is a bunch of util garbo for doing gaussian blur
const mul_table = [
    512,512,456,512,328,456,335,512,405,328,271,456,388,335,292,512,
    454,405,364,328,298,271,496,456,420,388,360,335,312,292,273,512,
    482,454,428,405,383,364,345,328,312,298,284,271,259,496,475,456,
    437,420,404,388,374,360,347,335,323,312,302,292,282,273,265,512,
    497,482,468,454,441,428,417,405,394,383,373,364,354,345,337,328,
    320,312,305,298,291,284,278,271,265,259,507,496,485,475,465,456,
    446,437,428,420,412,404,396,388,381,374,367,360,354,347,341,335,
    329,323,318,312,307,302,297,292,287,282,278,273,269,265,261,512,
    505,497,489,482,475,468,461,454,447,441,435,428,422,417,411,405,
    399,394,389,383,378,373,368,364,359,354,350,345,341,337,332,328,
    324,320,316,312,309,305,301,298,294,291,287,284,281,278,274,271,
    268,265,262,259,257,507,501,496,491,485,480,475,470,465,460,456,
    451,446,442,437,433,428,424,420,416,412,408,404,400,396,392,388,
    385,381,377,374,370,367,363,360,357,354,350,347,344,341,338,335,
    332,329,326,323,320,318,315,312,310,307,304,302,299,297,294,292,
    289,287,285,282,280,278,275,273,271,269,267,265,263,261,259
];

const shg_table = [
     9, 11, 12, 13, 13, 14, 14, 15, 15, 15, 15, 16, 16, 16, 16, 17,
    17, 17, 17, 17, 17, 17, 18, 18, 18, 18, 18, 18, 18, 18, 18, 19,
    19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 20, 20, 20,
    20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 22, 22, 22, 22, 22, 22,
    22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22,
    22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 23,
    23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
    23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
    23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
    23, 23, 23, 23, 23, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24
];

class BlurStack {
    public a: number
    public next: any
    constructor() {
        this.a = 0;
        this.next = null;
    }
}

function stackBlurCanvasAlpha(pixels: any, width: number, height: number, radius: number) {
    if (isNaN(radius) || radius < 1) {
        return;
    }

    radius |= 0;

    const div = radius + radius + 1;
    const w4 = width << 2;
    const widthMinus1  = width - 1;
    const heightMinus1 = height - 1;
    const radiusPlus1  = radius + 1;
    const sumFactor = radiusPlus1 * (radiusPlus1 + 1) / 2;

    const stackStart = new BlurStack();
    let stack = stackStart;
    let stackEnd: BlurStack = new BlurStack();

    for (let i = 1; i < div; i++) {
        stack.next = new BlurStack();
        stack = stack.next;

        if (i == radiusPlus1) {
            stackEnd = stack;
        }
    }

    stack.next = stackStart;

    let stackIn = null;
    let stackOut = null;

    let yw = 0;
    let yi = 0;

    const mul_sum = mul_table[radius];
    const shg_sum = shg_table[radius];

    let p;
    let pa;

    let a_sum = 0;
    let a_in_sum = 0;
    let a_out_sum = 0;

    for (let y = 0; y < height; y++ ) {
        a_in_sum = 0;
        a_sum = 0;

        pa = pixels[yi + 3];

        a_out_sum = radiusPlus1 * pa;
        a_sum += sumFactor * pa;

        stack = stackStart;

        for (let i = 0; i < radiusPlus1; i++) {
            stack.a = pa;
            stack = stack.next;
        }

        for (let i = 1; i < radiusPlus1; i++) {
            p = yi + (( widthMinus1 < i ? widthMinus1 : i ) << 2 );
            pa = pixels[p + 3];
            stack.a = pa;
            a_sum += (pa * (radiusPlus1 - i));
            a_in_sum += pa;
            stack = stack.next;
        }

        stackIn = stackStart;
        stackOut = stackEnd;

        for (let x = 0; x < width; x++) {
            pixels[yi+3] = pa = (a_sum * mul_sum) >> shg_sum;
            a_sum -= a_out_sum;
            a_out_sum -= stackIn.a;
            p =  ( yw + ( ( p = x + radius + 1 ) < widthMinus1 ? p : widthMinus1 ) ) << 2;
            a_in_sum += ( stackIn.a = pixels[p+3]);
            a_sum += a_in_sum;
            stackIn = stackIn.next;
            a_out_sum += ( pa = stackOut.a );
            a_in_sum -= pa;
            stackOut = stackOut.next;
            yi += 4;
        }

        yw += width;
    }

    for (let x = 0; x < width; x++) {
        a_in_sum = 0;
        a_sum = 0;

        yi = x << 2;
        pa = pixels[yi + 3];
        a_out_sum = radiusPlus1 * pa;
        a_sum += sumFactor * pa;
        stack = stackStart;

        for(let i = 0; i < radiusPlus1; i++) {
            stack.a = pa;
            stack = stack.next;
        }

        let yp = width;

        for(let i = 1; i <= radius; i++) {
            yi = ( yp + x ) << 2;
            a_sum += (stack.a = ( pa = pixels[yi+3])) * (radiusPlus1 - i);
            a_in_sum += pa;
            stack = stack.next;

            if (i < heightMinus1)
            {
                yp += width;
            }
        }

        yi = x;
        stackIn = stackStart;
        stackOut = stackEnd;

        for (let y = 0; y < height; y++) {
            p = yi << 2;
            pixels[p+3] = pa = (a_sum * mul_sum) >> shg_sum;

            if (pa > 0) {
                pa = 255 / pa;
            }

            a_sum -= a_out_sum;
            a_out_sum -= stackIn.a;

            p = ( x + (( ( p = y + radiusPlus1) < heightMinus1 ? p : heightMinus1 ) * width )) << 2;

            a_sum += ( a_in_sum += ( stackIn.a = pixels[p+3]));

            stackIn = stackIn.next;

            a_out_sum += ( pa = stackOut.a );

            a_in_sum -= pa;

            stackOut = stackOut.next;

            yi += width;
        }
    }
}
