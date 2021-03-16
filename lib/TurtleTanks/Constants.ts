/* The height of the board coordinates - A-Z */
export const COORDINATES_HEIGHT = 60;

/* The width of the board coordinates - 0-26 */
export const COORDINATES_WIDTH = 60;

/* Text color of coordinates */
export const COORDINATES_FILL = '#e6e6e6';

/* Color of coordinates text outline */
export const COORDINATES_OUTLINE = '#000000';

/* Width of coordinates text outline */
export const COORDINATES_OUTLINE_WIDTH = 1;

/* Font of coordinates text */
export const COORDINATES_FONT = 'NotoSans';

/* How thick to make the coordinates font. Can be a weight, or a 'bold', 'normal', etc */
export const COORDINATES_FONT_WEIGHT = 800;

/* The color of the lines that denote the map grid */
export const GRIDLINES_COLOR = '#F0F0F0';

/* Default color to fill tiles with when no specification is given */
export const DEFAULT_TILE_COLOR = '#e6e6e6';

/* Default opacity to draw tiles at */
export const DEFAULT_TILE_OPACITY = 1;

/* Default height of the map when no specification given */
export const DEFAULT_MAP_HEIGHT = 10;

/* Default width of the map when no specification given */
export const DEFAULT_MAP_WIDTH = 10;

/* How many pixels does a game tile take up? Tiles are square, this sets the
 * width and height. */
export const PIXELS_PER_TILE = 64;

/* Which size avatars should we use. */
export const AVATAR_SIZES = '2%';

/* Color to use to highlight the active player on the map */
export const HIGHLIGHT_COLOR = '#ff0000';

/* Width of the highlight circle outline */
export const HIGHLIGHT_OUTLINE_WIDTH = 5;

/* Color of the preview arrows */
export const PREVIEW_ARROW_COLOR = '#ff0000';

/* Width of the preview arrows */
export const PREVIEW_ARROW_WIDTH = 4;

/* The amount of hp to start tanks with, minus any modifiers */
export const DEFAULT_STARTING_HP = 100;

/* The amount of points it takes to move one tile, minus any modifiers */
export const POINTS_PER_MOVE = 5;

/* The amount of points it takes to perform a shot, minus any modifiers */
export const POINTS_PER_SHOT = 5;

/* The amount of points awarded for killing a player */
export const POINTS_PER_KILL = 5;

/* The default amount of points awarded for killing a player */
export const POINTS_PER_TICK = POINTS_PER_MOVE * 3;

/* The amount of points a player starts with, minus any modifiers */
export const DEFAULT_STARTING_POINTS = POINTS_PER_TICK;

/* Every time a tick is executed, users will be awareded POINTS_PER_TICK points. */
export const MILLISECONDS_PER_TICK = 1000 * 60 * 10;
