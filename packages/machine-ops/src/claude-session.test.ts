import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, lstatSync, renameSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeLinkScript, isClaudeSessionId, isClaudeTranscriptPath, parseClaudeLinkStatus } from './claude-session.js';

const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
const SLUG = '-home-p-proj';

function home() {
  const h = mkdtempSync(path.join(tmpdir(), 'th-link-'));
  const a = path.join(h, '.claude_a');
  mkdirSync(path.join(a, 'projects', SLUG), { recursive: true });
  const src = path.join(a, 'projects', SLUG, `${SID}.jsonl`);
  writeFileSync(src, '{"type":"user"}\n');
  mkdirSync(path.join(h, '.claude'), { recursive: true });
  return { h, a, src };
}
const run = (h: string, script: string) => execFileSync('/bin/sh', ['-c', script], { env: { HOME: h, PATH: process.env.PATH }, encoding: 'utf8' }).trim();

describe('isClaudeSessionId / isClaudeTranscriptPath', () => {
  it('accepts a lowercase uuid only', () => {
    expect(isClaudeSessionId(SID)).toBe(true);
    expect(isClaudeSessionId(SID.toUpperCase())).toBe(false);
    expect(isClaudeSessionId(`${SID}'`)).toBe(false);
    expect(isClaudeSessionId(42)).toBe(false);
  });
  it('accepts <abs dir>/projects/<slug>/<id>.jsonl only', () => {
    expect(isClaudeTranscriptPath(`/home/p/.claude/projects/${SLUG}/${SID}.jsonl`, SID)).toBe(true);
    expect(isClaudeTranscriptPath(`~/.claude/projects/${SLUG}/${SID}.jsonl`, SID)).toBe(false);
    expect(isClaudeTranscriptPath(`/home/p/.claude/projects/${SLUG}/other.jsonl`, SID)).toBe(false);
    expect(isClaudeTranscriptPath(`/home/p/.claude/projects/../x/${SID}.jsonl`, SID)).toBe(false);
    expect(isClaudeTranscriptPath(`/home/p/.claude/projects/a\nb/${SID}.jsonl`, SID)).toBe(false);
    expect(isClaudeTranscriptPath(`/home/p/projects/${SLUG}/${SID}.jsonl`.repeat(200), SID)).toBe(false);
  });
});

