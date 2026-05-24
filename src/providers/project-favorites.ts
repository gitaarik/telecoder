import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const favoriteSchema = z.object({
  path: z.string(),
  addedAt: z.string(),
});

const favoritesDataSchema = z.object({
  sessions: z.record(z.string(), z.array(favoriteSchema)),
});

export type Favorite = z.infer<typeof favoriteSchema>;

const FAVORITES_DIR = path.join(os.homedir(), '.claudegram');
const FAVORITES_FILE = path.join(FAVORITES_DIR, 'project-favorites.json');

class ProjectFavoritesManager {
  private data: Record<string, Favorite[]> = {};

  constructor() {
    this.ensureDirectory();
    this.load();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(FAVORITES_DIR)) {
      fs.mkdirSync(FAVORITES_DIR, { recursive: true, mode: 0o700 });
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(FAVORITES_FILE)) {
        const content = fs.readFileSync(FAVORITES_FILE, 'utf-8');
        const parsed = JSON.parse(content);
        const validated = favoritesDataSchema.parse(parsed);
        this.data = validated.sessions;
      }
    } catch (err) {
      console.error('[ProjectFavorites] Failed to load:', err);
      this.data = {};
    }
  }

  private save(): void {
    try {
      const toSave = { sessions: this.data };
      atomicWriteFileSync(FAVORITES_FILE, JSON.stringify(toSave, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('[ProjectFavorites] Failed to save:', err);
    }
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
