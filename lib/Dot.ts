import { Canvas, Image, createCanvas } from 'canvas';
import { xml2json } from 'xml-js';

import request = require('request-promise-native');

// dot autism, shitty code follows. enjoy.

const dotWidth = 120;
const dotHeight = 120;

const dotGraphWidth = 325;
const dotGraphHeight = 120;

const shadowBlur = 2.75;
const shadowSvg = `<svg xmlns='http://www.w3.org/2000/svg' preserveAspectRatio='xMidYMid meet' width='${dotWidth}' height='${dotHeight}' style='opacity:0.7'>
    <defs>
        <filter id='fh'>
            <feGaussianBlur in='SourceGraphic' stdDeviation='${shadowBlur} ${shadowBlur}' />
        </filter>
    </defs>
    <circle filter='url(#fh)' fill='black' cx='50%' cy='49%' r='45%'/>
</svg>`;

const colors: any[] = [
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

let dotImages: any[] = [];

for (let i = 0; i < colors.length; i++) {
    let dotSvg = `<svg xmlns='http://www.w3.org/2000/svg' id='svgel${i}' preserveAspectRatio='xMidYMid meet' width='${dotWidth}' height='${dotHeight}'>
        <defs>
            <filter id='f1'>
                <feGaussianBlur in='SourceGraphic' stdDeviation='9 3' />
            </filter>
            <radialGradient id='highlight' cy='5%' r='50%' gradientTransform='translate(-0.25 0) scale(1.5 1)'>
                <stop offset='10%' stop-color='white' stop-opacity='100'/>
                <stop offset='100%' stop-color='white' stop-opacity='0'/>
            </radialGradient>
            <radialGradient id='grad' cy='92%' r='60%' gradientTransform='translate(-0.2 0) scale(1.4 1)'>
                <stop offset='0%' stop-color='${colors[i].color1}'/>
                <stop offset='100%' stop-color='${colors[i].color2}'/>
            </radialGradient>
        </defs>
        <circle fill='url(#grad)' cx='50%' cy='45%' r='45%'/>
        <clipPath id='ic'>
            <circle cx='50%' cy='40%' r='37%' />
        </clipPath>
        <g filter='url(#f1)'>
            <circle fill='url(#highlight)' cx='50%' cy='50%' r='48%' clip-path='url(#ic)' />
        </g>
    </svg>`;

    let img = new Image();
    img.width = dotWidth;
    img.height = dotHeight;
    img.onload = () => dotImages[i] = img;
    img.src = `data:image/svg+xml;base64,${Buffer.from(dotSvg).toString('base64')}`;
}

const dotColors: any[] = [
    {tail: 0.00,    mc: dotImages[1]},
    {tail: 0.01,    mc: dotImages[2]},
    {tail: 0.05,    mc: dotImages[3]},
    {tail: 0.08,    mc: dotImages[4]},
    {tail: 0.15,    mc: dotImages[5]},
    {tail: 0.23,    mc: dotImages[6]},
    {tail: 0.30,    mc: dotImages[7]},
    {tail: 0.40,    mc: dotImages[8]},
    {tail: 0.90,    mc: dotImages[9]},
    {tail: 0.9125,  mc: dotImages[10]},
    {tail: 0.93,    mc: dotImages[11]},
    {tail: 0.98,    mc: dotImages[12]},
    {tail: 1.00,    mc: dotImages[13]}
];

export async function renderDot(): Promise<[number, Canvas]> {
    const dotXML = await request({
        method: 'GET',
        timeout: 10000,
        url: 'http://gcpdot.com/gcpindex.php',
    });

    const dotData = JSON.parse(xml2json(dotXML)).elements[0].elements;

    const serverTime = dotData[0].elements[0].text;
    let currentDotValue: number = 0;

    /* Server sends back a full minute of data, we only need the current second */
    for (const item of dotData[1].elements) {
        if (item.attributes.t === serverTime) {
            currentDotValue = Number(item.elements[0].text);
        }
    }

    const dotCanvas = createCanvas(dotWidth, dotHeight);
    const dotContext = dotCanvas.getContext('2d');

    const shadowImage = new Image();
    shadowImage.width = dotWidth;
    shadowImage.height = dotHeight;
    shadowImage.src = `data:image/svg+xml;base64,${Buffer.from(shadowSvg).toString('base64')}`;

    dotContext.fillStyle = 'rgba(255, 255, 255, 0)';
    dotContext.globalAlpha = 1.0;
    dotContext.drawImage(shadowImage, 0, 0);

    for (let i = 0; i < dotColors.length - 1; i++) {
        const opacity = (currentDotValue - dotColors[i].tail) / (dotColors[i + 1].tail - dotColors[i].tail);

        if (opacity >= 0 && opacity <= 1) {
            dotContext.drawImage(dotColors[i].mc, 0, 0);

            if (dotColors[i].mc !== dotColors[i + 1].mc) {
                dotContext.globalAlpha = opacity;
                dotContext.drawImage(dotColors[i + 1].mc, 0, 0);
            }

            break;
        }
    }

    return [ currentDotValue, dotCanvas ];
};

export async function renderDotGraph(): Promise<Canvas> {
    /* 1d */
    const timespan = -86400;

    const inv_ch = 1.0 / dotGraphHeight;
    const shadowOffset = 10;

    var canvasShadow = createCanvas(dotGraphWidth, dotGraphHeight+shadowOffset*2);
    var canvas = createCanvas(dotGraphWidth, dotGraphHeight);
    var contextShadow = canvasShadow.getContext('2d');
    var context = canvas.getContext('2d');
    var outCanvas = createCanvas(dotGraphWidth, dotGraphHeight+shadowOffset*2);
    var outContext = outCanvas.getContext("2d");

    const dotXML = await request({
        method: 'GET',
        timeout: 10000,
        url: `http://global-mind.org/gcpdot/gcpgraph.php?pixels=${dotGraphWidth}&seconds=${timespan}`,
    });

    const graphData = JSON.parse(xml2json(dotXML)).elements[0].elements;

    const svg = `<svg xmlns='http://www.w3.org/2000/svg' preserveAspectRatio='xMidYMid meet' width='${dotGraphWidth}' height='${dotGraphHeight}'>
        <defs>
            <linearGradient id='g' x1='0%' y1='0%' x2='0%' y2='100%'>
                <stop offset='0%'   style='stop-color:#FF00FF; stop-opacity:1'/>
                <stop offset='1%'   style='stop-color:#FF0000; stop-opacity:1'/>
                <stop offset='3.5%' style='stop-color:#FF4000; stop-opacity:1'/>
                <stop offset='6%'   style='stop-color:#FF7500; stop-opacity:1'/>
                <stop offset='11%'  style='stop-color:#FFB000; stop-opacity:1'/>
                <stop offset='22%'  style='stop-color:#FFFF00; stop-opacity:1'/>
                <stop offset='50%'  style='stop-color:#00df00; stop-opacity:1'/>
                <stop offset='90%'  style='stop-color:#00df00; stop-opacity:1'/>
                <stop offset='94%'  style='stop-color:#00EEFF; stop-opacity:1'/>
                <stop offset='99%'  style='stop-color:#0034F4; stop-opacity:1'/>
                <stop offset='100%' style='stop-color:#440088; stop-opacity:1'/>
            </linearGradient>
        </defs>
        <rect width='100%' height='100%' fill='url(#g)'/>
    </svg>`;

    const bgImage = new Image();
    bgImage.onload = () => context.drawImage(bgImage, 0, 0);
    bgImage.src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

    const imgBuffer = context.getImageData(0, 0, dotGraphWidth, dotGraphHeight);

    for (let y = 0; y < dotGraphHeight; y++) {
        for (let x = 0; x < dotGraphWidth; x++) {
            imgBuffer.data[(y * dotGraphWidth + x) * 4 + 3] = 0;
        }
    }

    const imgShadowBuffer = contextShadow.createImageData(bgImage.width + shadowOffset * 2, bgImage.height + shadowOffset * 2);

    for (let i = 0; i < graphData.length; i++) {
        graphData[i].top = Number(graphData[i].attributes.t);
        graphData[i].bottom = Number(graphData[i].attributes.b);
        graphData[i].q1 = Number(graphData[i].attributes.q1);
        graphData[i].q3 = Number(graphData[i].attributes.q3);

        if ((graphData[i].bottom - graphData[i].top) < inv_ch) {
            if (graphData[i].top > 0.5) {
                graphData[i].top -= inv_ch;
            }
        }

        for (let y = Math.floor(graphData[i].top * dotGraphHeight); y < graphData[i].bottom * dotGraphHeight; y++) {
            const ys = y / dotGraphHeight;
            let a = 0;

            if (ys > graphData[i].q1 && ys <= graphData[i].q3 || (graphData[i].bottom - graphData[i].top) < inv_ch * 1.5) {
                a = 1;
            } else if (ys > graphData[i].top && ys <= graphData[i].q1) {
                a = (ys - graphData[i].top) / (graphData[i].q1 - graphData[i].top);
            } else if (ys > graphData[i].q3 && ys <= graphData[i].bottom) {
                a = (graphData[i].bottom - ys) / (graphData[i].bottom - graphData[i].q3);
            }

            imgBuffer.data[(i + y * bgImage.width) * 4 + 3] = 255 * a;
            imgShadowBuffer.data[(i + (y + shadowOffset * 2) * (bgImage.width + shadowOffset * 2)) * 4 + 3] = Math.pow(a, 0.75) * 255;
        }
    }

    // blur the shadow
    stackBlurCanvasAlpha(imgShadowBuffer.data, bgImage.width + shadowOffset * 2, bgImage.height + shadowOffset * 2, 6);

    contextShadow.globalAlpha = 1.0;
    contextShadow.putImageData(imgShadowBuffer, shadowOffset, shadowOffset);

    context.globalAlpha = 1.0;
    context.putImageData(imgBuffer, 0, 0);

    outContext.fillStyle = '#525252';
    outContext.fillRect(0, 0, outCanvas.width, outCanvas.height);
    outContext.drawImage(canvasShadow, 0, 0);
    outContext.drawImage(canvas, 0, shadowOffset);

    return outCanvas;
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
