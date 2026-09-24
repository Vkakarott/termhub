import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, FolderPlus, Laptop, ListChecks, SquareTerminal, X, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { useProjectGroups } from '../lib/project-groups';
import { homeStep, loadNextStepsDismissed, nextSteps, saveNextStepsDismissed, starterProjects, type NextStep } from '../lib/home-onboarding';
import type { DashboardItem, Machine } from '../lib/types';
import { NeedsYouList } from '../components/NeedsYouList';
import { ProjectCards } from '../components/ProjectCards';
import { PageFrame } from '../components/PageHeader';
import { MachineForm } from '../components/MachineForm';
import { ProjectForm } from '../components/ProjectForm';

/** while no machine is visible, the account is re-read this often (a machine connected by someone else) */
const WAIT_MACHINE_MS = 15_000;

/**
 * Início: a guide through the three required steps (connect a machine, create a project, open a
 * terminal) until the account has done them, then the projects dashboard with the optional next
 * steps. Contas de IA, Hardware and Waitlist live in Configurações.
 */
export function HomePage() {
  const { user, can } = useAuth();
  const { machines, projects, loading, refresh } = useData();
  const { openTabs, openTabsLoaded } = useMonitor();
  const { groups } = useProjectGroups();
  // Both forms live here, outside the step being shown: creating a machine refreshes the data and
  // moves the home to step 2 while the form still shows the one-time enrollment token.
  const [machineForm, setMachineForm] = useState<{ machine: Machine | null } | null>(null);
  const [projectFormOpen, setProjectFormOpen] = useState(false);

  const step = homeStep({ loading: loading || !openTabsLoaded, machines, projects, openTabs });

  useEffect(() => {
    if (step !== 1) return;
    const t = setInterval(() => void refresh(), WAIT_MACHINE_MS);
    return () => clearInterval(t);
  }, [step, refresh]);

  let body: ReactNode;
  if (step === 'loading') {
    body = <p className="text-sm text-fg-muted">Carregando…</p>;
  } else if (step === 1) {
    body = (
      <StepCard step={1} icon={Laptop} title="Conecte sua primeira máquina">
        <p>
          Os terminais rodam nas suas máquinas: o seu computador ou um servidor. Um agente leve roda nela e conecta ao termhub, sem SSH e sem portas
          abertas.
        </p>
        {can('machines', 'create') ? (
          <button type="button" className="btn-primary mt-4" onClick={() => setMachineForm({ machine: null })}>
            Conectar máquina
          </button>
        ) : (
          <p className="mt-3 text-fg">Peça a um administrador para conectar uma máquina à sua conta.</p>
        )}
        <p className="mt-3 text-xs text-fg-dim">Esta página avança sozinha assim que a máquina aparecer.</p>
      </StepCard>
    );
  } else if (step === 2) {
    body = (
      <StepCard step={2} icon={FolderPlus} title="Crie seu primeiro projeto">
        <p>Um projeto junta os terminais, as tarefas e as notas de um trabalho, numa pasta de uma das suas máquinas.</p>
        {can('projects', 'create') ? (
          <button type="button" className="btn-primary mt-4" onClick={() => setProjectFormOpen(true)}>
            Criar projeto
          </button>
        ) : (
          <p className="mt-3 text-fg">Peça a um administrador para criar um projeto para você ou compartilhar um com a sua conta.</p>
        )}
      </StepCard>
    );
  } else if (step === 3) {
    body = (
      <StepCard step={3} icon={SquareTerminal} title="Abra seu primeiro terminal">
        <p>Entre num projeto e abra um terminal na aba Terminais. Dali você roda o Claude Code, o Codex ou o que quiser.</p>
        <ul aria-label="Projetos" className="mt-4 space-y-1.5 text-left">
          {starterProjects(projects).map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="flex items-center gap-2 rounded-md border border-line bg-bg-3 px-3 py-2 text-fg hover:border-accent/50">
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                <span className="shrink-0 text-xs text-fg-dim">{p.key}</span>
                <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-fg-dim" />
              </Link>
            </li>
          ))}
        </ul>
      </StepCard>
    );
  } else {
    body = (
      <>
        {user && (
          <NextStepsCard
            key={user.id}
            userId={user.id}
            steps={nextSteps({ machines, projects, groups, nickname: user.nickname, canUpdateMachines: can('machines', 'update') })}
            onInstallHooks={(m) => setMachineForm({ machine: m })}
          />
        )}
        <Dashboard />
      </>
    );
  }

  return (
    <PageFrame title="Início">
      {body}
      {machineForm && <MachineForm key={machineForm.machine?.id ?? 'new'} open machine={machineForm.machine} onClose={() => setMachineForm(null)} />}
      {projectFormOpen && <ProjectForm open onClose={() => setProjectFormOpen(false)} />}
    </PageFrame>
  );
}

