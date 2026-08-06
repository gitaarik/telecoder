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

class ProjectFavoritesManager {
  private data: Record<string, Favorite[]> = {};

  constructor() {
    ensureStateDir(FAVORITES_DIR, 'ProjectFavorites');
    this.load();
  }

  private load(): void {
    const loaded = readJsonFile(FAVORITES_FILE, favoritesDataSchema, 'ProjectFavorites');
    this.data = loaded?.sessions ?? {};
  }

  private save(): void {
    writeJsonFile(FAVORITES_FILE, { sessions: this.data }, 'ProjectFavorites');
  }

  list(sessionKey: string): Favorite[] {
    return this.data[sessionKey] ?? [];
  }

  has(sessionKey: string, projectPath: string): boolean {
    const normalized = path.resolve(projectPath);
    return this.list(sessionKey).some((f) => f.path === normalized);
  }

  add(sessionKey: string, projectPath: string): boolean {
    const normalized = path.resolve(projectPath);
    const existing = this.data[sessionKey] ?? [];
    if (existing.some((f) => f.path === normalized)) return false;
    existing.push({ path: normalized, addedAt: new Date().toISOString() });
    this.data[sessionKey] = existing;
    this.save();
    return true;
  }

  remove(sessionKey: string, projectPath: string): boolean {
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
