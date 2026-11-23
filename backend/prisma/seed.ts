// Demo accounts that sign in with username and password (no Google).
//
//   npm run db:seed                            creates the missing ones
//   SEED_RESET_PASSWORDS=true npm run db:seed  also gives the existing ones a new password
//
// Passwords are random and printed only when they're set: save them right away,
// the database keeps only their scrypt hash. Uses DATABASE_URL like the app.
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { hashPassword, normalizeUsername } from '../src/auth/password';

const USERS = [
  { username: 'ana', name: 'Ana Gómez', email: 'ana@notux.demo' },
  { username: 'luis', name: 'Luis Pérez', email: 'luis@notux.demo' },
];

// 12 characters without look-alikes (0/O, 1/l/I), easy to type on a phone.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomPassword(length = 12): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  // Rejection sampling keeps every character equally likely.
  for (const b of bytes) {
    if (b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length];
    if (out.length === length) break;
  }
  return out;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const reset = process.env.SEED_RESET_PASSWORDS === 'true';
  const created: { username: string; password: string }[] = [];
  try {
    for (const u of USERS) {
      const username = normalizeUsername(u.username);
      const existing = await prisma.user.findUnique({ where: { username } });
      if (existing && !reset) {
        console.log(`= ${username}: ya existe (contraseña sin cambios)`);
        continue;
      }
      const password = randomPassword();
      const passwordHash = await hashPassword(password);
      await prisma.user.upsert({
        where: { username },
        create: { username, passwordHash, name: u.name, email: u.email },
        update: { passwordHash },
      });
      if (existing) await prisma.refreshToken.deleteMany({ where: { userId: existing.id } }); // old sessions end
      created.push({ username, password });
      console.log(`+ ${username}: ${existing ? 'contraseña nueva' : 'creado'}`);
    }
  } finally {
    await prisma.$disconnect();
  }
  if (created.length) {
    console.log('\nGuarda estas contraseñas ahora; no se vuelven a mostrar:');
    for (const c of created) console.log(`  ${c.username.padEnd(8)} ${c.password}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
