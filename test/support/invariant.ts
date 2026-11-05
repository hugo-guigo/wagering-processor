// Invariante final da seção 13, conferida depois de cada teste de integração e de concorrência
// (carregado com --preload): para toda wallet do banco, saldo gravado == saldo reconstruído pelo ledger.
import { afterEach, expect } from 'bun:test';
import { sql } from '../integration/support/database';

afterEach(async () => {
  const divergentes = await sql`
    select w.id, w.balance_minor as saldo, coalesce(l.net, 0) as ledger
      from wallets w
      left join (select wallet_id, sum(case direction when 'CREDIT' then amount_minor else -amount_minor end) as net
                   from wallet_ledger_entries group by wallet_id) l on l.wallet_id = w.id
     where w.balance_minor <> coalesce(l.net, 0)`;
  expect(divergentes).toEqual([]);
});
