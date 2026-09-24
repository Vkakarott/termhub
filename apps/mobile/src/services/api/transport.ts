// The transport port (design spec §4.1): the only thing `HttpMobileApi` talks to. `FetchTransport`
// is the one implementation that reaches a real server; `MockTransport` (a later task) answers the
// same shape from an in-memory "server", which is what makes `HttpMobileApi` testable without one.

export interface TransportFetchInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** `headers` are lower-cased header names, so callers never need to guess the wire's casing. */
export interface TransportFetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface TransportSocketHandlers {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: (code: number) => void;
}

export interface TransportSocket {
  close(): void;
}

export interface Transport {
  fetch(input: TransportFetchInput): Promise<TransportFetchResult>;
  connect(url: string, headers: Record<string, string>, handlers: TransportSocketHandlers): TransportSocket;
}

/**
 * `fetch` and React Native's `WebSocket`. `connect` is never constructed under Jest — the app talks
 * to `MockTransport` in every test; this class only needs to typecheck and to behave correctly on
 * a device.
 */
export class FetchTransport implements Transport {
  async fetch(input: TransportFetchInput): Promise<TransportFetchResult> {
    const response = await fetch(input.url, { method: input.method, headers: input.headers, body: input.body });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const text = await response.text();
    return { status: response.status, headers, text };
  }

  connect(url: string, headers: Record<string, string>, handlers: TransportSocketHandlers): TransportSocket {
    // React Native's `WebSocket(url, protocols, options)` accepts `{ headers }` as a third
    // constructor argument, for the upgrade request's headers — not part of the DOM `WebSocket`
    // typings this file compiles against, hence the cast through `unknown`.
    const RNWebSocket = WebSocket as unknown as new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => WebSocket;
    const socket = new RNWebSocket(url, undefined, { headers });
    socket.onopen = () => handlers.onOpen();
    socket.onmessage = (event: MessageEvent) => handlers.onMessage(String(event.data));
    socket.onclose = (event: CloseEvent) => handlers.onClose(event.code);
    return { close: () => socket.close() };
  }
}
