# 🔧 Fix: Transaction Management Error in Shots Worker

## 🔴 Novo Problema Identificado

Após corrigir a estrutura da tabela, um novo erro apareceu:

```
error: current transaction is aborted, commands ignored until end of transaction block
Error code: 25P02
at markShotAsError (/opt/render/project/src/dist/db/shotsQueue.js:145:20)
```

## 🔍 Causa Raiz

### O Fluxo com Bug:

1. Worker pega um job usando `pickPendingShot()` que inicia uma transação
2. `handleJob()` é chamado com o client da transação
3. Um erro ocorre durante o processamento (ex: erro no Telegram API)
4. O catch dentro de `handleJob()` tenta chamar `markShotAsError(job.id, message, client)`
5. **PROBLEMA**: A transação já está ABORTADA pelo erro anterior
6. PostgreSQL rejeita o comando `markShotAsError` com erro 25P02
7. O erro se propaga e causa mais problemas

### Por que isso acontece?

No PostgreSQL, quando uma transação encontra um erro:
- A transação entra em estado "aborted"
- **TODOS** os comandos subsequentes são rejeitados
- A única operação permitida é `ROLLBACK`

### Código Original (BUGADO):

```typescript
// Em handleJob():
} catch (err) {
  const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
  await markShotAsError(job.id, message, client); // ❌ USA CLIENT ABORTADO
  jobLogger.error({ err }, '[SHOTS][WORKER] job failed');
}

// No worker tick:
try {
  await handleJob(job, client);
  await client.query('COMMIT');
} catch (batchErr) {
  await client.query('ROLLBACK').catch(() => undefined);
  // ❌ Erro já aconteceu dentro do handleJob
} finally {
  client.release();
}
```

## ✅ Solução Implementada

### Mudanças no código:

**1. Remover `markShotAsError` de dentro do catch de `handleJob()`:**

```typescript
// Em handleJob():
} catch (err) {
  // DO NOT call markShotAsError here with the aborted transaction client
  // It will be handled in the outer catch block after ROLLBACK
  jobLogger.error({ err }, '[SHOTS][WORKER] job failed');
  throw err; // Re-throw to trigger ROLLBACK in outer handler
}
```

**2. Fazer ROLLBACK primeiro, depois marcar erro com nova conexão:**

```typescript
// No worker tick:
try {
  await handleJob(job, client);
  await client.query('COMMIT');
} catch (batchErr) {
  // STEP 1: Rollback the aborted transaction
  await client.query('ROLLBACK').catch(() => undefined);
  client.release();
  
  // STEP 2: Mark as error using a NEW connection (pool directly)
  const errorMessage = batchErr instanceof Error ? batchErr.message : String(batchErr ?? 'unknown error');
  try {
    await markShotAsError(job.id, errorMessage); // ✅ No client param = uses pool
    workerLogger.error({ err: batchErr, shot_id: job.id }, '[SHOTS][WORKER] batch failed, marked as error');
  } catch (markErr) {
    workerLogger.error(
      { err: markErr, original_error: batchErr, shot_id: job.id },
      '[SHOTS][WORKER] failed to mark shot as error after batch failure'
    );
  }
  return; // Don't re-release client
}

client.release(); // Only release on success path
```

### Por que isso funciona?

1. ✅ Quando ocorre erro, fazemos **ROLLBACK imediatamente**
2. ✅ Liberamos o client da transação abortada
3. ✅ Usamos uma **nova conexão do pool** para chamar `markShotAsError`
4. ✅ A nova conexão não está em estado abortado, então funciona
5. ✅ Se `markShotAsError` falhar, logamos mas não travamos o worker

## 📁 Arquivo Modificado

- ✅ `src/services/shots/worker.ts` - Corrigido gerenciamento de transações

## 🚀 Deploy

Este fix pode ser deployado junto com a correção da tabela `shots_queue`.

```bash
git add src/services/shots/worker.ts
git commit -m "fix: correct transaction management in shots worker"
git push
```

## ✅ Resultado Esperado

Após o deploy:
- ✅ Worker processa shots normalmente
- ✅ Se ocorrer erro durante processamento, faz ROLLBACK corretamente
- ✅ Shot é marcado como 'error' usando nova conexão
- ✅ Sem mais erros "transaction is aborted"
- ✅ Worker continua processando próximos jobs

## 🔍 Como Testar

1. Criar um shot no admin
2. Monitorar logs do worker
3. Verificar se o shot é processado sem erros de transação
4. Se houver erro legítimo (ex: bot desconhecido), deve logar como error sem travar

## 📊 Logs Esperados

**Sucesso:**
```
[SHOTS][WORKER] processing job
[SHOTS][AUDIENCE] selecting audience
[SHOTS][WORKER] audience selected
[SHOTS][WORKER] processing batch
[SHOTS][WORKER] batch completed
[SHOTS][WORKER] job completed successfully
```

**Erro (agora tratado corretamente):**
```
[SHOTS][WORKER] processing job
[SHOTS][WORKER] job failed
[SHOTS][WORKER] batch failed, marked as error
```

**NÃO deve aparecer mais:**
```
❌ current transaction is aborted, commands ignored until end of transaction block
```

---

## 🎯 Status: ✅ CORRIGIDO

O bug de gerenciamento de transações foi identificado e corrigido. Pronto para deploy!

