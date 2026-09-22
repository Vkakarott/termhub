import { Link } from 'react-router-dom';
import type { ChatHostAccount, ChatHostMachine, ChatHostState } from '../../lib/types';

/**
 * The one sentence that says which login is running the conversation. `lost` reads as the machine's
 * default login too — because that is what is actually running — and the line below it says the
 * chosen account is not the one doing it.
 */
function accountClause(account: ChatHostAccount): string {
  return account.kind === 'chosen' ? `na conta ${account.label}` : 'na conta padrão do Claude dela';
}

/**
 * `(versão 0.4.9)`, or nothing when the agent never said which one it is — never an empty `(versão )`.
 *
 * The same one-liner lives in `apps/server/src/chat/host.ts`, for the sentence a *send* fails with
 * (`hostFailure`). Copied on purpose — one string across a process boundary, where a shared package
 * would cost more than it saves — so a change to the note's shape has to be made in both places, and
 * nothing will complain if one is missed.
 */
const versionNote = (version: string): string => (version ? ` (versão ${version})` : '');

export interface ChatHostProps {
  host: ChatHostState;
  /**
   * The machines to change the host to, loaded by the page when the change was asked for (`not_chosen`
   * brings its own list and never needs this). `null` = still being read.
   */
  machines: ChatHostMachine[] | null;
  /** The change picker is open: the warning is on screen and nothing has been changed yet. */
  picking: boolean;
  /** A host change is in flight: every choice is refused until it lands. */
  changing: boolean;
  /** What the last host change failed with, in the server's own pt-BR. */
  error: string | null;
  onPick: () => void;
  onCancelPick: () => void;
  onChoose: (machineId: string) => void;
}

/**
 * The line above the thread that says where this conversation runs, and what to do when it cannot run
 * at all. Five states, each one actionable: a machine and an account (`ready`), no machine of one's own
 * (`no_machine` — the product's honest shape, not an error), several to choose between (`not_chosen`),
 * one that is asleep (`offline`) and one whose agent does not know how to run a chat (`agent_too_old`).
 *
 * Presentational, like `ChatTurn` and `ChatActionCard`: every decision arrives as props, nothing is
 * fetched here and no state is kept. The page owns the reads, the `POST /api/chat/host` and the picker's
 * open/closed.
 *
 * The change warning (spec §3) is rendered *by opening the picker*, before anything is set: the button
 * that performs the change names the machine it changes to, so the sentence about the model's memory is
 * always read before the change happens, never after.
 */
