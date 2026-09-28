-- TER-325: a project grant can trust the board only (the TER-111 default) or everything in the project.
ALTER TABLE "chat_project_grants" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'board';
