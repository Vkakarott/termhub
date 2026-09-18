/**
 * Cria um usuário via CLI. Uso:
 *   npm run create-user -- --email you@example.com --name "Seu Nome" [--password ...] [--role owner|member]
 *   npm run create-user -- you@example.com "Seu Nome"
 *   (Docker, prod blue/green) docker exec termhub-app-$(cat /mnt/hd2tb/projetos/termhub/active-color) node apps/server/dist/cli/create-user.js you@example.com "Seu Nome"
 * A senha é opcional: sem ela, o usuário entra pelo código enviado por e-mail (ou Google).
 * O primeiro usuário criado vira "owner".
 */
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { z } from 'zod';
import { getPrisma, closePrisma } from '../db/prisma.js';
import { createRepositories } from '../db/repositories/index.js';
import { hashPassword } from '../auth/password.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
    'ask-password': { type: 'boolean', default: false },
    role: { type: 'string' },
  },
});
values.email ??= positionals[0];
values.name ??= positionals[1];
values.password ??= positionals[2];

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const io = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = io._writeToOutput;
    process.stdout.write(question);
    io._writeToOutput = () => {};
    rl.question('', (answer) => {
      io._writeToOutput = original;
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
  password: z.string().min(8, 'senha precisa ter ao menos 8 caracteres').max(1024).optional(),
  role: z.enum(['owner', 'member']).optional(),
});

async function main() {
  const email = values.email ?? (await ask('E-mail: '));
  const name = values.name ?? (await ask('Nome: '));
  let password = values.password;
  if (!password && values['ask-password']) {
    password = await askHidden('Senha: ');
    const confirm = await askHidden('Confirme a senha: ');
    if (password !== confirm) {
      console.error('As senhas não conferem.');
      process.exit(1);
    }
  }
  const input = schema.parse({ email, name, password: password || undefined, role: values.role });

  const repos = createRepositories(getPrisma());
  if (await repos.users.findByEmail(input.email)) {
    console.error(`Já existe um usuário com o e-mail ${input.email}.`);
    process.exit(1);
  }
  const role = input.role ?? ((await repos.users.count()) === 0 ? 'owner' : 'member');
  const user = await repos.users.create({
    email: input.email,
    name: input.name,
    password_hash: input.password ? await hashPassword(input.password) : null,
    role,
  });
  console.log(`Usuário criado: ${user.email} (${user.role}) — id ${user.id}${input.password ? '' : ' — login por código de e-mail'}`);
  await closePrisma();
}

main().catch(async (err) => {
  if (err instanceof z.ZodError) {
    console.error('Dados inválidos:', err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  } else {
    console.error(err);
  }
  await closePrisma();
  process.exit(1);
});
