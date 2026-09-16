/**
 * Cria um usuário via CLI. Uso:
 *   npm run create-user -- --email you@example.com --name "Seu Nome" [--password ...] [--role owner|member]
 * Sem --password, pergunta de forma interativa (sem eco).
 * O primeiro usuário criado vira "owner" automaticamente.
 */
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { z } from 'zod';
import { openDb, closeDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories/index.js';
import { hashPassword } from '../src/auth/password.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
    role: { type: 'string' },
  },
});
// Também aceita posicionais: create-user <email> <nome> [senha]
values.email ??= positionals[0];
values.name ??= positionals[1];
values.password ??= positionals[2];

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onKey = (rl as unknown as { _writeToOutput: (s: string) => void });
    const original = onKey._writeToOutput;
    process.stdout.write(question);
    onKey._writeToOutput = () => {};
    rl.question('', (answer) => {
      onKey._writeToOutput = original;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

const schema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8, 'senha precisa ter ao menos 8 caracteres').max(1024),
  role: z.enum(['owner', 'member']).optional(),
});

async function main() {
  const email = values.email ?? (await ask('E-mail: '));
  const name = values.name ?? (await ask('Nome: '));
  let password = values.password;
  if (!password) {
    password = await askHidden('Senha: ');
    const confirm = await askHidden('Confirme a senha: ');
    if (password !== confirm) {
      console.error('As senhas não conferem.');
      process.exit(1);
    }
  }
  const input = schema.parse({ email, name, password, role: values.role });

  const db = openDb();
  runMigrations(db);
  const repos = createRepositories(db);

  if (repos.users.findByEmail(input.email)) {
    console.error(`Já existe um usuário com o e-mail ${input.email}.`);
    process.exit(1);
  }
  const role = input.role ?? (repos.users.count() === 0 ? 'owner' : 'member');
  const user = repos.users.create({
    email: input.email,
    name: input.name,
    password_hash: await hashPassword(input.password),
    role,
  });
  console.log(`Usuário criado: ${user.email} (${user.role}) — id ${user.id}`);
  closeDb();
}

main().catch((err) => {
  if (err instanceof z.ZodError) {
    console.error('Dados inválidos:', err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  } else {
    console.error(err);
  }
  process.exit(1);
});
