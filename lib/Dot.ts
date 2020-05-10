import { Image } from 'canvas';

export const dot_w = 120;
export const dot_h = 120;

const shadowBlur = 2.75;
export var shadowSvg = `<svg xmlns='http://www.w3.org/2000/svg' preserveAspectRatio='xMidYMid meet' width='${dot_w}' height='${dot_h}' style='opacity:0.7'>
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
    let dotSvg = `<svg xmlns='http://www.w3.org/2000/svg' id='svgel${i}' preserveAspectRatio='xMidYMid meet' width='${dot_w}' height='${dot_h}'>
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
    img.width = dot_w;
    img.height = dot_h;
    img.onload = () => dotImages[i] = img;
    img.src = `data:image/svg+xml;base64,${Buffer.from(dotSvg).toString('base64')}`;
}

export var dotColors: any[] = [
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