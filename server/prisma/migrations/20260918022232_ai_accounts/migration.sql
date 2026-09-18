-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('claude', 'chatgpt', 'gemini');

-- CreateTable
CREATE TABLE "ai_accounts" (
    "id" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "label" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "config_dir" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_accounts_machine_id_idx" ON "ai_accounts"("machine_id");

-- AddForeignKey
ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
