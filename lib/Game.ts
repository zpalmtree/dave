import { Canvas, createCanvas, loadImage } from 'canvas';
import { Message } from 'discord.js';
const boardSize = 20;
const tileSize = 9;
const max_name_len = 12;
const max_point_len = 12;
const window_scale = 2;
const score_scale = 3;
const score_width = ((max_name_len * 4 + 14) * 2 + 3) * score_scale;
const window_size = (boardSize + 2) * tileSize * window_scale;
const version = '0.0.1';
// for now the palette is hard-coded
// maybe in the future load the palette programmatically from ./images/gameAssets.png
const palette = [
	'#000000', '#595652', '#36393e', '#e97878', '#e61717', 
	'#a01818', '#fbc636', '#ff8e0f', '#c56800', '#ebf828',
	'#0088ff', '#1457c5', '#6dbbff', '#1ddbb9', '#1106c5',
	'#98e993', '#25bd1c', '#0a7c04', '#05997e', '#8f63e9',
	'#6a32df', '#eb95f0', '#d03ae9', '#b63690', '#750505',
	'#8a0a64', '#754209', '#a7a045', '#075703', '#b49ae9'];

interface tuple {
	x: number;
	y: number;
}

const avatars = [
	{x: 1,  y: 28},
	{x: 11, y: 28},
	{x: 21, y: 28},
	{x: 31, y: 28},
	{x: 41, y: 28},
	{x: 1,  y: 38},
	{x: 11, y: 38},
	{x: 21, y: 38},
	{x: 31, y: 38},
	{x: 41, y: 38},
	{x: 1,  y: 48},
	{x: 11, y: 48},
	{x: 21, y: 48},
	{x: 31, y: 48},
	{x: 41, y: 48},
	{x: 1,  y: 58},
	{x: 11, y: 58},
	{x: 21, y: 58},
	{x: 31, y: 58},
	{x: 41, y: 58},
	{x: 1,  y: 68},
	{x: 11, y: 68},
	{x: 21, y: 68},
	{x: 31, y: 68},
	{x: 41, y: 68},
	{x: 1,  y: 78},
	{x: 11, y: 78},
	{x: 21, y: 78},
	{x: 31, y: 78},
	{x: 41, y: 78}
];

interface char {
	[key: string]: tuple;
}
const charMap: char = {
	'a': {'x':  0, 'y': 0},
	'b': {'x':  4, 'y': 0},
	'c': {'x':  8, 'y': 0},
	'd': {'x': 12, 'y': 0},
	'e': {'x': 16, 'y': 0},
	'f': {'x': 20, 'y': 0},
	'g': {'x': 24, 'y': 0},
	'h': {'x': 28, 'y': 0},
	'i': {'x': 32, 'y': 0},
	'j': {'x': 36, 'y': 0},
	'k': {'x': 40, 'y': 0},
	'l': {'x': 44, 'y': 0},
	'm': {'x': 48, 'y': 0},
	'n': {'x':  0, 'y': 6},
	'o': {'x':  4, 'y': 6},
	'p': {'x':  8, 'y': 6},
	'q': {'x': 12, 'y': 6},
	'r': {'x': 16, 'y': 6},
	's': {'x': 20, 'y': 6},
	't': {'x': 24, 'y': 6},
	'u': {'x': 28, 'y': 6},
	'v': {'x': 32, 'y': 6},
	'w': {'x': 36, 'y': 6},
	'x': {'x': 40, 'y': 6},
	'y': {'x': 44, 'y': 6},
	'z': {'x': 48, 'y': 6},
	'1': {'x':  0, 'y': 12},
	'2': {'x':  4, 'y': 12},
	'3': {'x':  8, 'y': 12},
	'4': {'x': 12, 'y': 12},
	'5': {'x': 16, 'y': 12},
	'6': {'x': 20, 'y': 12},
	'7': {'x': 24, 'y': 12},
	'8': {'x': 28, 'y': 12},
	'9': {'x': 32, 'y': 12},
	'0': {'x': 36, 'y': 12},
	'-': {'x': 40, 'y': 12},
	'_': {'x': 44, 'y': 12}
};

