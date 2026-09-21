import { EventEmitter } from 'node:events';
import type { ChatMessage } from '../db/repositories/chat.js';

/** What the browser is told while an answer is being written. Terminal content never travels here:
 * an action carries the tool and its arguments, never a captured screen (spec §7.1). */
export type ChatEvent =
  | { type: 'message'; user_id: string; message: ChatMessage }
  | { type: 'delta'; user_id: string; message_id: string; delta: string }
  | { type: 'action'; user_id: string; message_id: string; tool: string; tool_use_id: string; args: unknown }
  | { type: 'action_result'; user_id: string; message_id: string; tool_use_id: string; ok: boolean };

class ChatBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(event: ChatEvent): void {
    this.emitter.emit('chat', event);
  }
  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.emitter.on('chat', listener);
    return () => this.emitter.off('chat', listener);
  }
}

export const chatBus = new ChatBus();
