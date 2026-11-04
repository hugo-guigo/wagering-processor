// Uso: bun run migrate [up|down]. "down" desfaz a última migration.
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infra/database/mikro-orm.config';

const direcao = process.argv[2] ?? 'up';
const orm = await MikroORM.init(config);
try {
  const feitas = direcao === 'down' ? await orm.migrator.down() : await orm.migrator.up();
  console.log(`${direcao}: ${feitas.map(m => m.name).join(', ') || 'nada a fazer'}`);
} finally {
  await orm.close();
}
