import { EventEmitter } from 'node:events';
import {
  CLOSE,
  type ClaudeOpenParams,
  type PtyOpenParams,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type TcpOpenParams,
} from '@termhub/agent-protocol';
import type { AgentChannel, AgentConnection, AgentPtyChannel, ChannelHandlers, PtyHandlers } from './connection.js';

export class AgentOfflineError extends Error {}

export interface AgentInfo {
  agent_version: string;
  os: 'macos' | 'linux';
  tools: string[];
  connected_at: string;
}

/**
 * Process-wide map from machine id to its live AgentConnection.
 * Later tasks (RPC routes, terminal wiring) go through the `agents` singleton
 * instead of holding connections themselves.
 */
export class AgentRegistry extends EventEmitter {
  private readonly conns = new Map<string, AgentConnection>();

  attach(machineId: string, conn: AgentConnection): void {
    const existing = this.conns.get(machineId);
    if (existing) {
      existing.close(CLOSE.CONFLICT, 'replaced');
    }
    this.conns.set(machineId, conn);
    conn.on('close', () => {
      if (this.conns.get(machineId) === conn) {
        this.conns.delete(machineId);
        this.emit('offline', machineId);
      }
    });
    this.emit('online', machineId, conn.hello);
  }

  isOnline(machineId: string): boolean {
    return this.conns.has(machineId);
  }

  info(machineId: string): AgentInfo | null {
    const conn = this.conns.get(machineId);
    if (!conn || !conn.hello) return null;
    return {
      agent_version: conn.hello.agent_version,
      os: conn.hello.os,
      tools: conn.hello.tools,
      connected_at: new Date(conn.connectedAt).toISOString(),
    };
  }

  openChannels(machineId: string): number {
    return this.conns.get(machineId)?.openChannels ?? 0;
  }

  rpc<M extends RpcMethod>(machineId: string, method: M, params: RpcParams<M>, timeoutMs?: number): Promise<RpcResult<M>> {
    const conn = this.conns.get(machineId);
    if (!conn) {
      return Promise.reject(new AgentOfflineError(`agent offline: ${machineId}`));
    }
    return conn.rpc(method, params, timeoutMs);
  }

  openPty(machineId: string, params: PtyOpenParams, handlers: PtyHandlers): Promise<AgentPtyChannel> {
    const conn = this.conns.get(machineId);
    if (!conn) {
      return Promise.reject(new AgentOfflineError(`agent offline: ${machineId}`));
    }
    return conn.openPty(params, handlers);
  }

  /** A headless Claude run on that machine (the chat's `agentRunner`). */
  openClaude(machineId: string, params: ClaudeOpenParams, handlers: ChannelHandlers): Promise<AgentChannel> {
    const conn = this.conns.get(machineId);
    if (!conn) {
      return Promise.reject(new AgentOfflineError(`agent offline: ${machineId}`));
    }
    return conn.openClaude(params, handlers);
  }

  /** A tcp pipe to a WDA port on that machine (the simulator's agent tunnel). */
  openTcp(machineId: string, params: TcpOpenParams, handlers: ChannelHandlers): Promise<AgentChannel> {
    const conn = this.conns.get(machineId);
    if (!conn) {
      return Promise.reject(new AgentOfflineError(`agent offline: ${machineId}`));
    }
    return conn.openTcp(params, handlers);
  }

  /**
   * What the machine's agent said it understands beyond a terminal, or `null` when there is nobody to
   * ask: not connected, or connected but still before `hello` — the same thing to a caller that needs
   * the answer now. An agent from before the field existed reports `[]`, so "understands nothing
   * extra" and "too old to know" read alike, which is exactly what they are.
   */
  capabilities(machineId: string): string[] | null {
    return this.conns.get(machineId)?.hello?.capabilities ?? null;
  }

  disconnect(machineId: string, code: number, reason?: string): void {
    const conn = this.conns.get(machineId);
    if (!conn) return;
    conn.close(code, reason);
  }

  /** Test-only: clears the map without closing connections. */
  reset(): void {
    this.conns.clear();
  }
}

export const agents = new AgentRegistry();
