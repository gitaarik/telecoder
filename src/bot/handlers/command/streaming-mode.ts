/**
 * Runtime override for the streaming/wait response mode.
 *
 * Its own module because it is process-global state read from several command
 * domains and from message.handler — keeping it in any one domain module would
 * make the others import that domain just to read a boolean.
 */

import { config } from '../../../config.js';

let runtimeStreamingMode: 'streaming' | 'wait' = config.STREAMING_MODE;

export function getStreamingMode(): 'streaming' | 'wait' {
  return runtimeStreamingMode;
}

export function setStreamingMode(mode: 'streaming' | 'wait'): void {
  runtimeStreamingMode = mode;
}