interface player {
	id: string;
	avatar: tuple;
	color: string;
	name: string;
	position: tuple;
	health: number;
	points: number;
	canVote: boolean;
}
var players:player[] = [];
var jury_players: player[] = [];
var jury_votes: {id: string, votes: number}[] = [];
var initialized = false;
var inProgress = false;
var startTimeout: NodeJS.Timeout;
var tickInterval: NodeJS.Timeout;
var max_players = Math.min(palette.length - 3, avatar.length);

export var Game = {
	'create': createGame,
	'reset': resetGame,
	'destroy': destroyGame,
	'start': startGame,
	'renderBoard': renderBoard,
	'renderScore': renderScore,
	'playerJoin': playerJoin,
	'playerLeave': playerLeave,
	'playerMove': playerMove,
	'playerShoot': playerShoot,
	'playerPass': playerPass,
	'playerVote': playerVote
}

function createGame(): boolean {
	if (!initialized) {
		initialized = true; 
		return true;
	}
	return false;
}

function resetGame(): boolean {
	return destroyGame() && createGame();
}

function destroyGame(): boolean {
	if (initialized) {
		initialized = false;
		inProgress = false;
		players = [];
		jury_players = [];
		jury_votes = [];
		clearTimeout(startTimeout);
		clearInterval(tickInterval);
		return true;
	}
	return false;
}

function startGame(msg: Message): boolean {
	if (!initialized || inProgress || players.length < 2) return false;
	scheduleGameTick(msg);
	inProgress = true;
	return true;
}

async function renderBoard(): Promise<Canvas> {
	if (!inProgress) throw 'There is no game in progress!';

	// draw the game and return the canvas
	const canvas = createCanvas(window_size, window_size);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = palette[0];
  ctx.fillRect(0, 0, window_size, window_size);

  ctx.scale(window_scale, window_scale)
	
	// draw game grid
  for (let y = 0; y < 20; y++) {
  	for (let x = 0; x < 20; x++) {
  		let i = y * 20 + x;
  		ctx.fillStyle = palette[(i + y) % 2 ? 1 : 2];
  		ctx.fillRect((x + 1) * 9, (y + 1) * 9, 9, 9);
  	}
  }

  loadImage('./images/gameAssets.png').then((image) => {
	  // draw column/row legends
	  for (let col = 0; col < boardSize; col++) {
	  	let char = String.fromCharCode(col + 97);
	  	ctx.drawImage(image, charMap[char].x, charMap[char].y, 3, 5, (col + 1) * 9 + 3, 3, 3, 5);
	  	ctx.drawImage(image, charMap[char].x, charMap[char].y, 3, 5, (col + 1) * 9 + 3, 190, 3, 5);
	  }
	  for (let row = 0; row < boardSize; row++) {
	  	let char = row + 1;
	  	let digit_ten = Math.floor(char / 10).toString();
	  	let digit_one = char % 10;

	  	ctx.drawImage(image, charMap[digit_one].x, charMap[digit_one].y, 3, 5, 5, row * 9 + 11, 3, 5);
	  	if (digit_ten === '0') {
	  		ctx.drawImage(image, charMap[digit_one].x, charMap[digit_one].y, 3, 5, 190, row * 9 + 11, 3, 5);
	  	} else {
	  		ctx.drawImage(image, charMap[digit_ten].x, charMap[digit_ten].y, 3, 5, 1, row * 9 + 11, 3, 5);
	  		ctx.drawImage(image, charMap[digit_ten].x, charMap[digit_ten].y, 3, 5, 190, row * 9 + 11, 3, 5);
	  		ctx.drawImage(image, charMap[digit_one].x, charMap[digit_one].y, 3, 5, 194, row * 9 + 11, 3, 5);
	  	}
	  }

	  // draw players
	  for (let p of players) {
	  	let px = (p.position.x + 1) * 9;
	  	let py = (p.position.y + 1) * 9;
	  	ctx.drawImage(image, p.avatar.x, p.avatar.y, 9, 9, px, py, 9, 9);
	  	paletteSwap(ctx, '#ffffff', p.color, px, py, 9, 9, window_scale);
	  }
	});
  return canvas;
}

