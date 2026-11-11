// Where the analysis tools find things: ROOT is the agar.io folder (your recordings are in
// ROOT/recordings), GAMES holds sets of bot games (one folder per set, made by games.mjs).
// A game-set argument is a folder name under GAMES, or an absolute path.
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

const slash = (p) => p.split('\\').join('/');
export const ROOT = slash(fileURLToPath(new URL('../../', import.meta.url)));
export const GAMES = slash(fileURLToPath(new URL('./games/', import.meta.url)));
export const gamesDir = (d) => (isAbsolute(d) ? slash(d) : GAMES + d).replace(/\/$/, '');
