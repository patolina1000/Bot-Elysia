#!/usr/bin/env tsx
/**
 * Script de teste para verificar se delay_minutes funciona corretamente
 * 
 * Testa:
 * 1. Validação de range (5-60)
 * 2. Inserção/Update com delay_minutes
 * 3. Leitura correta do valor
 */

import { pool } from '../src/db/pool.js';
import { 
  upsertDownsell, 
  listDownsellsByBot, 
  deleteDownsell,
  type UpsertDownsellInput 
} from '../src/db/downsells.js';

const TEST_BOT_SLUG = 'test-delay-minutes-bot';

async function testDelayMinutesValidation() {
  console.log('\n📝 Teste 1: Validação de delay_minutes (5-60)');
  
  const validValues = [5, 10, 30, 60];
  const invalidValues = [4, 0, -1, 61, 100];

  // Testar valores válidos
  for (const delay of validValues) {
    try {
      const input: UpsertDownsellInput = {
        bot_slug: TEST_BOT_SLUG,
        trigger_kind: 'after_start',
        delay_minutes: delay,
        title: `Test Delay ${delay}`,
        price_cents: 100,
      };
      
      await upsertDownsell(input);
      console.log(`  ✅ delay_minutes=${delay} aceito corretamente`);
    } catch (error: any) {
      console.error(`  ❌ delay_minutes=${delay} rejeitado incorretamente:`, error.message);
      return false;
    }
  }

  // Testar valores inválidos (devem falhar)
  for (const delay of invalidValues) {
    try {
      const input: UpsertDownsellInput = {
        bot_slug: TEST_BOT_SLUG,
        trigger_kind: 'after_start',
        delay_minutes: delay,
        title: `Test Delay ${delay}`,
        price_cents: 100,
      };
      
      await upsertDownsell(input);
      console.error(`  ❌ delay_minutes=${delay} foi aceito mas deveria ser rejeitado`);
      return false;
    } catch (error: any) {
      // Esperamos que falhe com constraint violation
      if (error.message.includes('delay_minutes') || error.code === '23514') {
        console.log(`  ✅ delay_minutes=${delay} rejeitado corretamente`);
      } else {
        console.error(`  ⚠️  delay_minutes=${delay} falhou mas com erro inesperado:`, error.message);
      }
    }
  }

  return true;
}

async function testUpsertAndRead() {
  console.log('\n📝 Teste 2: Insert/Update e leitura de delay_minutes');

  try {
    // Inserir
    const inserted = await upsertDownsell({
      bot_slug: TEST_BOT_SLUG,
      trigger_kind: 'after_pix',
      delay_minutes: 25,
      title: 'Test Insert',
      price_cents: 150,
      message_text: 'Teste de inserção',
    });

    if (inserted.delay_minutes !== 25) {
      console.error(`  ❌ delay_minutes inserido incorretamente: esperado 25, recebido ${inserted.delay_minutes}`);
      return false;
    }
    console.log(`  ✅ Insert com delay_minutes=25 bem-sucedido (id=${inserted.id})`);

    // Update
    const updated = await upsertDownsell({
      id: inserted.id,
      bot_slug: TEST_BOT_SLUG,
      trigger_kind: 'after_pix',
      delay_minutes: 45,
      title: 'Test Update',
      price_cents: 150,
    });

    if (updated.delay_minutes !== 45) {
      console.error(`  ❌ delay_minutes atualizado incorretamente: esperado 45, recebido ${updated.delay_minutes}`);
      return false;
    }
    console.log(`  ✅ Update com delay_minutes=45 bem-sucedido`);

    // Ler
    const list = await listDownsellsByBot(TEST_BOT_SLUG);
    const found = list.find(d => d.id === inserted.id);
    
    if (!found) {
      console.error(`  ❌ Não foi possível encontrar o downsell criado`);
      return false;
    }

    if (found.delay_minutes !== 45) {
      console.error(`  ❌ delay_minutes lido incorretamente: esperado 45, recebido ${found.delay_minutes}`);
      return false;
    }
    console.log(`  ✅ Leitura de delay_minutes=45 bem-sucedida`);

    return true;
  } catch (error: any) {
    console.error(`  ❌ Erro durante teste de upsert:`, error.message);
    return false;
  }
}

async function testColumnExists() {
  console.log('\n📝 Teste 0: Verificar se coluna delay_minutes existe');
  
  try {
    const result = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns 
       WHERE table_name = 'downsells' 
         AND column_name = 'delay_minutes'`
    );

    if (result.rows.length === 0) {
      console.error('  ❌ Coluna delay_minutes NÃO EXISTE na tabela downsells');
      console.error('  💡 Execute: npm run migrate');
      return false;
    }

    console.log(`  ✅ Coluna delay_minutes existe (tipo: ${result.rows[0].data_type})`);

    // Verificar constraint
    const constraintResult = await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) as def
       FROM pg_constraint 
       WHERE conrelid = 'downsells'::regclass 
         AND pg_get_constraintdef(oid) LIKE '%delay_minutes%'`
    );

    if (constraintResult.rows.length > 0) {
      console.log(`  ✅ Constraint encontrada: ${constraintResult.rows[0].conname}`);
      console.log(`     ${constraintResult.rows[0].def}`);
    } else {
      console.warn('  ⚠️  Nenhuma constraint específica para delay_minutes encontrada');
    }

    return true;
  } catch (error: any) {
    console.error('  ❌ Erro ao verificar coluna:', error.message);
    return false;
  }
}

async function cleanup() {
  console.log('\n🧹 Limpando dados de teste...');
  
  try {
    const result = await pool.query(
      `DELETE FROM downsells WHERE bot_slug = $1`,
      [TEST_BOT_SLUG]
    );
    console.log(`  ✅ ${result.rowCount} registro(s) removido(s)`);
  } catch (error: any) {
    console.warn('  ⚠️  Erro ao limpar:', error.message);
  }
}

async function main() {
  console.log('🧪 Iniciando testes de delay_minutes\n');
  console.log('=' .repeat(60));

  let allPassed = true;

  // Teste 0: Verificar estrutura
  const columnExists = await testColumnExists();
  if (!columnExists) {
    console.error('\n❌ FALHA CRÍTICA: Coluna delay_minutes não existe');
    console.error('Execute as migrations antes de continuar: npm run migrate');
    process.exit(1);
  }

  // Teste 1: Validação
  const test1 = await testDelayMinutesValidation();
  allPassed = allPassed && test1;

  // Teste 2: CRUD
  const test2 = await testUpsertAndRead();
  allPassed = allPassed && test2;

  // Limpeza
  await cleanup();

  console.log('\n' + '='.repeat(60));
  if (allPassed) {
    console.log('✅ TODOS OS TESTES PASSARAM');
    console.log('\n💡 delay_minutes está funcionando corretamente!');
    console.log('   - Validação 5-60: ✅');
    console.log('   - Insert/Update: ✅');
    console.log('   - Leitura: ✅');
  } else {
    console.log('❌ ALGUNS TESTES FALHARAM');
    console.log('\n💡 Verifique os erros acima e corrija antes de usar em produção');
    process.exit(1);
  }
}

main()
  .catch(error => {
    console.error('\n❌ Erro fatal:', error);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