async function renderScore(): Promise<Canvas> {
	if (!inProgress) throw 'There is no scoreboard to show!';

	let col_height_1 = 10;
	let col_height_2 = 10 + jury_players.length * 10;
	for (let i = 0; i < players.length; i++) {
		let p = players[i];
		let padding = 10 + 5 * Math.ceil((p.health + p.points) / max_point_len);
		col_height_1 += padding
	}

	let score_height = Math.max(col_height_1, col_height_2);
	score_height += (players.length - 1) * 2;
	score_height *= score_scale;

	const canvas = createCanvas(score_width, score_height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = palette[2];
  ctx.fillRect(0, 0, score_width, score_height);
  ctx.fillStyle = palette[1];
  ctx.fillRect((max_name_len * 4 + 15) * score_scale, 10 * score_scale, score_scale, score_height - 2 * score_scale);
  
  ctx.scale(score_scale, score_scale)

  loadImage('./images/gameAssets.png').then((image) => {
  	ctx.fillStyle = palette[1];
  	ctx.fillRect(1, 1, max_name_len * 4 + 14, 7);
  	ctx.fillRect(max_name_len * 4 + 16, 1, max_name_len * 4 + 14, 7);
  	let title = 'players';
  	for (let c = 0; c < title.length; c++) {
  		let char = title.charAt(c);
  		let x = c * 4 + 2;
  		ctx.drawImage(image, charMap[char].x, charMap[char].y, 3, 5, x, 2, 3, 5);
  		paletteSwap(ctx, '#ffffff', palette[0], x, 2, 3, 5, score_scale);
  	}
  	title = 'jury';
  	for (let c = 0; c < title.length; c++) {
  		let char = title.charAt(c);
  		let x = c * 4 + 65;
  		ctx.drawImage(image, charMap[char].x, charMap[char].y, 3, 5, x, 2, 3, 5);
  		paletteSwap(ctx, '#ffffff', palette[0], x, 2, 3, 5, score_scale);
  	}
  	// draw the active players in the left column
  	// draw the jury players in the right column
  	let py = 10;
  	for (let i = 0; i < players.length; i++) {
  		let p = players[i];
  		let px = 1;

  		// draw avatars
  		ctx.drawImage(image, p.avatar.x, p.avatar.y, 9, 9, px, py, 9, 9);
  		paletteSwap(ctx, '#ffffff', p.color, px, py, 9, 9, score_scale);
  		// draw nametag
  		px += 10;
  		ctx.drawImage(image, 0, 18, 2, 9, px, py, 2, 9);
			for (let c = 0; c < p.name.length; c++) {
				let char = p.name.charAt(c);
				let x = px + c * 4 + 2;
				ctx.drawImage(image, 3, 18, 4, 9, x, py, 4, 9); // nametag background
				ctx.drawImage(image, charMap[char].x, charMap[char].y, 3, 5, x, py + 2, 3, 5); // character
				paletteSwap(ctx, '#ffffff', palette[0], x, py + 2, 3, 5, score_scale);
			}
			ctx.drawImage(image, 8, 18, 2, 9, px + p.name.length * 4 + 1, py, 2, 9);
			paletteSwap(ctx, palette[1], p.color, px, py, p.name.length * 4 + 3, 9, score_scale);

	    // draw health/points
			px -= 10;
			py += 10;
	    for (let k = 0; k < p.health + p.points; k++) {
	    	let src = k < p.health ? {x: 11, y: 18} : {x: 16, y: 18};
	    	let dx = px + (k % max_point_len) * 5 + 1;
	    	let dy = py + Math.floor(k / max_point_len) * 5;
	    	ctx.drawImage(image, src.x, src.y, 4, 4, dx, dy, 4, 4);
	    }
	    py += Math.ceil((p.health + p.points) / max_point_len) * 5 + 2;

	    // draw a horizontal divider line between players
	    if (py < score_height) {
	    	ctx.fillStyle = palette[1];
	    	ctx.fillRect(1, py - 2, (max_name_len * 4 + 13), 1);
	    }
  	}
  	py = 10;
  	for (let j = 0; j < jury_players.length; j++) {
  		let p = jury_players[j];
  		let px = (max_name_len * 4 + 16) + 1;
  		let color = p.canVote ? palette[2] : palette[1];

  		// draw avatars
  		ctx.drawImage(image, p.avatar.x, p.avatar.y, 9, 9, px, py, 9, 9);
  		paletteSwap(ctx, '#ffffff', color, px, py, 9, 9, score_scale);
  		// draw nametag
  		px += 10;
  		ctx.drawImage(image, 0, 18, 2, 9, px, py, 2, 9);
			for (let c = 0; c < p.name.length; c++) {
				let char = p.name.charAt(c);
				let x = px + c * 4 + 2;
				ctx.drawImage(image, 3, 18, 4, 9, x, py, 4, 9); // nametag background
				ctx.drawImage(image, charMap[char].x, charMap[char].y, 3, 5, x, py + 2, 3, 5); // character
				paletteSwap(ctx, '#ffffff', palette[0], x, py + 2, 3, 5, score_scale);
			}
			ctx.drawImage(image, 8, 18, 2, 9, px + p.name.length * 4 + 1, py, 2, 9);
			paletteSwap(ctx, palette[1], color, px, py, p.name.length * 4 + 3, 9, score_scale);
			py += 10
  	}
  });
  return canvas;
}

function paletteSwap(ctx: CanvasRenderingContext2D, old_color: string, new_color: string, x: number, y: number, w: number, h: number, scale: number = 1) {
	let imageData = ctx.getImageData(x * scale, y * scale, w * scale, h * scale);
	let d_color = hexToRgb(old_color);
	let p_color = hexToRgb(new_color);
	for (var j = 0; j < imageData.data.length; j += 4) {
      if(imageData.data[j] === d_color.r &&
         imageData.data[j+1] === d_color.g &&
         imageData.data[j+2] === d_color.b
      ){
          imageData.data[j]=p_color.r;
          imageData.data[j+1]=p_color.g;
          imageData.data[j+2]=p_color.b;
      }
  }
  ctx.putImageData(imageData, x * scale, y * scale);
}

interface RGB {
 	r: number;
 	g: number;
 	b: number;
 }
function hexToRgb(hex: string): RGB {
  let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : {r: 0, g: 0, b: 0};
}

function gameTick(msg: Message): void {
	players.map(p => p.points++);
	jury_players.map(j => j.canVote = true);
	jury_votes.map(v => {
		let p = players.find(p => p.id === v.id)
		if (p !== undefined) p.points += Math.floor(v.votes / 3);
	});
	jury_votes = [];
  msg.channel.send("It's a new dawn, it's a day. All players have been given +1 action point.");
}

function scheduleGameTick(msg: Message): void {
	// schedule tickFunc to execute once per day at midnight
  const startTime = new Date();
  startTime.setHours(24, 0, 0, 0);
  const now = new Date();

  // this will probably never execute because the next midnight will always be ahead of the current date, deal with it
  if (startTime.getTime() < now.getTime()) {
    startTime.setHours(startTime.getHours() + 24, 0, 0, 0);
  }

  const firstTickOffset = startTime.getTime() - now.getTime();

  startTimeout = setTimeout(() => {
    gameTick(msg);
    tickInterval = setInterval(() => { gameTick(msg); }, 24 * 60 * 60 * 1000);
  }, firstTickOffset);
}

function playerJoin(id: string, name: string): player {
	if (players.length >= max_players) throw 'the game is full';
	if (name.length > max_name_len) throw 'that name is too long';
	
	const regex = /^[a-z0-9-_]+$/i;
	if (!regex.test(name)) throw 'that name uses illegal symbols';
	
	if (initialized && !inProgress) {
		if (!players.some(player => player.id === id)) {
			const p = {
				id: id,
				avatar: getRandomAvatar(),
				color: getRandomColor(),
				name: name.toLowerCase(),
				position: getRandomEmptyTile(),
				health: 3,
				points: 1,
				canVote: false
			}
			players.push(p);

			return p;
		}
		throw 'you already joined';
	}
	throw "the game is in progress"
}

function playerLeave(id: string): player {
	if (inProgress) {
		throw 'the game is in progress'
	}

	for (let i = 0; i < players.length; i++) {
		let p = players[i];
		if (p.id === id) {
			players.splice(i, 1);
			return p;
		}
	}
	throw "you're not even in it to begin with";
}

function tileToTuple(tile: string): tuple {
	const regex = /^[a-z][0-9]{1,2}$/i;
	if (!regex.test(tile)) throw "that's not a valid tile";
  
  let out = {x: tile.toLowerCase().charCodeAt(0) - 97, y: parseInt(tile.substr(1)) - 1}
  if (out.x > boardSize - 1 || out.y > boardSize - 1) throw 'that tile is out of bounds';
  
  return out;
}

function evalCost(type: string, player: tuple, target: tuple): number {
	switch (type) {
		case 'move':
			return Math.abs(player.x - target.x) + Math.abs(player.y - target.y);
		case 'shoot':	
		case 'pass':
			return Math.max(Math.abs(player.x - target.x), Math.abs(player.y - target.y));
		default: {
			throw "there was an error and there's nothing you can do about it"
		}
	}  
}

function playerMove(id: string, target: string): void {
	if (!inProgress) throw "the game hasn't started yet";
	const dest = tileToTuple(target);
	let player = players.find(p => p.id === id);
	if (player === undefined) throw "you aren't in the game";
	if (players.some(p => (p.position.x === dest.x && p.position.y === dest.y))) throw 'that tile is occupied';
	const cost = evalCost('move', player.position, dest);

	if (cost <= player.points) {
		player.points -= cost;
		player.position = dest;
	} else { throw "you don't have enough points"; }
}

function playerShoot(id: string, target: string, times: string): {player: player, win: boolean} {
	if (!inProgress) throw "the game hasn't started yet";
	let shots = Number(times) === NaN ? 1 : Number(times); 
	const dest = tileToTuple(target);
	let player = players.find(p => p.id === id);
	let destPlayer = players.find(p => (p.position.x === dest.x && p.position.y === dest.y));
	if (player === undefined) throw "you aren't in the game";
	if (destPlayer === undefined) throw 'there is no player on that tile';
	const cost = evalCost('shoot', player.position, dest) * shots;

	if (cost <= player.points) {
		player.points -= cost;
		destPlayer.health -= shots;
		if (destPlayer.health === 0) {
			destPlayer.canVote = true;
			jury_players.push(destPlayer);
			players.splice(players.indexOf(destPlayer), 1);

			if (players.length === 1)	return {player: players[0], win: true};
		}
	} else { throw "you don't have enough points"; }
	
	return {player: destPlayer, win: false};
}

function playerPass(id: string, target: string, times: string): void {
	if (!inProgress) throw "the game hasn't started yet";
	let shots = Number(times) === NaN ? 1 : Number(times); 
	const dest = tileToTuple(target);
	let player = players.find(p => p.id === id);
	let destPlayer = players.find(p => (p.position.x === dest.x && p.position.y === dest.y));
	if (player === undefined) throw "you aren't in the game";
	if (destPlayer === undefined) throw 'there is no player on that tile';
	const cost = evalCost('pass', player.position, dest) * shots;

	if (cost <= player.points) {
		player.points -= cost;
		destPlayer.points += shots;
	} else { throw "you don't have enough points"; }
}

function playerVote(id: string, target: string): void {
	if (!inProgress) throw "the game hasn't started yet";
	let j_player = jury_players.find(j => j.id === id);
	if (j_player === undefined) throw "you aren't in the jury";
	if (!j_player.canVote) throw 'you already voted. You can vote again tomorrow';
	const regex = /^<@!([0-9]{18})>$/;
	const target_res = regex.exec(target);
	let player = players.find(p => (target_res === null ? p.name: p.id) === target.toLowerCase());
	if (player === undefined) throw "that player couldn't be found";
	let hit = false;
	for (let j of jury_votes) {
		if (j.id === player.id) {
			j.votes++;
			hit = true;
		}
	}
	if (!hit) jury_votes.push({id: player.id, votes: 1});
	j_player.canVote = false;
}

function getRandomColor(): string {
	let out = palette[Math.floor(Math.random() * (palette.length - 3)) + 3];

	if (players.some(player => player.color === out)) {
		out = getRandomColor();
	}
	return out;
}

function getRandomEmptyTile(): tuple {
	let out = {
		x: Math.floor(boardSize * Math.random()),
		y: Math.floor(boardSize * Math.random())
	}
	
	if (players.some(player => player.position === out)) {
		out = getRandomEmptyTile();
	}
	return out;
}

function getRandomAvatar(): tuple {
	let out = avatars[Math.floor(avatars.length * Math.random())];

	if (players.some(player => player.avatar === out)) {
		out = getRandomAvatar();
	}
	return out;
}
