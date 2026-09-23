import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { cityLinkFor } from '../lib/public-city';
import type { Machine, Project } from '../lib/types';
import { NicknameDialog } from './NicknameDialog';
import { PublishControl } from './PublishControl';

type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * Settings → Minha cidade: the signed-in user's own public city, for every account (no resource
 * grant). The nickname (set once, never changed), the city's address, and the projects this user
 * owns with the same publish switch as the project page. A project shows publicly only on the
 * machines its owner owns, so each row lists those and nothing else.
 */
export function MyCityView() {
  const { user, publicCityUrl, can } = useAuth();
  const { projects, machines, hiddenLocal, loading } = useData();
  const [choosingNickname, setChoosingNickname] = useState(false);

  const nickname = user?.nickname ?? null;
  const link = cityLinkFor(publicCityUrl, nickname);
  // An account that cannot list projects cannot own any either; its project list never loads, so
  // there is nothing to wait for.
  const canListProjects = can('projects', 'read');

  // Hidden local machines (someone's own computer added from another browser) still show publicly,
  // so they count here too.
  const ownMachines = useMemo(() => {
    const byId = new Map<string, Machine>();
    for (const m of [...machines, ...hiddenLocal]) if (user && m.owner_id === user.id) byId.set(m.id, m);
    return byId;
  }, [machines, hiddenLocal, user]);
  const publicMachinesOf = (p: Project) => p.machines.map((l) => ownMachines.get(l.machine_id)).filter((m): m is Machine => !!m);

  const mine = canListProjects && user ? projects.filter((p) => p.owner_id === user.id) : [];
  const onStreet = mine.some((p) => p.is_public && publicMachinesOf(p).length > 0);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Minha cidade</h1>
        <p className="text-sm text-fg-muted">Sua cidade pública mostra, para quem tiver o link, os projetos que você publicar, nas máquinas que são suas.</p>
      </div>

      <section className="rounded-lg border border-line bg-bg-2 p-4">
        <h2 className="text-sm font-semibold">Apelido</h2>
        {nickname ? (
          <>
            <p className="mt-2 font-mono text-sm">{nickname}</p>
            <p className="mt-1 text-xs text-fg-dim">O apelido não pode ser trocado: os links que você já compartilhou dependem dele.</p>
          </>
        ) : (
          <div className="mt-2 flex items-center gap-3">
            <p className="text-sm text-fg-muted">Você ainda não escolheu um apelido. Ele vira o endereço da sua cidade e não pode ser trocado depois.</p>
            <button type="button" className="btn-primary ml-auto shrink-0 text-xs" onClick={() => setChoosingNickname(true)}>
              Escolher apelido
            </button>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-line bg-bg-2 p-4">
        <h2 className="text-sm font-semibold">Link da cidade</h2>
        {link ? (
          <>
            <CityLink url={link} />
            {!onStreet && <p className="mt-2 text-xs text-warn">Nenhum projeto publicado ainda: quem abrir o link encontra a cidade vazia. Publique um projeto abaixo.</p>}
          </>
        ) : (
          <p className="mt-2 text-sm text-fg-muted">
            {nickname ? 'O endereço da cidade pública ainda não foi carregado.' : 'Escolha um apelido para ter o endereço da sua cidade pública.'}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Seus projetos</h2>
        {canListProjects && loading ? (
          <p className="text-sm text-fg-dim">Carregando…</p>
        ) : mine.length === 0 ? (
          <p className="rounded-lg border border-line bg-bg-2 p-4 text-sm text-fg-muted">Você ainda não tem projetos. Os projetos que você criar aparecem aqui para publicar na sua cidade.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-bg-2">
            {mine.map((p) => {
              const shown = publicMachinesOf(p);
              return (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="font-mono text-xs text-fg-dim">{p.key}</span>
                    </div>
                    <p className="truncate text-xs text-fg-dim">
                      {shown.length === 0 ? 'Sem máquina sua vinculada: não aparece na cidade.' : `${p.is_public ? 'Aparece em' : 'Apareceria em'}: ${shown.map((m) => m.name).join(', ')}`}
                    </p>
                  </div>
                  <Link to={`/projects/${p.id}`} className="shrink-0 text-xs text-accent hover:underline" aria-label={`Abrir projeto ${p.name}`}>
                    abrir →
                  </Link>
                  <PublishControl project={p} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <NicknameDialog open={choosingNickname} onClose={() => setChoosingNickname(false)} />
    </div>
  );
}

function CityLink({ url }: { url: string }) {
  const [status, setStatus] = useState<CopyStatus>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const id = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(id);
  }, [status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-bg-3 px-2 py-1 font-mono text-xs">{url}</code>
      <button type="button" className="btn-ghost text-xs" onClick={() => void copy()}>
        {status === 'copied' ? 'Copiado' : status === 'failed' ? 'Não foi possível copiar' : 'Copiar'}
      </button>
      <a href={url} target="_blank" rel="noopener noreferrer" className="btn-ghost text-xs">
        Abrir
      </a>
    </div>
  );
}
