import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';

const favoriteSchema = z.object({
  path: z.string(),
  addedAt: z.string(),
});

const favoritesDataSchema = z.object({
  sessions: z.record(z.string(), z.array(favoriteSchema)),
});

export type Favorite = z.infer<typeof favoriteSchema>;

const FAVORITES_DIR = getStateDir();
const FAVORITES_FILE = path.join(FAVORITES_DIR, 'project-favorites.json');

/**
 * One list per chat, shared by every bot: the same person moves their bots across
 * the same projects. Each bot is its own process, so the file is the only copy
 * that counts, and it's read before every use. A bot saving from what it loaded
 * earlier would put back whatever the others had changed since.
 *
 * Saves aren't locked against each other. They only happen on a button tap, so
 * two landing in the same instant isn't worth guarding, and at worst loses a tap.
 */
class ProjectFavoritesManager {
  private data: Record<string, Favorite[]> = {};

  constructor() {
    ensureStateDir(FAVORITES_DIR, 'ProjectFavorites');
  }

  private refresh(): void {
    if (!fs.existsSync(FAVORITES_FILE)) {
      this.data = {};
      return;
    }
    // A file that's there but can't be read isn't an empty one: keep what we last
    // read, or the next save would wipe every chat's favorites.
    const loaded = readJsonFile(FAVORITES_FILE, favoritesDataSchema, 'ProjectFavorites');
    if (loaded) this.data = loaded.sessions;
  }

  private save(): void {
    writeJsonFile(FAVORITES_FILE, { sessions: this.data }, 'ProjectFavorites');
  }

  list(sessionKey: string): Favorite[] {
    this.refresh();
    return this.data[sessionKey] ?? [];
  }

  has(sessionKey: string, projectPath: string): boolean {
    const normalized = path.resolve(projectPath);
    return this.list(sessionKey).some((f) => f.path === normalized);
  }

  add(sessionKey: string, projectPath: string): boolean {
    this.refresh();
    const normalized = path.resolve(projectPath);
    const existing = this.data[sessionKey] ?? [];
    if (existing.some((f) => f.path === normalized)) return false;
    existing.push({ path: normalized, addedAt: new Date().toISOString() });
    this.data[sessionKey] = existing;
    this.save();
    return true;
  }

  remove(sessionKey: string, projectPath: string): boolean {
    this.refresh();
    const normalized = path.resolve(projectPath);
    const existing = this.data[sessionKey] ?? [];
    const filtered = existing.filter((f) => f.path !== normalized);
    if (filtered.length === existing.length) return false;
    this.data[sessionKey] = filtered;
    this.save();
    return true;
  }
}

export const projectFavorites = new ProjectFavoritesManager();
