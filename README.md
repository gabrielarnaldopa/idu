# MedAlert — Sistema de alertas médicas

Dashboard web con autenticación que recibe alertas desde un chatbot en **n8n** vía HTTP y las muestra en tiempo real por WebSocket.

## Características

- Login con usuarios, contraseñas hasheadas (bcrypt) y sesiones seguras.
- Dashboard con **5 tipos de alerta**: `emergencia`, `reanimacion`, `urgente`, `atencion_necesaria`, `consultas`.
- Cada alerta tiene panel de detalles (paciente, ubicación, síntomas, signos vitales, descripción, metadatos).
- Sistema de estados: `pendiente` → `en_atencion` → `resuelta`.
- Notificaciones en tiempo real (WebSocket) + toast + beep sonoro para alertas críticas.
- Endpoint webhook protegido por API key para que n8n envíe datos.
- Persistencia en SQLite (se crea automáticamente).

---

## Instalación

```bash
cd medical-alerts
npm install
npm start
```

Abre `http://localhost:3000`.

**Usuarios por defecto** (cámbialos en producción):

| Usuario      | Contraseña     | Rol        |
|--------------|----------------|------------|
| `admin`      | `admin123`     | admin      |
| `medico`     | `medico123`    | medico     |
| `enfermeria` | `enfermeria123`| enfermeria |

---

## Variables de entorno

| Variable          | Por defecto                       | Descripción                                |
|-------------------|-----------------------------------|--------------------------------------------|
| `PORT`            | `3000`                            | Puerto HTTP                                |
| `SESSION_SECRET`  | aleatoria cada arranque           | Secret de cookies de sesión                |
| `WEBHOOK_API_KEY` | `cambia-esta-clave-n8n-12345`     | API key que n8n debe enviar en el header   |

Ejemplo en Linux/Mac:
```bash
WEBHOOK_API_KEY="mi-clave-super-secreta" PORT=8080 npm start
```

---

## Endpoint para n8n

**URL:** `POST http://TU-SERVIDOR:3000/api/webhook/alert`

**Headers:**
```
Content-Type: application/json
X-API-Key: cambia-esta-clave-n8n-12345
```

**Body JSON:**
```json
{
  "type": "emergencia",
  "title": "Dolor torácico agudo",
  "patient_name": "Juan Pérez",
  "patient_age": "54 años",
  "location": "Sala 3 · Planta 2",
  "description": "Paciente refiere dolor opresivo en pecho desde hace 20 minutos, irradiado a brazo izquierdo.",
  "symptoms": "Dolor torácico, sudoración, náuseas",
  "vital_signs": "TA 160/95 · FC 110 · SatO2 93%",
  "source": "chatbot-triage",
  "metadata": {
    "conversation_id": "conv_abc123",
    "priority_score": 9.2
  }
}
```

### Tipos válidos (`type`)

| Valor                 | Color     | Sonido |
|-----------------------|-----------|--------|
| `emergencia`          | rojo      | sí     |
| `reanimacion`         | rosa      | sí     |
| `urgente`             | naranja   | sí     |
| `atencion_necesaria`  | amarillo  | no     |
| `consultas`           | verde     | no     |

El único campo **obligatorio** es `type`. Todos los demás son opcionales. Si no envías `title`, se genera uno por defecto según el tipo.

También acepta alias en español: `paciente`, `edad`, `ubicacion`, `descripcion`/`mensaje`, `sintomas`, `signos_vitales`.

---

## Cómo configurarlo en n8n

1. En tu flow de n8n, al final del procesamiento del chatbot, añade un nodo **HTTP Request**.
2. Configúralo así:
   - **Method:** `POST`
   - **URL:** `http://TU-SERVIDOR:3000/api/webhook/alert`
   - **Authentication:** None
   - **Send Headers:** `ON` → añade `X-API-Key` con tu clave.
   - **Send Body:** `ON` → `JSON` → pega tu plantilla con expresiones de n8n, por ejemplo:
   ```json
   {
     "type": "{{$json.clasificacion}}",
     "title": "{{$json.motivo}}",
     "patient_name": "{{$json.paciente}}",
     "description": "{{$json.mensaje_usuario}}"
   }
   ```

### Prompt sugerido para que el chatbot clasifique

Pide al LLM de n8n que devuelva JSON con uno de los 5 tipos exactos. Ejemplo:

```
Clasifica el siguiente mensaje del paciente en uno de estos niveles:
- "emergencia": riesgo vital inmediato (paro cardíaco, hemorragia masiva, inconsciencia)
- "reanimacion": requiere maniobras de RCP o vía aérea
- "urgente": necesita atención en minutos (dolor torácico, disnea severa, trauma importante)
- "atencion_necesaria": requiere valoración en la siguiente hora
- "consultas": consulta no urgente, dudas, información

Responde SOLO con JSON: {"type": "...", "title": "...", "description": "..."}
```

---

## Prueba rápida con cURL

```bash
curl -X POST http://localhost:3000/api/webhook/alert \
  -H "Content-Type: application/json" \
  -H "X-API-Key: cambia-esta-clave-n8n-12345" \
  -d '{
    "type": "emergencia",
    "title": "Paro cardiorrespiratorio",
    "patient_name": "María García",
    "patient_age": "72 años",
    "location": "Urgencias · Box 4",
    "description": "Paciente inconsciente, sin pulso palpable. Se inicia RCP.",
    "vital_signs": "Sin signos vitales"
  }'
```

Deberías ver la alerta aparecer instantáneamente en el dashboard con toast, sonido y flash visual.

---

## Producción

- Cambia `WEBHOOK_API_KEY` y `SESSION_SECRET` por valores largos y aleatorios.
- Sirve detrás de HTTPS (nginx/caddy) y pon `cookie.secure = true` en `server.js`.
- Crea usuarios reales desde la base de datos SQLite (`data.db`) o añade un endpoint de alta.
- Para backup: basta con copiar `data.db`.

---

## Estructura de archivos

```
medical-alerts/
├── package.json
├── server.js              ← backend Express + WS + SQLite
├── data.db                ← se crea al primer arranque
└── public/
    ├── index.html         ← login
    └── dashboard.html     ← dashboard en tiempo real
```
