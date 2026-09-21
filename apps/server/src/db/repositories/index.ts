import type { PrismaClient } from '../prisma.js';
import { UsersRepository } from './users.js';
import { SessionsRepository } from './sessions.js';
import { LoginAttemptsRepository } from './login-attempts.js';
import { LoginCodesRepository } from './login-codes.js';
import { MachinesRepository } from './machines.js';
import { ProjectsRepository } from './projects.js';
import { TabsRepository } from './tabs.js';
import { TasksRepository } from './tasks.js';
import { NotesRepository } from './notes.js';
import { IntegrationsRepository } from './integrations.js';
import { ProjectSetupRepository } from './project-setup.js';
import { TicketsRepository } from './tickets.js';
import { AiAccountsRepository } from './ai-accounts.js';
import { WaitlistRepository } from './waitlist.js';
import { RolesRepository } from './roles.js';
import { MachineHooksRepository } from './machine-hooks.js';
import { UploadsRepository } from './uploads.js';
import { ApiTokensRepository } from './api-tokens.js';
import { ChatRepository } from './chat.js';

export interface Repositories {
  users: UsersRepository;
  sessions: SessionsRepository;
  loginAttempts: LoginAttemptsRepository;
  loginCodes: LoginCodesRepository;
  machines: MachinesRepository;
  projects: ProjectsRepository;
  tabs: TabsRepository;
  tasks: TasksRepository;
  notes: NotesRepository;
  integrations: IntegrationsRepository;
  projectSetup: ProjectSetupRepository;
  tickets: TicketsRepository;
  aiAccounts: AiAccountsRepository;
  machineHooks: MachineHooksRepository;
  waitlist: WaitlistRepository;
  roles: RolesRepository;
  uploads: UploadsRepository;
  apiTokens: ApiTokensRepository;
  chat: ChatRepository;
}

export function createRepositories(db: PrismaClient): Repositories {
  return {
    users: new UsersRepository(db),
    sessions: new SessionsRepository(db),
    loginAttempts: new LoginAttemptsRepository(db),
    loginCodes: new LoginCodesRepository(db),
    machines: new MachinesRepository(db),
    projects: new ProjectsRepository(db),
    tabs: new TabsRepository(db),
    tasks: new TasksRepository(db),
    notes: new NotesRepository(db),
    integrations: new IntegrationsRepository(db),
    projectSetup: new ProjectSetupRepository(db),
    tickets: new TicketsRepository(db),
    aiAccounts: new AiAccountsRepository(db),
    machineHooks: new MachineHooksRepository(db),
    waitlist: new WaitlistRepository(db),
    roles: new RolesRepository(db),
    uploads: new UploadsRepository(db),
    apiTokens: new ApiTokensRepository(db),
    chat: new ChatRepository(db),
  };
}

export * from './types.js';
export type { Integration, IntegrationProvider } from './integrations.js';
export type { ProjectSetup } from './project-setup.js';
export type { WaitlistEntry } from './waitlist.js';
export type { Role, PermissionGrant } from './roles.js';
export type { Upload } from './uploads.js';
export { SYSTEM_ROLE_IDS } from './roles.js';
export type { ChatConversation, ChatMessage, ChatRole } from './chat.js';
