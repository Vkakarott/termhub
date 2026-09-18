import { EventEmitter } from 'node:events';
import { CLOSE, type PtyOpenParams, type RpcMethod, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import type { AgentConnection, AgentPtyChannel, PtyHandlers } from './connection.js';

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
