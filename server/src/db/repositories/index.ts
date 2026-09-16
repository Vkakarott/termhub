import type { PrismaClient } from '../prisma.js';
import { UsersRepository } from './users.js';
import { SessionsRepository } from './sessions.js';
import { LoginAttemptsRepository } from './login-attempts.js';
import { LoginCodesRepository } from './login-codes.js';
import { MachinesRepository } from './machines.js';
import { ProjectsRepository } from './projects.js';
import { TabsRepository } from './tabs.js';

export interface Repositories {
  users: UsersRepository;
  sessions: SessionsRepository;
  loginAttempts: LoginAttemptsRepository;
  loginCodes: LoginCodesRepository;
  machines: MachinesRepository;
  projects: ProjectsRepository;
  tabs: TabsRepository;
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
  };
}

export * from './types.js';