export function ChatHost({ host, machines, picking, changing, error, onPick, onCancelPick, onChoose }: ChatHostProps) {
  // Which machine is the host right now, so the picker never offers to change to it.
  const current = host.kind === 'ready' || host.kind === 'offline' || host.kind === 'agent_too_old' ? host.machine : null;

  return (
    // `section`, named, so a screen reader can reach "where is this running" without walking the
    // thread, and so the tests read this region rather than the whole page.
    <section aria-label="Máquina do chat" className="pt-2 text-xs">
      {host.kind === 'ready' ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-fg-dim">
          <p>
            Esta conversa roda na máquina {host.machine.name}, {accountClause(host.account)}.
          </p>
          <ChangeButton onPick={onPick} picking={picking} />
        </div>
      ) : (
        // Every problem gets the same shape: what happened, what to do about it, and the way to do it.
        // `attention`, never `danger` — none of these is a failure of the chat, and one of them
        // (`no_machine`) is not a failure at all.
        <div className="rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm text-fg">
          {host.kind === 'no_machine' && (
            <>
              <p>O chat roda em uma máquina sua, e você ainda não cadastrou nenhuma.</p>
              <p className="mt-1 text-fg-dim">Cadastre uma máquina com o agente do termhub e o concierge passa a rodar nela.</p>
              {/* The enrolment itself lives in the app's sidebar (the "Nova máquina" form), so this is
                  the honest path to it: back to the app, where that button is. */}
              <Link to="/" className="mt-2 inline-block text-accent hover:underline">
                Cadastrar máquina
              </Link>
            </>
          )}
          {host.kind === 'not_chosen' && (
            <>
              <p>Você tem mais de uma máquina: escolha em qual o chat vai rodar.</p>
              {/* Only when there really is a session to lose (`sessionAtStake`): this conversation ran
                  on a machine it no longer names, so any other machine starts the model's memory over.
                  A first pick has nothing to lose and is not warned about — a warning that is usually
                  false is one nobody reads, and then the one that matters is invisible too. */}
              {host.sessionAtStake && <p className="mt-1 text-fg">Esta conversa já tem uma sessão numa máquina que não está mais escolhida. Se você escolher outra, o histórico fica, mas a memória do modelo começa de novo.</p>}
              <MachineList machines={host.machines} current={null} changing={changing} onChoose={onChoose} />
            </>
          )}
          {host.kind === 'offline' && (
            <>
              <p>A máquina {host.machine.name} está offline agora.</p>
              <p className="mt-1 text-fg-dim">Ligue-a para continuar esta conversa, ou troque a máquina do chat.</p>
            </>
          )}
          {host.kind === 'agent_too_old' && (
            <>
              <p>
                O agente da máquina {host.machine.name}
                {versionNote(host.version)} ainda não sabe rodar o chat.
              </p>
              <p className="mt-1 text-fg-dim">Atualize o agente dessa máquina para conversar por aqui.</p>
              {/* The update button lives on the machine itself (the app's machine form), not here — and
                  the agent updates itself while it is idle, so this points at it instead of asking
                  anyone to run a command on their own computer. */}
              <Link to="/" className="mt-2 inline-block text-accent hover:underline">
                Atualizar o agente
              </Link>
            </>
          )}
          {host.kind !== 'no_machine' && host.kind !== 'not_chosen' && (
            <div className="mt-2">
              <ChangeButton onPick={onPick} picking={picking} />
            </div>
          )}
        </div>
      )}

      {host.kind === 'ready' && host.account.kind === 'lost' && (
        // The silent degradation the payload knows about: the chosen account is not the one running.
        <p className="mt-1 text-fg-muted">A conta de IA que você escolheu não serve mais para essa máquina. Escolha outra em Contas de IA.</p>
      )}

      {picking && host.kind !== 'not_chosen' && (
        <div className="mt-2 rounded-xl border border-line bg-bg-2 px-4 py-3 text-sm">
          {/* Read before anything is changed, which is the whole point of the picker being a step. */}
          <p className="text-fg">Trocar de máquina começa uma sessão nova: o histórico desta conversa fica, mas a memória do modelo começa de novo.</p>
          {machines === null ? (
            <p className="mt-2 text-fg-dim">Carregando suas máquinas…</p>
          ) : machines.length === 0 ? (
            <p className="mt-2 text-fg-dim">Nenhuma outra máquina com o agente do termhub.</p>
          ) : (
            <MachineList machines={machines} current={current} changing={changing} onChoose={onChoose} prefix="Trocar para " />
          )}
          <button type="button" className="btn-ghost mt-2 px-2 py-1" onClick={onCancelPick}>
            Cancelar
          </button>
        </div>
      )}

      {error && <p className="mt-1 text-danger">{error}</p>}
    </section>
  );
}

function ChangeButton({ onPick, picking }: { onPick: () => void; picking: boolean }) {
  return (
    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={picking} onClick={onPick}>
      Trocar máquina
    </button>
  );
}

/**
 * The machines as buttons, one per row so a thumb can hit them. The current host is shown but not
 * offered: re-picking it would set the same pair again and say nothing new. `prefix` is what makes the
 * change button name its own consequence ("Trocar para jarvis") while the first choice is just the
 * machine's name.
 */
function MachineList({ machines, current, changing, onChoose, prefix = '' }: { machines: ChatHostMachine[]; current: ChatHostMachine | null; changing: boolean; onChoose: (machineId: string) => void; prefix?: string }) {
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {machines.map((m) => (
        <li key={m.id}>
          {m.id === current?.id ? (
            <span className="text-fg-dim">{m.name} (atual)</span>
          ) : (
            <button type="button" className="btn-ghost px-2 py-1" disabled={changing} onClick={() => onChoose(m.id)}>
              {prefix}
              {m.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