/** A required step: a centred card saying where the account is ("Passo N de 3"). */
function StepCard({ step, icon: Icon, title, children }: { step: 1 | 2 | 3; icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="mx-auto mt-4 max-w-md rounded-xl border border-line bg-bg-2 p-6 text-center sm:mt-10">
      <div className="mb-3 flex items-center justify-center gap-1.5" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-1.5 w-6 rounded-full ${n <= step ? 'bg-accent' : 'bg-bg-4'}`} />
        ))}
      </div>
      <p className="text-xs font-medium text-fg-muted">Passo {step} de 3</p>
      <span className="mx-auto mt-3 flex h-11 w-11 items-center justify-center rounded-full bg-accent/15 text-accent">
        <Icon size={22} aria-hidden="true" />
      </span>
      <h2 className="mt-3 text-lg font-semibold text-fg">{title}</h2>
      <div className="mt-2 text-sm text-fg-muted">{children}</div>
    </section>
  );
}

/** The optional steps still missing; "Dispensar" hides it for good (per user, per browser). */
function NextStepsCard({ userId, steps, onInstallHooks }: { userId: string; steps: NextStep[]; onInstallHooks: (m: Machine) => void }) {
  const [dismissed, setDismissed] = useState(() => loadNextStepsDismissed(userId));
  if (dismissed || steps.length === 0) return null;
  return (
    <section aria-labelledby="next-steps-title" className="mb-5 max-w-2xl rounded-lg border border-line bg-bg-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <ListChecks size={16} aria-hidden="true" className="shrink-0 text-accent" />
        <h2 id="next-steps-title" className="flex-1 text-sm font-semibold">
          Próximos passos
        </h2>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg"
          onClick={() => {
            saveNextStepsDismissed(userId);
            setDismissed(true);
          }}
        >
          <X size={12} aria-hidden="true" />
          Dispensar
        </button>
      </div>
      <ul className="mt-2 space-y-2 text-sm">
        {steps.map((s) => (
          <li key={s.kind} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted">
            <NextStepItem step={s} onInstallHooks={onInstallHooks} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextStepItem({ step, onInstallHooks }: { step: NextStep; onInstallHooks: (m: Machine) => void }) {
  if (step.kind === 'hooks') {
    const [first, ...rest] = step.machines;
    return (
      <>
        <span className="min-w-0 flex-1">
          Instale os hooks do monitor em <span className="text-fg">{first.name}</span>
          {rest.length > 0 && ` e mais ${rest.length}`}: sem eles, as tabs não aparecem em “Precisando de você”.
        </span>
        <button type="button" className="btn-ghost border border-line px-2 py-0.5 text-xs" onClick={() => onInstallHooks(first)}>
          Instalar hooks
        </button>
      </>
    );
  }
  if (step.kind === 'city') {
    return (
      <Link to="/settings/city" className="min-w-0 flex-1 text-fg hover:text-accent">
        {step.hasNickname ? 'Publique sua cidade: escolha os projetos que aparecem nela' : 'Escolha seu apelido e publique sua cidade'}
      </Link>
    );
  }
  return (
    <span className="min-w-0 flex-1">
      Fixe um projeto em <span className="text-fg">Favoritos</span>: use o alfinete na linha do projeto, na sidebar.
    </span>
  );
}

function Dashboard() {
  const { statuses, projects } = useData();
  const [items, setItems] = useState<DashboardItem[] | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.dashboard()
      .then((r) => !cancelled && setItems(r.items))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
    // recarrega quando a lista de projetos mudar (criação/status/contadores)
  }, [projects]);

  const totalDoing = items?.reduce((n, i) => n + i.doing.length, 0) ?? 0;
  const totalOpen = items?.reduce((n, i) => n + i.open_tasks, 0) ?? 0;

  return (
    <div>
      <NeedsYouList now={now} />
      <div className="mb-5 flex items-end gap-4">
        <div>
          <h2 className="text-lg font-semibold">O que estou fazendo</h2>
          <p className="text-sm text-fg-muted">
            {items ? `${items.length} projeto(s) ativo(s) · ${totalDoing} em andamento · ${totalOpen} aberta(s)` : 'Carregando…'}
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-danger">Não foi possível carregar o dashboard.</p>}
      {items && items.length === 0 && (
        <p className="text-sm text-fg-dim">Nenhum projeto ativo. Clique em "+ projeto" na sidebar.</p>
      )}

      {items && <ProjectCards items={items} statuses={statuses} />}
    </div>
  );
}
