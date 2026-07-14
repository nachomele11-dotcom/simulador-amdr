// Función serverless de Vercel: consulta la API pública del BCRA (Central de Deudores)
// para un CUIT/CUIL/CDI y devuelve un semáforo simple de riesgo.
//
// Reglas del semáforo (definidas por la Mutual):
//  - VERDE:  situación actual = 1 Y sin cheques rechazados Y sin situación 2+ en los últimos 24 meses
//  - ALERTA: situación actual >= 2, O tiene cheques rechazados, O tuvo situación 2+ en los últimos 24 meses

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const cuit = (req.query.cuit || '').toString().replace(/\D/g, '');
  if (cuit.length !== 11) {
    return res.status(400).json({ ok: false, error: 'El CUIT debe tener 11 dígitos.' });
  }

  const base = 'https://api.bcra.gob.ar/CentralDeDeudores/v1.0/Deudas';

  try {
    const [deudasRes, historicasRes, chequesRes] = await Promise.all([
      fetch(`${base}/${cuit}`),
      fetch(`${base}/Historicas/${cuit}`),
      fetch(`${base}/ChequesRechazados/${cuit}`)
    ]);

    // El BCRA devuelve 404 cuando no hay registros para ese CUIT en ese endpoint puntual (no es un error nuestro)
    const deudas = deudasRes.status === 200 ? await deudasRes.json() : null;
    const historicas = historicasRes.status === 200 ? await historicasRes.json() : null;
    const cheques = chequesRes.status === 200 ? await chequesRes.json() : null;

    if (deudasRes.status >= 500 || historicasRes.status >= 500 || chequesRes.status >= 500) {
      return res.status(502).json({ ok: false, error: 'El servicio del BCRA no respondió correctamente. Probá de nuevo en un momento.' });
    }

    if (!deudas && !historicas && !cheques) {
      // Sin ningún registro en ninguno de los 3 servicios: no tiene deudas ni cheques rechazados informados
      return res.status(200).json({ ok: true, sinDatos: true, alerta: false, motivos: [] });
    }

    let denominacion = null;
    let situacionActual = null;
    if (deudas && deudas.results) {
      denominacion = deudas.results.denominacion || null;
      (deudas.results.periodos || []).forEach(p => (p.entidades || []).forEach(e => {
        if (situacionActual === null || e.situacion > situacionActual) situacionActual = e.situacion;
      }));
    }

    let historicoConAlerta = false;
    if (historicas && historicas.results) {
      if (!denominacion) denominacion = historicas.results.denominacion || null;
      (historicas.results.periodos || []).forEach(p => (p.entidades || []).forEach(e => {
        if (e.situacion >= 2) historicoConAlerta = true;
      }));
    }

    let cantidadChequesRechazados = 0;
    if (cheques && cheques.results) {
      if (!denominacion) denominacion = cheques.results.denominacion || null;
      (cheques.results.causales || []).forEach(c => (c.entidades || []).forEach(e => {
        cantidadChequesRechazados += (e.detalle || []).length;
      }));
    }
    const tieneChequesRechazados = cantidadChequesRechazados > 0;

    const motivos = [];
    if (situacionActual !== null && situacionActual >= 2) motivos.push(`Situación crediticia actual: ${situacionActual}`);
    if (tieneChequesRechazados) motivos.push(`${cantidadChequesRechazados} cheque(s) rechazado(s)`);
    if (historicoConAlerta && !(situacionActual !== null && situacionActual >= 2)) motivos.push('Tuvo situación 2 o superior en los últimos 24 meses');

    return res.status(200).json({
      ok: true,
      sinDatos: false,
      cuit,
      denominacion,
      situacionActual: situacionActual === null ? 1 : situacionActual,
      tieneChequesRechazados,
      cantidadChequesRechazados,
      historicoConAlerta,
      alerta: motivos.length > 0,
      motivos
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'No se pudo consultar el BCRA. Intentá de nuevo.' });
  }
}
