import { Link } from 'react-router-dom';
import type { ChatHostAccount, ChatHostAiAccount, ChatHostMachine, ChatHostState } from '../../lib/types';

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

/** The option key that stands for "no account": the machine's own default Claude login. Never a real
 *  account id — the server takes ids of at least one character — so it cannot collide with one. */
const DEFAULT_ACCOUNT = '';

export interface ChatHostProps {
  host: ChatHostState;
  /**
   * The machines to change the host to, loaded by the page when the change was asked for (`not_chosen`
   * brings its own list and never needs this). `null` = still being read.
   */
  machines: ChatHostMachine[] | null;
  /**
   * The Claude accounts of the machine that hosts the conversation right now, as the page read them;
   * `null` = still being read. The machine's own default login is not one of these — it is always
   * offered, as an option of its own, because "no account chosen" is a real answer and not an absence.
   */
  accounts: ChatHostAiAccount[] | null;
  /**
   * The account id stored on the conversation, so the picker can show which option is the current one.
   * `null` = the machine's default login. An id that no longer names an account of this machine (the
   * `lost` state) matches no option, and then nothing is marked current — which is exactly right:
   * there is nothing to keep, and every option is a change.
   */
  accountId: string | null;
  /** The change picker is open: the warning is on screen and nothing has been changed yet. */
  picking: boolean;
  /** A host change is in flight: every choice is refused until it lands. */
  changing: boolean;
  /** What the last host change failed with, in the server's own pt-BR. */
  error: string | null;
  onPick: () => void;
  onCancelPick: () => void;
  onChoose: (machineId: string) => void;
  /** Changes only the account, on the machine that already hosts the conversation. `null` = its default login. */
  onChooseAccount: (aiAccountId: string | null) => void;
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
export function ChatHost({ host, machines, accounts, accountId, picking, changing, error, onPick, onCancelPick, onChoose, onChooseAccount }: ChatHostProps) {
  // Which machine is the host right now, so the picker never offers to change to it.
  const current = host.kind === 'ready' || host.kind === 'offline' || host.kind === 'agent_too_old' ? host.machine : null;
  // The machine's own default login first, then its registered Claude accounts: the default is an
  // option and not the absence of one, which is what makes "go back to the default login" something a
  // person can actually choose instead of a state they can only leave.
  const accountOptions: Choice[] = [{ key: DEFAULT_ACCOUNT, name: 'conta padrão da máquina' }, ...(accounts ?? []).map((a) => ({ key: a.id, name: a.label }))];
  const currentAccountKey = accountId ?? DEFAULT_ACCOUNT;
  // What the picker can actually change to. Counted, because a picker that warns about a change and
  // then offers nothing but the current pair and Cancelar is a dead end dressed as a choice.
  const otherMachines = (machines ?? []).filter((m) => m.id !== current?.id);
  const otherAccounts = accountOptions.filter((o) => o.key !== currentAccountKey);
  const changeable = otherMachines.length > 0 || (current !== null && otherAccounts.length > 0);

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
              <ChoiceList options={host.machines.map((m) => ({ key: m.id, name: m.name }))} currentKey={null} changing={changing} onChoose={onChoose} />
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

      {host.kind === 'ready' && host.sessionAtStake && (
        // The host moved without anyone asking: the machine that held this conversation's session is
        // gone, the only one left was picked for them, and the next message starts the model over. Said
        // here because nothing else ever will — the failed resume and the restart are both invisible.
        <p className="mt-1 text-warn">A máquina que rodava esta conversa não está mais disponível, e ela passou para {host.machine.name}: o histórico fica, mas a memória do modelo começa de novo.</p>
      )}

      {host.kind === 'ready' && host.account.kind === 'lost' && (
        // The silent degradation the payload knows about: the chosen account is not the one running.
        // …and it points at the picker below, which is the one place that can set this conversation's
        // account. "Contas de IA" manages a machine's logins and cannot choose the chat's.
        <p className="mt-1 text-fg-muted">A conta de IA que você escolheu não serve mais para essa máquina. Use “Trocar máquina ou conta” para escolher outra.</p>
      )}

      {picking && host.kind !== 'not_chosen' && (
        <div className="mt-2 rounded-xl border border-line bg-bg-2 px-4 py-3 text-sm">
          {/* Read before anything is changed, which is the whole point of the picker being a step — and
              only when there is a change to make: the account moves the CLI session just as the machine
              does (the session lives in one config dir), so this one sentence covers both. A warning
              over a dead end is the kind nobody reads, and then the one that matters is invisible too. */}
          {changeable && <p className="text-fg">Trocar de máquina ou de conta começa uma sessão nova: o histórico desta conversa fica, mas a memória do modelo começa de novo.</p>}
          {machines === null ? (
            <p className="mt-2 text-fg-dim">Carregando suas máquinas…</p>
          ) : otherMachines.length === 0 ? (
            // No *other* machine is the same dead end as no machine at all: there is nothing to switch
            // to, and saying so beats a list whose only row is the machine already running this.
            <p className="mt-2 text-fg-dim">Nenhuma outra máquina com o agente do termhub.</p>
          ) : (
            <ChoiceList options={machines.map((m) => ({ key: m.id, name: m.name }))} currentKey={current?.id ?? null} changing={changing} onChoose={onChoose} prefix="Trocar para " />
          )}
          {/* The other half of the pair (spec §3), on the machine that is hosting right now: without it
              `ai_account_id` could only ever be null and the chosen/lost states were unreachable. Only
              where there is a machine to read them from — `no_machine` has no accounts to speak of. */}
          {current !== null && (
            <>
              <p className="mt-3 text-fg-dim">Conta do Claude em {current.name}</p>
              {accounts === null ? (
                <p className="mt-1 text-fg-dim">Carregando as contas dessa máquina…</p>
              ) : otherAccounts.length === 0 ? (
                <p className="mt-1 text-fg-dim">Essa máquina não tem outra conta do Claude cadastrada em Contas de IA.</p>
              ) : (
                <ChoiceList
                  options={accountOptions}
                  currentKey={currentAccountKey}
                  changing={changing}
                  onChoose={(key) => onChooseAccount(key === DEFAULT_ACCOUNT ? null : key)}
                  prefix="Trocar para "
                />
              )}
            </>
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
      Trocar máquina ou conta
    </button>
  );
}

/** One row of a picker: what it is called, and the key the choice is made with. */
interface Choice {
  key: string;
  name: string;
}

/**
 * The options as buttons, one per row so a thumb can hit them — used for both halves of the pair, the
 * machines and the host machine's Claude accounts, so neither can end up looking or behaving like a
 * different kind of choice. The current one is shown but not offered: re-picking it would set the same
 * pair again and say nothing new. `currentKey` is `null` when none of them is current, which is the
 * `lost` account — the stored id names nothing here, so every option really is a change. `prefix` is
 * what makes the change button name its own consequence ("Trocar para jarvis") while a first choice is
 * just the name.
 */
function ChoiceList({ options, currentKey, changing, onChoose, prefix = '' }: { options: Choice[]; currentKey: string | null; changing: boolean; onChoose: (key: string) => void; prefix?: string }) {
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {options.map((o) => (
        <li key={o.key}>
          {o.key === currentKey ? (
            <span className="text-fg-dim">{o.name} (atual)</span>
          ) : (
            <button type="button" className="btn-ghost px-2 py-1" disabled={changing} onClick={() => onChoose(o.key)}>
              {prefix}
              {o.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
