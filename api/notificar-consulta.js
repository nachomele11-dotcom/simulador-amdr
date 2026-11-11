// Función serverless de Vercel: avisa por mail que una concesionaria cargó una consulta nueva.
//
// La llama el simulador apenas se guarda la consulta:
//   POST /api/notificar-consulta   { consultaId }   con header  Authorization: Bearer <token de Firebase del usuario>
//
// Seguridad: la consulta se lee de Firestore CON EL TOKEN DE QUIEN LLAMA, así que las reglas de
// seguridad deciden: si esa persona no puede leer esa consulta (no es suya ni es admin), no se manda
// nada. Los datos del mail salen de Firestore, nunca de lo que mande el navegador, y el destinatario
// es fijo (variable de entorno), así que no sirve para mandar mails a cualquiera.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY            clave de la cuenta de Resend (obligatoria)
//   AVISO_CONSULTAS_EMAIL     a quién le llega el aviso (obligatoria)
//   AVISO_CONSULTAS_FROM      remitente (opcional; por defecto el remitente de prueba de Resend,
//                             que solo puede mandarle al mail con el que se creó la cuenta de Resend)
//   APP_URL                   link al simulador que va en el mail (opcional)

const PROJECT_ID = 'simulados-amdr';
const FIRESTORE_BASE = process.env.FIRESTORE_BASE_URL || 'https://firestore.googleapis.com/v1';
const RESEND_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const MINUTOS_MAXIMOS = 15; // solo se avisa de consultas recién cargadas (evita reenvíos repetidos)

// Convierte el formato de la API REST de Firestore ({ stringValue: 'x' }, { mapValue: {...} }, ...) a JS común
const decodificar = (v) => {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodificar);
  if ('mapValue' in v) return decodificarCampos(v.mapValue.fields || {});
  return null;
};
const decodificarCampos = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, decodificar(v)]));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pesos = (n) => '$ ' + new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
const NOMBRE_CONDICION = { dependencia: 'Relación de dependencia', monotributo: 'Monotributista', ri: 'Responsable inscripto' };

export const armarMail = (c, appUrl) => {
  const cl = c.cliente || {};
  const v = c.vehiculo || {};
  const f = c.financiacion || {};
  const b = c.bcra || {};
  const tipo = cl.tipoPersona === 'juridica'
    ? 'Persona jurídica'
    : 'Persona física · ' + (cl.condiciones || []).map(x => NOMBRE_CONDICION[x] || x).join(' + ');
  const auto = [v.marca, v.modelo, v.version].filter(Boolean).join(' ') + (v.condicion === 'usado' ? ` · ${v.anio} · usado` : ' · 0 km');
  const bcraTxt = b.sinDatos
    ? 'Sin registros en BCRA'
    : `Situación ${b.situacionActual} · ${b.tieneChequesRechazados ? `${b.cantidadChequesRechazados} cheque(s) rechazado(s)` : 'sin cheques rechazados'}${b.historicoConAlerta ? ' · ⚠ tuvo situación 2+ en los últimos 24 meses' : ''}`;
  const cuit = String(cl.cuit || '');
  const cuitFmt = cuit.length === 11 ? `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}` : cuit;

  const filas = [
    ['Concesionaria', c.concesionariaNombre],
    ['Cliente', `${cl.nombre} (${cuitFmt})`],
    ['Tipo', tipo],
    ['BCRA', bcraTxt],
    ['Vehículo', auto],
    ['Precio', pesos(v.precio)],
    ['Pide', `${pesos(f.monto)} en ${f.plazo} cuotas de ${pesos(f.cuota)}`],
  ];
  if (c.comentarioConcesionaria) filas.push(['Comentario', c.comentarioConcesionaria]);

  const subject = `Nueva consulta · ${c.concesionariaNombre} · ${cl.nombre}`;
  const html = `
    <div style="font-family:Arial,sans-serif; color:#221D28; max-width:560px;">
      <h2 style="color:#55306A; margin:0 0 12px;">Nueva consulta de concesionaria</h2>
      <table style="border-collapse:collapse; font-size:14px;">
        ${filas.map(([k, val]) => `<tr><td style="padding:5px 12px 5px 0; color:#948C9C; vertical-align:top; white-space:nowrap;">${esc(k)}</td><td style="padding:5px 0;">${esc(val)}</td></tr>`).join('')}
      </table>
      <p style="margin-top:18px;"><a href="${esc(appUrl)}" style="background:#55306A; color:#fff; padding:10px 16px; border-radius:8px; text-decoration:none; display:inline-block;">Abrir el simulador</a></p>
      <p style="font-size:12px; color:#948C9C;">La ves en el módulo Concesionarias.</p>
    </div>`;
  const text = filas.map(([k, val]) => `${k}: ${val}`).join('\n') + `\n\nAbrir el simulador: ${appUrl}`;
  return { subject, html, text };
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });

  const apiKey = process.env.RESEND_API_KEY;
  const destinatario = process.env.AVISO_CONSULTAS_EMAIL;
  if (!apiKey || !destinatario) {
    // Sin configurar todavía: no es un error para quien cargó la consulta.
    return res.status(200).json({ ok: false, error: 'El aviso por mail no está configurado.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const consultaId = String((body && body.consultaId) || '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(consultaId)) return res.status(400).json({ ok: false, error: 'Consulta inválida' });

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Falta autenticación' });

  try {
    const docUrl = `${FIRESTORE_BASE}/projects/${PROJECT_ID}/databases/(default)/documents/consultas/${consultaId}`;
    const r = await fetch(docUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status !== 200) return res.status(403).json({ ok: false, error: 'No se pudo leer la consulta' });
    const consulta = decodificarCampos((await r.json()).fields);

    const antiguedadMs = Date.now() - new Date(consulta.fecha).getTime();
    if (!(antiguedadMs >= -60000 && antiguedadMs <= MINUTOS_MAXIMOS * 60000)) {
      return res.status(409).json({ ok: false, error: 'La consulta no es nueva' });
    }

    const { subject, html, text } = armarMail(consulta, process.env.APP_URL || 'https://simulador-amdr.vercel.app');
    const envio = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.AVISO_CONSULTAS_FROM || 'Simulador AMDR <onboarding@resend.dev>',
        to: [destinatario],
        subject, html, text
      })
    });
    if (!envio.ok) {
      const detalle = await envio.text();
      console.error('Resend respondió', envio.status, detalle);
      return res.status(502).json({ ok: false, error: 'El servicio de mails no aceptó el envío' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'No se pudo mandar el aviso' });
  }
}
