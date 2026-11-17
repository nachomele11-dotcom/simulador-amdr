// Función serverless de Vercel: crea un usuario nuevo del simulador (cuenta + perfil) desde Configuración.
//
// La llama el simulador cuando un admin completa "Nuevo usuario":
//   POST /api/crear-usuario   { nombre, email, rol, password }
//   con header  Authorization: Bearer <token de Firebase del admin>
//
// Seguridad:
//  - Primero se comprueba con Firebase quién llama (su token) y que su perfil sea admin y esté activo.
//  - La cuenta se crea con la clave de servidor (cuenta de servicio), que nunca sale de Vercel.
//    Así el registro público puede quedar desactivado en Firebase.
//  - El perfil en "usuarios" se escribe CON EL TOKEN DEL ADMIN, así que las reglas de seguridad
//    también tienen que aprobarlo. Si eso falla, se borra la cuenta recién creada.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT   contenido completo del archivo JSON de la cuenta de servicio (obligatoria)
//   FIREBASE_WEB_API_KEY       opcional; por defecto la clave web pública del simulador

import crypto from 'node:crypto';

const PROJECT_ID = 'simulados-amdr';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyAyKLwoQf6W1sRz_rtDjBqX4WEhDiCJAXQ';
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const ROLES = ['vendedor', 'admin', 'concesionaria'];

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const leerCuentaServicio = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return sa;
  } catch {
    return null;
  }
};

// Token de acceso de Google para la cuenta de servicio (JWT firmado con su clave privada).
export const tokenDeServicio = async (sa) => {
  const ahora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: TOKEN_URL,
    iat: ahora,
    exp: ahora + 3600
  }));
  const firma = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  const jwt = `${header}.${claims}.${b64url(firma)}`;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString()
  });
  if (!r.ok) throw new Error('token de servicio: ' + r.status + ' ' + (await r.text()));
  return (await r.json()).access_token;
};

const valor = (v) => {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  return null;
};

const MENSAJES_ALTA = {
  EMAIL_EXISTS: [409, 'Ya existe una cuenta con ese mail.'],
  DUPLICATE_EMAIL: [409, 'Ya existe una cuenta con ese mail.'],
  INVALID_EMAIL: [400, 'El mail no es válido.'],
  WEAK_PASSWORD: [400, 'La contraseña tiene que tener al menos 6 caracteres.']
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });

  const sa = leerCuentaServicio();
  if (!sa) return res.status(500).json({ ok: false, error: 'Falta configurar la clave del servidor en Vercel (FIREBASE_SERVICE_ACCOUNT).' });

  const idToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!idToken) return res.status(401).json({ ok: false, error: 'Falta autenticación' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const nombre = String(body.nombre || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const rol = String(body.rol || '');
  const password = String(body.password || '');
  if (!nombre || nombre.length > 80) return res.status(400).json({ ok: false, error: 'Poné un nombre (hasta 80 caracteres).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return res.status(400).json({ ok: false, error: 'El mail no es válido.' });
  if (!ROLES.includes(rol)) return res.status(400).json({ ok: false, error: 'Rol inválido.' });
  if (password.length < 6 || password.length > 100) return res.status(400).json({ ok: false, error: 'La contraseña tiene que tener al menos 6 caracteres.' });

  try {
    // 1) ¿Quién llama? Firebase valida el token y devuelve su UID.
    const look = await fetch(`${IDT}/accounts:lookup?key=${WEB_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
    });
    if (!look.ok) return res.status(401).json({ ok: false, error: 'La sesión venció. Volvé a entrar al simulador.' });
    const quien = ((await look.json()).users || [])[0];
    if (!quien || !quien.localId) return res.status(401).json({ ok: false, error: 'La sesión venció. Volvé a entrar al simulador.' });

    // 2) ¿Es admin activo? Se lee su perfil con su propio token.
    const perfilRes = await fetch(`${FIRESTORE}/usuarios/${quien.localId}`, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!perfilRes.ok) return res.status(403).json({ ok: false, error: 'Solo un administrador puede crear usuarios.' });
    const pf = (await perfilRes.json()).fields || {};
    if (valor(pf.rol) !== 'admin' || valor(pf.activo) === false) {
      return res.status(403).json({ ok: false, error: 'Solo un administrador puede crear usuarios.' });
    }

    // 3) Crear la cuenta con la clave de servidor.
    const accessToken = await tokenDeServicio(sa);
    const alta = await fetch(`${IDT}/projects/${PROJECT_ID}/accounts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: nombre })
    });
    if (!alta.ok) {
      const det = await alta.json().catch(() => ({}));
      const codigo = String((det.error && det.error.message) || '').split(' ')[0].split(':')[0];
      const [st, msg] = MENSAJES_ALTA[codigo] || [502, 'Firebase no pudo crear la cuenta.'];
      if (st === 502) console.error('Alta de cuenta falló', alta.status, JSON.stringify(det));
      return res.status(st).json({ ok: false, error: msg });
    }
    const uid = (await alta.json()).localId;

    // 4) Crear el perfil con el token del admin (las reglas de seguridad también lo controlan).
    const perfil = await fetch(`${FIRESTORE}/usuarios?documentId=${encodeURIComponent(uid)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          nombre: { stringValue: nombre },
          email: { stringValue: email },
          rol: { stringValue: rol },
          activo: { booleanValue: true },
          creadoPor: { stringValue: valor(pf.email) || quien.email || quien.localId },
          creadoEn: { timestampValue: new Date().toISOString() }
        }
      })
    });
    if (!perfil.ok) {
      console.error('Perfil no creado', perfil.status, await perfil.text());
      // Deshacer: borrar la cuenta para no dejar una cuenta sin perfil.
      await fetch(`${IDT}/projects/${PROJECT_ID}/accounts:delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: uid })
      }).catch(() => {});
      return res.status(500).json({ ok: false, error: 'No se pudo crear el perfil. No se creó nada, probá de nuevo.' });
    }

    return res.status(200).json({ ok: true, uid });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'No se pudo crear el usuario.' });
  }
}
