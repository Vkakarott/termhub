import type { FastifyBaseLogger } from 'fastify';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import { failureLabel } from '../chat/service.js';
import type { Device } from '../db/repositories/devices.js';
import type { DeviceRequest } from '../db/repositories/device-requests.js';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { confirmationText, deviceRequestText, replyText, type PushContext, type PushText } from './push-text.js';
import { SlidingWindow } from './rate-limit.js';
import type { MobileSocketRegistry } from './revocation.js';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  collapseId?: string;
}

export interface PushSender {
  /** One result per message, in order; `error` is Expo's per-ticket error code when there is one. */
  send(messages: PushMessage[]): Promise<{ to: string; error?: 'DeviceNotRegistered' | string }[]>;
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_CHUNK = 100;

interface ExpoTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

/** Sends through the Expo Push Service over HTTPS, in chunks of 100 (Expo's per-request limit). */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly accessToken: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(messages: PushMessage[]): Promise<{ to: string; error?: string }[]> {
    const results: { to: string; error?: string }[] = [];
    for (let i = 0; i < messages.length; i += EXPO_CHUNK) {
      const chunk = messages.slice(i, i + EXPO_CHUNK);
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
      const res = await this.fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          chunk.map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data, sound: 'default', priority: 'high', ...(m.collapseId ? { collapseId: m.collapseId } : {}) })),
        ),
      });
      if (!res.ok) throw Object.assign(new Error(`Expo push answered ${res.status}`), { code: `EXPO_HTTP_${res.status}` });
      const tickets = ((await res.json()) as { data?: ExpoTicket[] }).data ?? [];
      chunk.forEach((m, j) => {
        const t = tickets[j];
        results.push({ to: m.to, error: t?.details?.error ?? (t?.status === 'error' ? t.message : undefined) });
      });
    }
    return results;
  }
}

export interface MobilePushDeps {
  repos: Repositories;
  sender: PushSender;
  sockets: MobileSocketRegistry;
  log: FastifyBaseLogger;
  now?: () => Date;
}

type Kind = 'confirmation' | 'reply' | 'device_request';

/**
 * Turns three moments into a row of the person's notification history and a push to their phones
 * (spec §9): a pending action, a finished answer and a new device request. The payload names the
 * project, tab and machine — resolved owner-scoped from ids — and never carries an action's
 * summary, arguments or tool, nor a reply's text. Never throws out of a bus listener; logs ids only.
 */
export class MobilePushService {
  /** "Resposta pronta" at most once per conversation per minute. */
  private readonly replies = new SlidingWindow(60_000, 1);

  constructor(private readonly deps: MobilePushDeps) {}

  /** Subscribes to the chat bus; returns the unsubscribe. */
  start(): () => void {
    return chatBus.subscribe((event) => {
      void this.handle(event).catch((err) =>
        this.deps.log.warn({ err: failureLabel(err), userId: event.user_id, conversationId: event.conversation_id, event: event.type }, 'mobile push failed'),
      );
    });
  }

  /** Called by the enrolment service for a real request: goes to every device, live or not. */
  async deviceRequest(user: User, request: DeviceRequest): Promise<void> {
    try {
      const text = deviceRequestText(request);
      const devices = await this.deps.repos.devices.listActiveWithPush(user.id);
      await this.deliver(user.id, 'device_request', text, { kind: 'device_request' }, devices);
    } catch (err) {
      this.deps.log.warn({ err: failureLabel(err), userId: user.id, requestId: request.id }, 'mobile push failed');
    }
  }

  private async handle(event: ChatEvent): Promise<void> {
    if (event.type === 'confirmation') {
      const ctx = await this.names(event.user_id, event.project_id, event.tab_id, event.machine_id);
      const data = { kind: 'confirmation', conversation_id: event.conversation_id, project_id: event.project_id, action_id: event.action_id };
      await this.deliver(event.user_id, 'confirmation', confirmationText(ctx), data, await this.offline(event.user_id));
    } else if (event.type === 'run_finished' && event.ok) {
      const conversation = await this.deps.repos.chat.findByIdForUser(event.conversation_id, event.user_id);
      const projectId = conversation?.project_id ?? null;
      const ctx = await this.names(event.user_id, projectId, null, null);
      const data = { kind: 'reply', conversation_id: event.conversation_id, project_id: projectId };
      const send = this.replies.take(event.conversation_id);
      await this.deliver(event.user_id, 'reply', replyText(ctx), data, send ? await this.offline(event.user_id) : [], `reply:${event.conversation_id}`);
    }
  }

  /** Devices with a push token and no live /ws/m/chat socket: whoever has the app open already saw it. */
  private async offline(userId: string): Promise<Device[]> {
    const live = this.deps.sockets.liveDevices(userId);
    return (await this.deps.repos.devices.listActiveWithPush(userId)).filter((d) => !live.has(d.id));
  }

  /** Names only what the owner can see: `findByIdsForOwner` drops anything that is not theirs. */
  private async names(ownerId: string, projectId: string | null, tabId: string | null, machineId: string | null): Promise<PushContext> {
    const { repos } = this.deps;
    const [projects, tabs, machines] = await Promise.all([
      projectId ? repos.projects.findByIdsForOwner([projectId], ownerId) : [],
      tabId ? repos.tabs.findByIdsForOwner([tabId], ownerId) : [],
      machineId ? repos.machines.findByIdsForOwner([machineId], ownerId) : [],
    ]);
    return {
      projectName: projects.find((p) => p.id === projectId)?.name ?? null,
      tabName: tabs.find((t) => t.id === tabId)?.name ?? null,
      machineName: machines.find((m) => m.id === machineId)?.name ?? null,
    };
  }

  /** The history row first — it exists even when sending fails — then the push. */
  private async deliver(userId: string, kind: Kind, text: PushText, data: Record<string, unknown>, devices: Device[], collapseId?: string): Promise<void> {
    await this.deps.repos.userNotifications.create({ user_id: userId, kind, title: text.title, body: text.body, data });
    const targets = devices.filter((d): d is Device & { push_token: string } => !!d.push_token);
    if (targets.length === 0) return;
    const messages: PushMessage[] = targets.map((d) => ({ to: d.push_token, title: text.title, body: text.body, data, ...(collapseId ? { collapseId } : {}) }));
    let results: { to: string; error?: string }[];
    try {
      results = await this.deps.sender.send(messages);
    } catch (err) {
      this.deps.log.warn({ err: failureLabel(err), userId, kind, devices: targets.length }, 'mobile push send failed');
      return;
    }
    for (const r of results) {
      if (r.error !== 'DeviceNotRegistered') continue;
      const device = targets.find((d) => d.push_token === r.to);
      if (!device) continue;
      await this.deps.repos.devices
        .setPushToken(device.id, null)
        .catch((err) => this.deps.log.warn({ err: failureLabel(err), deviceId: device.id }, 'clearing a dead push token failed'));
    }
  }
}
