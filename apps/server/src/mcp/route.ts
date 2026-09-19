import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import { controlContextFor, ControlError, type ControlContext } from '../control/context.js';
import { HttpError } from '../lib/errors.js';
import { authenticateToken } from './auth.js';
import { TokenRateLimiter } from './rate-limit.js';
import { allowedTools } from './tools.js';

export const MCP_BODY_LIMIT = 256 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    /** set by the /mcp token check */
    mcp?: { token: ApiToken; ctx: ControlContext };
  }
}

const UNAUTHORIZED = { error: 'Não autenticado', code: 'UNAUTHORIZED' } as const;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** `arguments` is optional in tools/call, but the SDK validates `undefined` against the tool's object schema. */
function withDefaultArguments(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const msg = body as { method?: unknown; params?: { arguments?: unknown } };
  if (msg.method !== 'tools/call' || !msg.params || typeof msg.params !== 'object' || msg.params.arguments !== undefined) return body;
  return { ...msg, params: { ...msg.params, arguments: {} } };
}

/**
 * The global terminal's MCP endpoint (spec §3.3). Public route outside /api: no session, no CSRF —
 * a personal API token authenticates each request, and the token's user is the data scope. Stateless:
 * a fresh McpServer per request, so a revoked token stops working on the next call.
 */
export async function mcpRoutes(app: FastifyInstance, deps: { repos: Repositories; version: string; limiter?: TokenRateLimiter }) {
  const { repos } = deps;
  const limiter = deps.limiter ?? new TokenRateLimiter();

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticateToken(repos, request.headers.authorization);
    if (!auth) return reply.code(401).send(UNAUTHORIZED);
    request.mcp = { token: auth.token, ctx: controlContextFor(repos, auth.user) };
    void repos.apiTokens.touchLastUsed(auth.token.id).catch((err) => request.log.warn({ err }, 'mcp: touchLastUsed failed'));
  };

  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).header('allow', 'POST').send({ error: 'Use POST', code: 'METHOD_NOT_ALLOWED' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  app.post('/mcp', { bodyLimit: MCP_BODY_LIMIT, onRequest: authenticate }, async (request, reply) => {
    const { token, ctx } = request.mcp!;
    const server = new McpServer({ name: 'termhub', version: deps.version }, { capabilities: { tools: {} } });

    const tools = await allowedTools(ctx, token.scopes);
    // McpServer installs its tools/* handlers on the first registerTool; with nothing allowed, answer an
    // empty catalog instead of "Method not found" (tools/call then stays a JSON-RPC "Method not found").
    if (tools.length === 0) server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        const started = Date.now();
        const ids = { machine_id: str(args.machine_id), project_id: str(args.project_id), tab_id: str(args.tab_id) };
        let errorCode: string | null = null;
        let out: ToolResult;
        const rate = limiter.take(token.id);
        if (!rate.ok) {
          errorCode = 'RATE_LIMITED';
          out = text(`Limite de ${limiter.limit} chamadas por minuto deste token; tente de novo em ${rate.retryInSeconds} s`, true);
        } else {
          try {
            out = text(JSON.stringify(await tool.run(ctx, args, extra.signal), null, 2));
          } catch (e) {
            if (e instanceof ControlError || e instanceof HttpError) {
              errorCode = e.code ?? 'ERROR';
              out = text(e.message, true);
            } else {
              errorCode = 'INTERNAL';
              request.log.error({ err: e, tool: tool.name, token_id: token.id }, 'mcp: tool failed');
              out = text('Erro interno ao executar a ferramenta', true);
            }
          }
        }
        void repos.apiTokens
          .recordEvent({ token_id: token.id, tool: tool.name, ...ids, ok: errorCode === null, error_code: errorCode, duration_ms: Date.now() - started })
          .catch((err) => request.log.warn({ err }, 'mcp: recordEvent failed'));
        return out;
      });
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, withDefaultArguments(request.body));
  });
}
