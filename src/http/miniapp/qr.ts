import { Router, Request, Response } from 'express';
import { getPaymentByExternalId } from '../../db/payments.js';

export const miniappQrRouter = Router();

// Página webview (Mini App) — não cria nova transação
miniappQrRouter.get('/miniapp/qr', async (req: Request, res: Response): Promise<void> => {
  // HTML simples, estilizado com a paleta da Elysia (azul/ciano)
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Pagamento selecionado: PIX</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root{
      --bg:#0d0f14;
      --card:#141923;
      --text:#e9eef7;
      --muted:#9fb2c8;
      --accent1:#19c3ff; /* ciano da marca */
      --accent2:#4b7cff; /* azul da marca */
    }
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, 'Helvetica Neue', Arial;}
    .wrap{max-width:520px;margin:0 auto;padding:16px 14px 28px}
    .brand{
      display:flex;
      align-items:center;
      justify-content:center;      /* <-- centraliza horizontalmente */
      gap:10px;
      margin:4px 0 12px;
      text-align:center;           /* garante centralização do texto */
      width:100%;
    }
    .logo{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent1),var(--accent2))}
    .title{
      font-weight:700;
      font-size:18px;
      line-height:1.2;
      white-space:normal;          /* permite quebra em telas estreitas */
    }
    .card{background:var(--card);border-radius:14px;padding:14px;border:1px solid rgba(255,255,255,.06)}
    .headline{font-weight:800;font-size:20px;background:linear-gradient(135deg,var(--accent1),var(--accent2));-webkit-background-clip:text;color:transparent;margin:0 0 8px}
    .muted{color:var(--muted);font-size:13px}
    .qr{display:flex;justify-content:center;margin:14px 0}
    .qr img{width:280px;max-width:100%;border-radius:12px;background:#fff;padding:10px}
    .code{background:#0a0d12;border:1px dashed #2a3242;color:#bcd4f2;border-radius:10px;padding:10px;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;overflow:auto;word-break:break-all}
    .row{display:flex;gap:10px}
    .btn{flex:1;display:inline-flex;justify-content:center;align-items:center;height:44px;border-radius:10px;border:none;cursor:pointer;font-weight:700}
    .btn-copy{background:linear-gradient(135deg,var(--accent1),var(--accent2));color:#081018}
    .btn-done{background:#1f2838;color:#dfe9f7;border:1px solid #2b364a}
    .foot{margin-top:12px;font-size:11px;color:#8fa6bf}
    .foot-hero{
      margin-top:16px;
      text-align:center;
      font-size:18px;
      font-weight:900;
      background:linear-gradient(135deg,var(--accent1),var(--accent2));
      -webkit-background-clip:text;
      color:transparent;
    }
    .foot-hero .ok{
      background:none !important;
      color:#22c55e !important;
      -webkit-text-fill-color:#22c55e !important;
      display:inline-block;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="logo"></div>
      <div class="title">Elysia • Telegram Bot Builders</div>
    </div>
    <div class="card">
      <h2 class="headline">Pagamento selecionado: PIX</h2>
      <div class="muted">Realize o pagamento dentro do prazo; caso contrário, ele poderá ser cancelado.</div>
      <div class="qr"><img id="qr" alt="QR Code PIX"/></div>
      <div id="fallback" class="muted" style="display:none">Não foi possível exibir a imagem do QR agora.</div>
      <div class="code" id="emv">Carregando...</div>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-copy" id="copy">Copiar código</button>
        <button class="btn btn-done" id="done">Fechar</button>
      </div>
      <div class="foot foot-hero">Entrega garantida <span class="ok" aria-hidden="true">✅</span></div>
    </div>
  </div>
  <script>
    const tg = window.Telegram?.WebApp;
    try { tg?.ready(); tg?.expand(); } catch(e){}
    const tx = new URLSearchParams(location.search).get('tx');
    async function load() {
      const initData = tg?.initData || '';
      const r = await fetch('/api/miniapp/qr', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ tx, initData })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Erro ao carregar QR');
      document.getElementById('emv').textContent = data.qr_code || '—';
      const img = document.getElementById('qr');
      if (data.qr_code_base64) {
        img.src = data.qr_code_base64;
      } else {
        document.getElementById('fallback').style.display = 'block';
        img.style.display = 'none';
      }
    }
    load().catch(e => {
      document.getElementById('emv').textContent = 'Falha: ' + e.message;
    });
    document.getElementById('copy').onclick = async () => {
      const code = document.getElementById('emv').textContent;
      try { await navigator.clipboard.writeText(code); tg?.HapticFeedback?.notificationOccurred('success'); } catch(_e){}
    };
    document.getElementById('done').onclick = () => { try { tg?.close(); } catch(e){ window.close(); } };
  </script>
</body>
</html>`);
});

// API: devolve o EMV e o QR base64 da transação já criada
miniappQrRouter.post('/api/miniapp/qr', async (req: Request, res: Response): Promise<void> => {
  try {
    const { tx } = req.body || {};
    if (!tx) {
      res.status(400).json({ error: 'tx ausente' });
      return;
    }

    const row = await getPaymentByExternalId('pushinpay', tx);
    if (!row) {
      res.status(404).json({ error: 'transação não encontrada' });
      return;
    }

    res.json({
      qr_code: row.qr_code,
      qr_code_base64: row.qr_code_base64,
      value_cents: row.value_cents,
      plan_name: row.plan_name,
      status: row.status,
    });
  } catch (e) {
    const error = e as Error;
    res.status(500).json({ error: error.message });
  }
});
