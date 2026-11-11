/**
 * The project a bot is for (HOME_PROJECT), set per bot in instances.json by
 * /newbot. A bot made for one project names itself after it, so it neither
 * needs a /project before the first message nor the project in front of
 * every thread's name.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { getWorkspaceRoot } from './workspace-guard.js';

let warned = false;

/** The bot's home project as an absolute path, or undefined when it has none or it's gone. */
export function homeProject(): string | undefined {
  if (!config.HOME_PROJECT) return undefined;
  const dir = path.resolve(getWorkspaceRoot(), config.HOME_PROJECT);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  if (!warned) {
    warned = true;
    console.warn(`[HomeProject] HOME_PROJECT ${dir} is not a directory; ignoring it`);
  }
  return undefined;
}

/** Whether `dir` is the bot's home project. */
export function isHomeProject(dir: string | undefined): boolean {
  const home = homeProject();
  return home !== undefined && dir !== undefined && path.resolve(dir) === home;
}