describe('claudeLinkScript', () => {
  it('links the transcript into the default account (null config dir = ~/.claude)', () => {
    const { h, src } = home();
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('linked');
    const t = path.join(h, '.claude', 'projects', SLUG, `${SID}.jsonl`);
    expect(lstatSync(t).isSymbolicLink()).toBe(true);
    expect(readlinkSync(t)).toBe(src);
  });
  it('expands ~/ in the target dir on the machine', () => {
    const { h, src } = home();
    mkdirSync(path.join(h, '.claude_b'));
    expect(run(h, claudeLinkScript(src, SID, '~/.claude_b'))).toBe('linked');
    expect(readFileSync(path.join(h, '.claude_b', 'projects', SLUG, `${SID}.jsonl`), 'utf8')).toContain('user');
  });
  it('links the session directory too when it exists', () => {
    const { h, a, src } = home();
    mkdirSync(path.join(a, 'projects', SLUG, SID));
    run(h, claudeLinkScript(src, SID, null));
    expect(lstatSync(path.join(h, '.claude', 'projects', SLUG, SID)).isSymbolicLink()).toBe(true);
  });
  it('is idempotent', () => {
    const { h, src } = home();
    run(h, claudeLinkScript(src, SID, null));
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('linked');
  });
  it('answers same_account when the target is the source dir', () => {
    const { h, a, src } = home();
    expect(run(h, claudeLinkScript(src, SID, a))).toBe('same_account');
  });
  it('answers no_transcript / no_config_dir', () => {
    const { h, src } = home();
    const missing = '0e9c1d2a-0000-4000-8000-000000000000';
    expect(run(h, claudeLinkScript(src.replace(SID, missing), missing, null))).toBe('no_transcript');
    expect(run(h, claudeLinkScript(src, SID, '~/.nope'))).toBe('no_config_dir');
  });
  it('never overwrites a different file (conflict)', () => {
    const { h, src } = home();
    const dir = path.join(h, '.claude', 'projects', SLUG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${SID}.jsonl`), 'other');
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('conflict');
    expect(readFileSync(path.join(dir, `${SID}.jsonl`), 'utf8')).toBe('other');
  });
  // TER-587: leaving a session whose worktree had no changes removes the worktree, and Claude Code moves
  // the transcript to the main repository's project dir; the path the hook reported no longer exists.
  it('finds the transcript moved to another project dir of the same account, and links it there', () => {
    const { h, a, src } = home();
    const main = path.join(a, 'projects', '-home-p');
    mkdirSync(main, { recursive: true });
    const moved = path.join(main, `${SID}.jsonl`);
    renameSync(src, moved);
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('linked');
    const t = path.join(h, '.claude', 'projects', '-home-p', `${SID}.jsonl`);
    expect(readlinkSync(t)).toBe(moved);
  });
  it('replaces a link it left dangling (the transcript moved after the first link)', () => {
    const { h, src } = home();
    run(h, claudeLinkScript(src, SID, null));
    const t = path.join(h, '.claude', 'projects', SLUG, `${SID}.jsonl`);
    const other = path.join(h, 'elsewhere.jsonl');
    rmSync(t);
    symlinkSync(other, t); // points nowhere
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('linked');
    expect(readlinkSync(t)).toBe(src);
  });
  // TER-587 (seen with TER-447): a session that went through this account before left a copy there,
  // which is an older prefix of the transcript. It is kept aside, never deleted, and replaced by the link.
  it('moves aside an older copy that is a prefix of the transcript, then links', () => {
    const { h, src } = home();
    writeFileSync(src, '{"type":"user"}\n{"type":"assistant"}\n');
    const dir = path.join(h, '.claude', 'projects', SLUG);
    mkdirSync(dir, { recursive: true });
    const t = path.join(dir, `${SID}.jsonl`);
    writeFileSync(t, '{"type":"user"}\n');
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('linked');
    expect(readlinkSync(t)).toBe(src);
    const aside = readdirSync(dir).filter((f) => f.startsWith(`${SID}.jsonl.termhub-old-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(path.join(dir, aside[0]), 'utf8')).toBe('{"type":"user"}\n');
  });
  it('a copy that is not a prefix stays a conflict, untouched', () => {
    const { h, src } = home();
    const dir = path.join(h, '.claude', 'projects', SLUG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${SID}.jsonl`), '{"type":"user"}\n{"type":"other"}\n{"more":1}\n');
    expect(run(h, claudeLinkScript(src, SID, null))).toBe('conflict');
    expect(readdirSync(dir)).toEqual([`${SID}.jsonl`]);
  });
  it('swapping back (B → A) through B\'s symlink is linked, not a conflict', () => {
    const { h, a, src } = home();
    run(h, claudeLinkScript(src, SID, null));
    const viaB = path.join(h, '.claude', 'projects', SLUG, `${SID}.jsonl`);
    expect(run(h, claudeLinkScript(viaB, SID, a))).toBe('linked');
  });
  it('keeps hostile values inert', () => {
    const { h } = home();
    const evil = `/tmp/$(touch ${h}/pwned)/projects/x/${SID}.jsonl`;
    expect(run(h, claudeLinkScript(evil, SID, "~/'; touch pwned2; '"))).toBe('no_transcript');
    expect(() => lstatSync(path.join(h, 'pwned'))).toThrow();
  });
});

describe('parseClaudeLinkStatus', () => {
  it('reads the last known word', () => {
    expect(parseClaudeLinkStatus('linked\n')).toBe('linked');
    expect(parseClaudeLinkStatus('noise\nsame_account')).toBe('same_account');
    expect(parseClaudeLinkStatus('whatever')).toBeNull();
  });
});
