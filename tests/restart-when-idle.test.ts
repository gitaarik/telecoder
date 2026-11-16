import { describe, it, expect } from 'vitest';
import { describeWork } from '../src/restart-when-idle.js';

const IDLE = { updates: 0, turns: 0, selfStartedTurn: false, backgroundTasks: 0, backgroundShells: 0, topicCalls: 0, threadRenames: 0 };

describe('describeWork', () => {
  it('is null when nothing is left to finish', () => {
    expect(describeWork(IDLE)).toBeNull();
  });

  it('counts turns, and not the updates that started them', () => {
    expect(describeWork({ ...IDLE, turns: 1, updates: 1 })).toBe('1 turn running');
    expect(describeWork({ ...IDLE, turns: 2, updates: 3 })).toBe('2 turns running');
  });

  it('counts an update no turn accounts for', () => {
    expect(describeWork({ ...IDLE, updates: 1 })).toBe('1 message being handled');
  });

  it('names a turn claude started itself, and background tasks', () => {
    expect(describeWork({ ...IDLE, selfStartedTurn: true, backgroundTasks: 2 }))
      .toBe('answering a background task, 2 background tasks');
    expect(describeWork({ ...IDLE, turns: 1, backgroundTasks: 1 }))
      .toBe('1 turn running, 1 background task');
  });

  it('names a background shell command, a topic being named and a thread rename still to make', () => {
    expect(describeWork({ ...IDLE, backgroundShells: 1 })).toBe('1 background shell command');
    expect(describeWork({ ...IDLE, topicCalls: 1, threadRenames: 1 })).toBe('naming the topic, renaming a thread');
    expect(describeWork({ ...IDLE, backgroundShells: 2, topicCalls: 2, threadRenames: 3 }))
      .toBe('2 background shell commands, naming 2 topics, renaming 3 threads');
  });
});
