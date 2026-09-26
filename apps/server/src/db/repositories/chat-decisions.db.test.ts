import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';
import { UsersRepository } from './users.js';
import { ChatDecisionsRepository, type NewDecision } from './chat-decisions.js';

const DIM = 384;
/** A unit vector with a 1 at index `i`: cosine similarity to itself is exactly 1, and to another such
 *  vector (a different `i`) exactly 0 — so `nearest`'s ordering and `similarity` are exact, not fuzzy. */
const vec = (i: number): number[] => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
/** A normalised blend of `vec(i)` and `vec(j)`, weight `w` on `i`: still a unit vector, so its cosine
 *  similarity to `vec(i)` is exactly `w / sqrt(w^2 + (1-w)^2)` — closer to 1 than an unrelated vector. */
const mix = (i: number, j: number, w: number): number[] => {
  const raw = Array.from({ length: DIM }, (_, k) => (k === i ? w : k === j ? 1 - w : 0));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / norm);
};

const choicePayload = { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] };
const options = [{ label: 'Azul', description: '' }, { label: 'Verde', description: '' }];
const answer = { labels: ['Azul'] };

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatDecisionsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatDecisionsRepository;
  let users: UsersRepository;
  let chat: ChatRepository;
  let userId: string;
  let otherUserId: string;
  let projectId: string;
  let conversationId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatDecisionsRepository(db);
    users = new UsersRepository(db);
    chat = new ChatRepository(db);
    userId = newId();
    otherUserId = newId();
    projectId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    await db.project.create({ data: { id: projectId, key: `D${projectId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'proj', ownerId: userId } });
    conversationId = (await chat.getOrCreateForProject(userId, projectId)).id;
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: projectId } }); // cascades its conversations and tab_questions
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades their chat_decisions
    await db.$disconnect();
  });

  const newDecision = (over: Partial<NewDecision> = {}): NewDecision => ({
    user_id: userId,
    project_id: projectId,
    conversation_id: conversationId,
    tab_question_id: null,
    question_index: 0,
    header: 'Fonte',
    question: 'Qual fonte usar?',
    options,
    multi_select: false,
    answer,
    ...over,
  });

  let decisionAId: string;

  it('insertMany returns the rows; the same (tab_question_id, question_index) again inserts nothing', async () => {
    const tabQuestionId = newId();
    const [row] = await repo.insertMany([newDecision({ tab_question_id: tabQuestionId })]);
    expect(row).toMatchObject({
      user_id: userId,
      project_id: projectId,
      project_name: 'proj',
      conversation_id: conversationId,
      tab_question_id: tabQuestionId,
      question_index: 0,
      header: 'Fonte',
      question: 'Qual fonte usar?',
      options,
      multi_select: false,
      answer,
      embed_model: null,
      suggested_count: 0,
      accepted_count: 0,
    });
    expect(row!.id).toBeTruthy();
    expect(row!.created_at).toBeTruthy();
    decisionAId = row!.id;

    // Same (tab_question_id, question_index) again: nothing inserted, the row stays alone.
    expect(await repo.insertMany([newDecision({ tab_question_id: tabQuestionId })])).toEqual([]);
    const stillOne = await db.chatDecision.count({ where: { tabQuestionId: tabQuestionId } });
    expect(stillOne).toBe(1);
  });

  it('listToEmbed returns rows without an embedding; setEmbedding clears it from the list and sets embed_model', async () => {
    const before = await repo.listToEmbed(1000);
    expect(before.map((d) => d.id)).toContain(decisionAId);
    const found = before.find((d) => d.id === decisionAId)!;
    expect(found).toMatchObject({ header: 'Fonte', question: 'Qual fonte usar?', options });

    await repo.setEmbedding(decisionAId, vec(1), 'm');

    const after = await repo.listToEmbed(1000);
    expect(after.map((d) => d.id)).not.toContain(decisionAId);

    const page = await repo.listForUser(userId, { limit: 1000 });
    expect(page.items.find((d) => d.id === decisionAId)).toMatchObject({ embed_model: 'm' });
  });

  it('nearest: best match first, scoped to the user and the multi_select shape, only embedded rows', async () => {
    const [b] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Estilo', question: 'Qual estilo?' })]);
    await repo.setEmbedding(b!.id, mix(1, 2, 0.5), 'm');

    const [multi] = await repo.insertMany([newDecision({ tab_question_id: newId(), multi_select: true, header: 'Multi', question: 'Quais opcoes?' })]);
    await repo.setEmbedding(multi!.id, vec(1), 'm');

    const [unembedded] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'SemEmbedding', question: 'Ainda sem embedding?' })]);

    const [otherUserRow] = await repo.insertMany([
      newDecision({ user_id: otherUserId, project_id: null, conversation_id: null, tab_question_id: newId(), header: 'Outro', question: 'Pergunta de outro usuario?' }),
    ]);
    await repo.setEmbedding(otherUserRow!.id, vec(1), 'm');

    const neighbours = await repo.nearest(userId, vec(1), { multiSelect: false, k: 5 });
    expect(neighbours[0]).toMatchObject({ id: decisionAId, project_name: 'proj' });
    expect(neighbours[0]!.similarity).toBeCloseTo(1, 5);
    expect(neighbours[1]!.id).toBe(b!.id);

    const ids = neighbours.map((n) => n.id);
    expect(ids).not.toContain(multi!.id);
    expect(ids).not.toContain(unembedded!.id);
    expect(ids).not.toContain(otherUserRow!.id);
  });

  it('bumpSuggested / bumpAccepted increment their counters', async () => {
    await repo.bumpSuggested([decisionAId]);
    await repo.bumpSuggested([decisionAId]);
    await repo.bumpAccepted([decisionAId]);

    const page = await repo.listForUser(userId, { limit: 1000 });
    expect(page.items.find((d) => d.id === decisionAId)).toMatchObject({ suggested_count: 2, accepted_count: 1 });
  });

  it('listForUser: newest first, q matches header/question/answer case-insensitively, paginates by cursor, only the user\'s rows', async () => {
    // Dated far in the future so these three rows are always the newest for userId, regardless of when
    // other tests in this file ran (their rows use the DB default `now()`).
    const t0 = Date.parse('2030-01-01T00:00:00.000Z');
    const at = (i: number) => new Date(t0 + i * 1000);
    const mk = (i: number, header: string, question: string, ownerId = userId) => ({
      id: newId(),
      userId: ownerId,
      projectId,
      conversationId,
      questionIndex: 0,
      header,
      question,
      options,
      multiSelect: false,
      answer,
      createdAt: at(i),
    });
    const rowA = mk(0, 'Idioma', 'Qual idioma?');
    const rowB = mk(1, 'Cor', 'Qual cor?');
    const rowC = mk(2, 'Tema', 'Qual tema?');
    const otherRow = mk(3, 'Cor', 'Qual cor?', otherUserId);
    await db.chatDecision.createMany({ data: [rowA, rowB, rowC, otherRow] });

    const all = await repo.listForUser(userId, { limit: 1000 });
    const ids = all.items.map((d) => d.id);
    expect(ids.indexOf(rowC.id)).toBeLessThan(ids.indexOf(rowB.id));
    expect(ids.indexOf(rowB.id)).toBeLessThan(ids.indexOf(rowA.id));
    expect(ids).not.toContain(otherRow.id); // only this user's rows

    const filtered = await repo.listForUser(userId, { q: 'COR', limit: 1000 });
    expect(filtered.items.map((d) => d.id)).toEqual([rowB.id]);

    const page1 = await repo.listForUser(userId, { limit: 1 });
    expect(page1.items.map((d) => d.id)).toEqual([rowC.id]);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await repo.listForUser(userId, { limit: 1, cursor: page1.next_cursor! });
    expect(page2.items.map((d) => d.id)).toEqual([rowB.id]);

    // A cursor that cannot be decoded is treated as "no cursor": the first page again.
    const garbage = await repo.listForUser(userId, { limit: 1, cursor: 'not-a-real-cursor' });
    expect(garbage.items.map((d) => d.id)).toEqual([rowC.id]);
  });

  it('listForUser: q searches the project name and the answer\'s label/text values, never the raw jsonb keys', async () => {
    const otherProjectId = newId();
    await db.project.create({ data: { id: otherProjectId, key: `Z${otherProjectId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'Zebrafino', ownerId: userId } });
    try {
      const base = { userId, conversationId, questionIndex: 0, header: 'Busca', question: 'Qual busca?', options, multiSelect: false };
      const inOther = { ...base, id: newId(), projectId: otherProjectId, answer: { labels: ['Azul'] } };
      const byLabel = { ...base, id: newId(), projectId, answer: { labels: ['Magentado'] } };
      const byText = { ...base, id: newId(), projectId, answer: { labels: [], text: 'resposta livrestranha' } };
      await db.chatDecision.createMany({ data: [inOther, byLabel, byText] });

      const ids = async (q: string) => (await repo.listForUser(userId, { q, limit: 1000 })).items.map((d) => d.id);
      expect(await ids('zebrafino')).toEqual([inOther.id]);
      expect(await ids('magentad')).toEqual([byLabel.id]);
      expect(await ids('LIVRESTRANHA')).toEqual([byText.id]);
      // The jsonb keys are not content: every answer holds "labels", none of them should match it.
      expect(await ids('labels')).toEqual([]);
      expect(await ids('text')).toEqual([]);
    } finally {
      await db.project.deleteMany({ where: { id: otherProjectId } });
    }
  });

  it('deleteForUser: true for the owner\'s row, false for another user\'s or a missing id', async () => {
    const [row] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Layout', question: 'Qual layout?' })]);
    expect(await repo.deleteForUser(row!.id, otherUserId)).toBe(false);
    expect(await repo.deleteForUser(row!.id, userId)).toBe(true);
    expect(await repo.deleteForUser(row!.id, userId)).toBe(false); // already gone
    expect(await repo.deleteForUser(newId(), userId)).toBe(false); // never existed
  });

  it('countForUser', async () => {
    const before = await repo.countForUser(userId);
    await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Prioridade', question: 'Qual prioridade?' })]);
    expect(await repo.countForUser(userId)).toBe(before + 1);
  });

  it('listAnsweredChoicesWithoutDecision: an answered choice without decisions, never a permission nor an open choice, gone once recorded', async () => {
    const answeredChoiceId = newId();
    const permissionId = newId();
    const openChoiceId = newId();
    // Answered a couple of minutes ago: fresh enough to be well past the "answered in the last minute"
    // guard (claim sets `status: 'answered'` before the keys are actually sent — see the next test).
    const answeredAt = new Date(Date.now() - 2 * 60 * 1000);
    await db.tabQuestion.createMany({
      data: [
        { id: answeredChoiceId, tabId: 'tqd1', projectId, conversationId, kind: 'choice', payload: choicePayload, status: 'answered', answer: { answers: [{ selected: [0] }] }, answeredBy: userId, answeredAt },
        { id: permissionId, tabId: 'tqd2', projectId, conversationId, kind: 'permission', payload: { tool_name: 'Bash' }, status: 'answered', answer: { allow: true }, answeredBy: userId, answeredAt },
        { id: openChoiceId, tabId: 'tqd3', projectId, conversationId, kind: 'choice', payload: choicePayload, status: 'open' },
      ],
    });

    const before = await repo.listAnsweredChoicesWithoutDecision(10_000);
    const beforeIds = before.map((r) => r.id);
    expect(beforeIds).toContain(answeredChoiceId);
    expect(beforeIds).not.toContain(permissionId);
    expect(beforeIds).not.toContain(openChoiceId);
    const found = before.find((r) => r.id === answeredChoiceId)!;
    expect(found).toMatchObject({ project_id: projectId, conversation_id: conversationId, answered_by: userId });

    // excludeIds: the row is skipped while listed, back once it is not.
    const excluded = await repo.listAnsweredChoicesWithoutDecision(10_000, [answeredChoiceId]);
    expect(excluded.map((r) => r.id)).not.toContain(answeredChoiceId);
    const notExcluded = await repo.listAnsweredChoicesWithoutDecision(10_000, [newId()]);
    expect(notExcluded.map((r) => r.id)).toContain(answeredChoiceId);

    await repo.insertMany([newDecision({ tab_question_id: answeredChoiceId, header: 'Cor', question: 'Qual cor?' })]);

    const after = await repo.listAnsweredChoicesWithoutDecision(10_000);
    expect(after.map((r) => r.id)).not.toContain(answeredChoiceId);
  });

  it('listAnsweredChoicesWithoutDecision: ignores a row answered in the last minute', async () => {
    const justAnsweredId = newId();
    await db.tabQuestion.create({
      data: { id: justAnsweredId, tabId: 'tqd4', projectId, conversationId, kind: 'choice', payload: choicePayload, status: 'answered', answer: { answers: [{ selected: [0] }] }, answeredBy: userId, answeredAt: new Date() },
    });

    const rows = await repo.listAnsweredChoicesWithoutDecision(10_000);
    expect(rows.map((r) => r.id)).not.toContain(justAnsweredId);
  });

  it('users.chatSuggestions defaults to true; setChatSuggestions(false) turns it off', async () => {
    expect(await users.chatSuggestions(userId)).toBe(true);
    await users.setChatSuggestions(userId, false);
    expect(await users.chatSuggestions(userId)).toBe(false);
  });
});
