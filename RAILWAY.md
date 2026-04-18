# Despliegue en Railway

Guía paso a paso para poner MedAlert en producción en **Railway.app**.

---

## Opción A — Desde GitHub (recomendado)

### 1. Sube el proyecto a GitHub

```bash
cd medical-alerts
git init
git add .
git commit -m "Initial commit"
# Crea un repo vacío en github.com y luego:
git remote add origin https://github.com/TU-USUARIO/medical-alerts.git
git branch -M main
git push -u origin main
```

### 2. Crea el proyecto en Railway

1. Entra a [railway.app](https://railway.app) y haz login con GitHub.
2. Click en **New Project** → **Deploy from GitHub repo**.
3. Selecciona el repo `medical-alerts`.
4. Railway detecta Node.js automáticamente y empieza a construir.

### 3. Configura las variables de entorno

En tu proyecto de Railway, ve a la pestaña **Variables** y añade:

| Variable          | Valor                                                           |
|-------------------|-----------------------------------------------------------------|
| `NODE_ENV`        | `production`                                                    |
| `SESSION_SECRET`  | Un string largo y aleatorio (ej. usa `openssl rand -hex 32`)    |
| `WEBHOOK_API_KEY` | Otra clave secreta larga (esta la usará n8n)                    |
| `DB_PATH`         | `/data/alerts.db`                                               |

**NO añadas `PORT`** — Railway lo asigna automáticamente.

### 4. Crea un volumen persistente (MUY IMPORTANTE)

SQLite necesita un disco persistente o perderás los datos en cada redeploy.

1. En tu servicio de Railway, ve a **Settings** → **Volumes**.
2. Click en **New Volume**.
3. **Mount path**: `/data`
4. **Size**: 1 GB es más que suficiente.
5. Guarda. Railway reinicia el servicio.

### 5. Genera tu dominio público

1. En **Settings** → **Networking** → **Generate Domain**.
2. Railway te da una URL tipo `https://medical-alerts-production.up.railway.app`.
3. Abre esa URL en el navegador → deberías ver el login.

Entra con `admin / admin123` y listo.

---

## Opción B — Con la CLI de Railway (sin GitHub)

Si prefieres subirlo directamente sin GitHub:

```bash
# Instala la CLI
npm install -g @railway/cli

# Login
railway login

# Desde la carpeta del proyecto
cd medical-alerts
railway init
railway up

# Añade variables
railway variables --set NODE_ENV=production
railway variables --set SESSION_SECRET=$(openssl rand -hex 32)
railway variables --set WEBHOOK_API_KEY=tu-clave-secreta-aqui
railway variables --set DB_PATH=/data/alerts.db

# Genera dominio público
railway domain
```

Luego añade el volumen desde el dashboard web (paso 4 de arriba) — la CLI aún no soporta crear volúmenes.

---

## Conectar n8n a tu Railway

Una vez desplegado, en n8n cambia la URL del nodo HTTP Request a:

```
https://TU-APP.up.railway.app/api/webhook/alert
```

Y en los headers, el `X-API-Key` debe coincidir con el `WEBHOOK_API_KEY` que pusiste en Railway.

Prueba con cURL desde cualquier sitio:

```bash
curl -X POST https://TU-APP.up.railway.app/api/webhook/alert \
  -H "Content-Type: application/json" \
  -H "X-API-Key: TU-WEBHOOK-API-KEY" \
  -d '{
    "type": "emergencia",
    "title": "Prueba desde n8n",
    "patient_name": "Paciente test",
    "description": "Esta alerta viene de un cURL de prueba"
  }'
```

Abre el dashboard y deberías verla aparecer en tiempo real.

---

## Troubleshooting Railway

### "Application failed to respond"
- Mira los **Deploy Logs** en Railway. El error suele estar ahí.
- Verifica que pusiste `NODE_ENV=production` en las variables.

### "Cannot GET /" al abrir el dominio
- Verifica que en los logs aparece el banner `Sistema de Alertas Médicas` con el puerto correcto.
- Confirma que la carpeta `public/` se subió al repo (el `.gitignore` no la excluye, pero revisa).

### Los datos desaparecen tras cada deploy
- Te falta el volumen. Ve a Settings → Volumes → New Volume con mount path `/data`.
- Confirma que la variable `DB_PATH=/data/alerts.db` está configurada.

### El login no mantiene la sesión
- Asegúrate de tener `NODE_ENV=production` configurado — activa `cookie.secure = true` para HTTPS.
- Railway siempre sirve con HTTPS, así que esto debe funcionar. Si no, revisa que no estés accediendo por `http://` forzado.

### `better-sqlite3` falla al construir
- Muy raro en Railway (usa Nixpacks con Node 20). Si pasa, añade a `package.json`:
  ```json
  "engines": { "node": "20.x" }
  ```
  (Ya está incluido en el package.json del proyecto.)

### El WebSocket no conecta
- Railway soporta WebSockets nativamente, no hace falta hacer nada especial.
- Si ves en consola del navegador error `wss://...`, verifica que la URL del proyecto usa HTTPS.

---

## Costes

Railway tiene un plan gratuito con **$5 de crédito mensual** (~500 horas de ejecución). Para una app como esta con poco tráfico, sobra. Si lo dejas corriendo 24/7 probablemente pases al plan Hobby ($5/mes fijos).
