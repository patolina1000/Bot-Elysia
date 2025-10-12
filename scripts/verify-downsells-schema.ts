#!/usr/bin/env tsx
/**
 * Verifica se o schema de downsells está correto e completo
 */

import { pool } from '../src/db/pool.js';

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

async function checkTable(tableName: string, expectedColumns: string[]): Promise<boolean> {
  try {
    const result = await pool.query<ColumnInfo>(
      `SELECT column_name, data_type, is_nullable 
       FROM information_schema.columns 
       WHERE table_name = $1
       ORDER BY column_name`,
      [tableName]
    );

    if (result.rows.length === 0) {
      console.error(`❌ Tabela '${tableName}' não existe`);
      return false;
    }

    const existingColumns = result.rows.map(r => r.column_name);
    const missingColumns = expectedColumns.filter(col => !existingColumns.includes(col));
    const extraColumns = existingColumns.filter(col => !expectedColumns.includes(col));

    console.log(`\n✅ Tabela '${tableName}' existe com ${existingColumns.length} colunas:`);
    result.rows.forEach(row => {
      const nullable = row.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      console.log(`  - ${row.column_name}: ${row.data_type} ${nullable}`);
    });

    if (missingColumns.length > 0) {
      console.warn(`⚠️  Colunas esperadas mas não encontradas: ${missingColumns.join(', ')}`);
    }

    if (extraColumns.length > 0 && !['id', 'created_at', 'updated_at'].some(c => extraColumns.includes(c))) {
      console.info(`ℹ️  Colunas extras: ${extraColumns.join(', ')}`);
    }

    return missingColumns.length === 0;
  } catch (error) {
    console.error(`❌ Erro ao verificar tabela '${tableName}':`, error);
    return false;
  }
}

async function checkIndexes(tableName: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT indexname, indexdef 
       FROM pg_indexes 
       WHERE tablename = $1
       ORDER BY indexname`,
      [tableName]
    );

    if (result.rows.length > 0) {
      console.log(`\n📊 Índices em '${tableName}':`);
      result.rows.forEach(row => {
        console.log(`  - ${row.indexname}`);
      });
    } else {
      console.warn(`⚠️  Nenhum índice encontrado em '${tableName}'`);
    }
  } catch (error) {
    console.error(`❌ Erro ao verificar índices de '${tableName}':`, error);
  }
}

async function main() {
  console.log('🔍 Verificando schema de downsells...\n');

  let allOk = true;

  // Verifica tabela principal
  const downsellsOk = await checkTable('downsells', [
    'id',
    'bot_slug',
    'trigger_kind',
    'delay_minutes',
    'title',
    'price_cents',
    'message_text',
    'media1_url',
    'media1_type',
    'media2_url',
    'media2_type',
    'window_enabled',
    'window_start_hour',
    'window_end_hour',
    'window_tz',
    'daily_cap_per_user',
    'ab_enabled',
    'is_active',
    'created_at',
    'updated_at',
  ]);
  allOk = allOk && downsellsOk;
  await checkIndexes('downsells');

  // Verifica tabela de variantes
  const variantsOk = await checkTable('downsells_variants', [
    'id',
    'downsell_id',
    'key',
    'weight',
    'title',
    'price_cents',
    'message_text',
    'media1_url',
    'media1_type',
    'media2_url',
    'media2_type',
    'created_at',
    'updated_at',
  ]);
  allOk = allOk && variantsOk;
  await checkIndexes('downsells_variants');

  // Verifica tabela de fila
  const queueOk = await checkTable('downsells_queue', [
    'id',
    'downsell_id',
    'bot_slug',
    'telegram_id',
    'scheduled_at',
    'sent_at',
    'status',
    'error',
    'created_at',
    'updated_at',
  ]);
  allOk = allOk && queueOk;
  await checkIndexes('downsells_queue');

  // Verifica tabela de métricas (opcional)
  const metricsOk = await checkTable('downsell_metrics', [
    'id',
    'bot_slug',
    'downsell_id',
    'event',
    'telegram_id',
    'meta',
    'created_at',
  ]);
  if (metricsOk) {
    await checkIndexes('downsell_metrics');
  } else {
    console.warn('\n⚠️  Tabela de métricas não existe. Execute: npm run migrate');
  }

  // Verifica se há dados
  try {
    const countResult = await pool.query('SELECT COUNT(*) as total FROM downsells');
    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);
    console.log(`\n📈 Total de downsells cadastrados: ${total}`);
  } catch (error) {
    console.error('❌ Erro ao contar downsells:', error);
  }

  console.log('\n' + '='.repeat(60));
  if (allOk) {
    console.log('✅ Schema verificado com sucesso!');
    console.log('\n💡 Próximos passos:');
    console.log('   1. Se a tabela de métricas não existe: npm run migrate');
    console.log('   2. Teste a API: POST /admin/api/downsells/upsert');
    console.log('   3. Verifique as métricas: GET /admin/api/downsells/metrics?bot_slug=X');
  } else {
    console.log('❌ Alguns problemas foram encontrados no schema.');
    console.log('\n💡 Para corrigir:');
    console.log('   1. Execute: npm run migrate');
    console.log('   2. Verifique se todas as migrations foram aplicadas');
    process.exit(1);
  }
}

main()
  .catch(error => {
    console.error('❌ Erro fatal:', error);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
