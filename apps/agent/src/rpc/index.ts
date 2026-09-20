import type { RpcMethod, RpcParams, RpcResult } from '@termhub/agent-protocol';
import * as ai from './ai.js';
import * as fs from './fs.js';
import * as hooks from './hooks.js';
import * as hw from './hw.js';
import * as paste from './paste.js';
import * as tmux from './tmux.js';
import * as tools from './tools.js';
import * as update from './update.js';

// Re-exported so callers of this module (dispatch.ts) don't need to know RpcFailure actually
// lives in exec.ts — from the RPC layer's point of view it belongs here.
export { RpcFailure } from '../exec.js';

export type Handlers = { [M in RpcMethod]: (params: RpcParams<M>) => Promise<RpcResult<M>> };

export const handlers: Handlers = {
  'tmux.list': tmux.list,
  'tmux.kill': tmux.kill,
  'tmux.capture': tmux.capture,
  'tmux.ensure': tmux.ensure,
  'tmux.sendText': tmux.sendText,
  'tmux.sendKey': tmux.sendKey,
  'tools.detect': tools.detect,
  'hw.probe': hw.probe,
  'fs.list': fs.list,
  'fs.mkdir': fs.mkdir,
  'ai.credential': ai.credential,
  'file.paste': paste.pasteFile,
  'hooks.install': hooks.install,
  'hooks.uninstall': hooks.uninstall,
  'agent.update': update.update,
};
