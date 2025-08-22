'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand
} = require('@aws-sdk/lib-dynamodb');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Config
const PORT = process.env.PORT || 3000;
const S3_BUCKET = process.env.S3_BUCKET || 'luis-asset';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_UPLOAD_PREFIX = process.env.S3_UPLOAD_PREFIX || 'uploads/';
const DDB_TABLE = process.env.DDB_TABLE || 'uploads';
const AWS_REGION = process.env.AWS_REGION || S3_REGION;

// AWS clients
const s3 = new S3Client({ region: S3_REGION });
const ddb = new DynamoDBClient({ region: AWS_REGION });
const ddbDoc = DynamoDBDocumentClient.from(ddb);

// Helpers
function isValidId(id) {
  return typeof id === 'string' && id.startsWith(S3_UPLOAD_PREFIX);
}
function objectUrlFor(key) {
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

// UI en la misma ruta (sin archivos estáticos)
app.get('/', (_req, res) => {
  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Galería S3 + DynamoDB</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: #0b0c10;
      --card: #11131a;
      --muted: #8a94a6;
      --text: #e6eaf2;
      --brand: #4f7cff;
      --brand-2: #7aa2ff;
      --danger: #ff4d5a;
      --ok: #2cc29b;
      --border: #1b1f2a;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f7f8fb;
        --card: #ffffff;
        --muted: #5b6470;
        --text: #0f1222;
        --border: #e6e8ef;
      }
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font: 14px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, Arial, "Noto Sans", "Helvetica Neue", sans-serif; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom: 16px; }
    .brand { display:flex; align-items:center; gap:10px; }
    .logo { width:28px; height:28px; background:linear-gradient(135deg, var(--brand), var(--brand-2)); border-radius:8px; display:inline-block; }
    .brand h1 { font-size: 18px; margin:0; }
    .links a { color: var(--muted); text-decoration:none; margin-left:16px; }
    .links a:hover { color: var(--text); }
    .hero { background:linear-gradient(0deg, rgba(79,124,255,0.04), transparent 40%), var(--card); border:1px solid var(--border); border-radius: 16px; padding: 18px; margin-bottom: 18px; }
    .hero h2 { margin:0 0 8px; font-size: 18px; }
    .row { display:flex; gap:12px; align-items:center; flex-wrap: wrap; }
    input[type=text] { padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:transparent; color:var(--text); min-width: 240px; }
    button { cursor:pointer; padding:10px 14px; border-radius:10px; border:1px solid var(--border); background:var(--card); color:var(--text); transition: .15s ease; }
    button:hover { transform: translateY(-1px); border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,0.15); }
    #dropzone { border:1px dashed var(--border); background: rgba(79,124,255,0.06); border-radius: 12px; padding:18px; display:flex; align-items:center; gap:12px; }
    #dropzone.drag { border-color: var(--brand); background: rgba(79,124,255,0.12); }
    #file { display:none; }
    .btn-primary { background: linear-gradient(135deg, var(--brand), var(--brand-2)); border: none; color:white; }
    .btn-danger { border-color: #3a1d26; background: #2b1117; color:#ff9aa3; }
    .btn-danger:hover { box-shadow: 0 0 0 3px rgba(255,77,90,0.18); }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:16px; }
    .card { background: var(--card); border:1px solid var(--border); border-radius: 16px; padding: 14px; }
    .thumb { width:100%; aspect-ratio: 1.4 / 1; background:#0b0c10; border-radius:12px; display:flex; align-items:center; justify-content:center; overflow:hidden; border:1px solid var(--border); }
    .thumb img { width:100%; height:100%; object-fit: contain; display:block; }
    .meta { font-size: 12px; color: var(--muted); margin-top:10px; word-break: break-all; overflow-wrap: anywhere; }
    .meta strong { color: var(--text); font-weight: 600; }
    .actions { margin-top: 10px; display:flex; gap:8px; flex-wrap: wrap; }
    .tag { display:inline-flex; align-items:center; gap:6px; background:#0f1320; color:#9fb4ff; border:1px solid var(--border); border-radius: 999px; padding:4px 8px; font-size: 12px; }
    .link { color:#9fb4ff; text-decoration:none; }
    .link:hover { text-decoration: underline; }
    .toast { position: fixed; right: 18px; bottom: 18px; background: var(--card); border:1px solid var(--border); border-radius: 12px; padding: 10px 12px; color: var(--text); min-width: 220px; box-shadow: 0 10px 30px rgba(0,0,0,0.25); display:none; }
    .toast.ok { border-color: rgba(44,194,155,0.35); }
    .toast.err { border-color: rgba(255,77,90,0.35); }
    .sr { position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <span class="logo" aria-hidden="true"></span>
        <h1>Galería S3 + DynamoDB</h1>
      </div>
      <div class="links">
        <a href="/health" target="_blank" rel="noopener">Health</a>
        <a href="https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/" target="_blank" rel="noopener">Bucket</a>
      </div>
    </header>

    <section class="hero">
      <h2>Subir archivo</h2>
      <div id="dropzone" tabindex="0" role="button" aria-label="Zona para soltar archivo o hacer clic para seleccionar">
        <span>Arrastra y suelta aquí, o</span>
        <label for="file" class="btn-primary" style="padding:8px 12px; border-radius:8px; cursor:pointer;">Elegir archivo</label>
        <input id="file" type="file" accept="image/*" />
        <input id="note" type="text" placeholder="Nota (opcional)..." />
        <button id="btnUpload" class="btn-primary">Subir</button>
      </div>
      <div id="msg" style="margin-top:8px; color:#9fb4ff;"></div>
    </section>

    <section>
      <h2 style="margin: 0 0 12px;">Imágenes subidas</h2>
      <div id="gallery" class="grid" aria-live="polite"></div>
    </section>
  </div>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script>
    const $ = (sel) => document.querySelector(sel);
    const msg = $('#msg');
    const toast = $('#toast');
    let currentFile = null;

    function showToast(text, type='ok', timeout=2200) {
      toast.textContent = text;
      toast.className = 'toast ' + type;
      toast.style.display = 'block';
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => { toast.style.display = 'none'; }, timeout);
    }

    function setDropEvents() {
      const dz = $('#dropzone');
      ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag'); }));
      ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag'); }));
      dz.addEventListener('drop', e => {
        const f = e.dataTransfer?.files?.[0];
        if (f) { currentFile = f; msg.textContent = 'Archivo seleccionado: ' + f.name; }
      });
      dz.addEventListener('click', () => $('#file').click());
      $('#file').addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        if (f) { currentFile = f; msg.textContent = 'Archivo seleccionado: ' + f.name; }
      });
    }

    async function listGallery() {
      const res = await fetch('/api/db/list');
      const data = await res.json();
      const wrap = $('#gallery');
      wrap.innerHTML = '';
      (data.items || []).forEach((it) => {
        const card = document.createElement('div');
        card.className = 'card';

        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        const img = document.createElement('img');
        img.src = it.url;
        img.alt = it.id;
        thumb.appendChild(img);

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.innerHTML = \`
          <div class="tag"><strong>Tipo:</strong> \${it.contentType || '-'}</div>
          <div><strong>Id:</strong> \${it.id}</div>
          <div><strong>Creado:</strong> \${it.createdAt || '-'}</div>
          <div><strong>Nota:</strong> \${it.note || '-'}</div>
          <div><strong>URL:</strong> <a class="link" href="\${it.url}" target="_blank" rel="noopener">Abrir</a></div>
        \`;

        const actions = document.createElement('div');
        actions.className = 'actions';

        const btnCopy = document.createElement('button');
        btnCopy.textContent = 'Copiar URL';
        btnCopy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(it.url); showToast('URL copiada'); }
          catch { showToast('No se pudo copiar', 'err'); }
        });

        const btnNote = document.createElement('button');
        btnNote.textContent = 'Actualizar nota';
        btnNote.addEventListener('click', async () => {
          const note = prompt('Nueva nota para el item:', it.note || '');
          if (note === null) return;
          const r = await fetch('/api/db/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: it.id, note })
          });
          if (!r.ok) { showToast('Error actualizando', 'err'); return; }
          showToast('Nota actualizada');
          await listGallery();
        });

        const btnURL = document.createElement('button');
        btnURL.textContent = 'Actualizar URL';
        btnURL.addEventListener('click', async () => {
          const url = prompt('Nueva URL para el item:', it.url || '');
          if (url === null) return;
          const r = await fetch('/api/db/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: it.id, url })
          });
          if (!r.ok) { showToast('Error actualizando URL', 'err'); return; }
          showToast('URL actualizada');
          await listGallery();
        });

        const btnDel = document.createElement('button');
        btnDel.textContent = 'Eliminar';
        btnDel.className = 'btn-danger';
        btnDel.addEventListener('click', async () => {
          if (!confirm('¿Eliminar definitivamente este item?')) return;
          const r = await fetch('/api/db/delete?id=' + encodeURIComponent(it.id), { method: 'DELETE' });
          if (!r.ok) { showToast('Error eliminando', 'err'); return; }
          showToast('Eliminado');
          await listGallery();
        });

        actions.appendChild(btnCopy);
        actions.appendChild(btnNote);
        actions.appendChild(btnURL);
        actions.appendChild(btnDel);

        card.appendChild(thumb);
        card.appendChild(meta);
        card.appendChild(actions);
        wrap.appendChild(card);
      });
    }

    async function uploadFlow() {
      const f = currentFile || ($('#file').files?.[0]);
      const note = $('#note').value || undefined;
      if (!f) { showToast('Selecciona un archivo', 'err'); return; }
      try {
        // 1) Presign (GET, como ya usabas)
        const q = new URLSearchParams({ filename: f.name, contentType: f.type || 'application/octet-stream' });
        const res = await fetch('/api/s3/presign?' + q.toString());
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error('No se pudo prefirmar: ' + (err.error || res.status));
        }
        const { uploadUrl, key, publicUrl } = await res.json();

        // 2) PUT directo a S3
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': f.type || 'application/octet-stream' },
          body: f
        });
        if (!putRes.ok) throw new Error('Error subiendo: ' + putRes.status);

        // 3) Guardar en DDB
        const saveRes = await fetch('/api/db/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: key, url: publicUrl, contentType: f.type || 'application/octet-stream', note })
        });
        if (!saveRes.ok) {
          const err = await saveRes.json().catch(() => ({}));
          throw new Error('No se pudo guardar en DB: ' + (err.error || saveRes.status));
        }

        showToast('Subido correctamente');
        $('#file').value = ''; currentFile = null; $('#note').value = '';
        await listGallery();
      } catch (e) {
        console.error(e);
        showToast(e.message || String(e), 'err', 3200);
      }
    }

    document.addEventListener('DOMContentLoaded', () => {
      setDropEvents();
      $('#btnUpload').addEventListener('click', uploadFlow);
      listGallery();
    });
  </script>
</body>
</html>`);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// GET /api/s3/presign?filename=...&contentType=...
app.get('/api/s3/presign', async (req, res) => {
  try {
    const { filename = 'archivo', contentType = 'application/octet-stream' } = req.query;
    const base = path.basename(String(filename)).replace(/[^a-zA-Z0-9._-]/g, '_');
    const rand = crypto.randomBytes(4).toString('hex');
    const key = S3_UPLOAD_PREFIX + Date.now() + '_' + rand + '_' + base;

    const cmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType });
    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 });
    const publicUrl = objectUrlFor(key);
    res.json({ uploadUrl, key, publicUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo prefirmar', detail: e.message });
  }
});

// POST /api/db/save { id, url, contentType?, note? }
app.post('/api/db/save', async (req, res) => {
  try {
    const { id, url, contentType = 'application/octet-stream', note } = req.body || {};
    if (!isValidId(id)) return res.status(400).json({ error: 'id inválido' });
    if (!url) return res.status(400).json({ error: 'url requerida' });

    const item = {
      id,
      url,
      contentType,
      createdAt: new Date().toISOString()
    };
    if (typeof note === 'string' && note.length) item.note = note;

    await ddbDoc.send(new PutCommand({ TableName: DDB_TABLE, Item: item }));
    res.json({ ok: true, item });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar en DDB', detail: e.message });
  }
});

// GET /api/db/list
app.get('/api/db/list', async (_req, res) => {
  try {
    const out = await ddbDoc.send(new ScanCommand({ TableName: DDB_TABLE, Limit: 100 }));
    const items = (out.Items || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo listar desde DDB', detail: e.message });
  }
});

// POST /api/db/update { id, note?, url? }
app.post('/api/db/update', async (req, res) => {
  try {
    const { id, note, url } = req.body || {};
    if (!isValidId(id)) return res.status(400).json({ error: 'id inválido o faltante' });

    const setParts = [];
    const names = {};
    const values = {};

    if (typeof note === 'string') {
      setParts.push('#n = :n');
      names['#n'] = 'note';
      values[':n'] = note;
    }
    if (typeof url === 'string') {
      setParts.push('#u = :u');
      names['#u'] = 'url';
      values[':u'] = url;
    }

    if (setParts.length === 0) {
      return res.status(400).json({ error: 'Nada para actualizar (note o url requeridos)' });
    }

    const out = await ddbDoc.send(new UpdateCommand({
      TableName: DDB_TABLE,
      Key: { id },
      UpdateExpression: 'SET ' + setParts.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW'
    }));

    res.json({ ok: true, item: out.Attributes });
  } catch (e) {
    console.error('Update error:', e);
    res.status(500).json({ error: 'Error actualizando item', detail: String(e) });
  }
});

// DELETE /api/db/delete?id=uploads/...
app.delete('/api/db/delete', async (req, res) => {
  const id = req.query.id || (req.body && req.body.id);
  try {
    if (!isValidId(id)) return res.status(400).json({ error: 'id inválido o faltante' });

    await ddbDoc.send(new DeleteCommand({ TableName: DDB_TABLE, Key: { id } }));

    let s3Deleted = false;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: id }));
      s3Deleted = true;
    } catch (err) {
      console.warn('S3 delete failed for', id, err);
    }

    res.json({ ok: true, deleted: { ddb: true, s3: s3Deleted } });
  } catch (e) {
    console.error('Delete error:', e);
    res.status(500).json({ error: 'Error eliminando item', detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log('Servidor escuchando en puerto ' + PORT);
  console.log('Config:', { S3_BUCKET, S3_REGION, S3_UPLOAD_PREFIX, DDB_TABLE, AWS_REGION });
});
