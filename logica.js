/* ══════════════════════════════════════════
   Inversiones GSG — lógica pura (sin DOM ni Supabase)
   Se carga en el navegador como window.GSG y en Node con require().
══════════════════════════════════════════ */
(function (raiz) {
  'use strict';

  function centavos(n) { return Math.round((Number(n) || 0) * 100); }

  /* Fecha local YYYY-MM-DD (toISOString usa UTC y adelanta el día de noche) */
  function hoyLocal(d) {
    d = d || new Date();
    var m = d.getMonth() + 1, dia = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dia < 10 ? '0' : '') + dia;
  }

  /* "90.000" → 90000 · "90.000,50" → 90000.5 · "$ 1.240.000" → 1240000 */
  function parseMonto(texto) {
    var s = String(texto == null ? '' : texto).replace(/[^\d.,]/g, '');
    if (!s) return NaN;
    s = s.replace(/\./g, '').replace(',', '.');
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  function saldoCentavos(c) {
    if (c.estado === 'pagado') return 0;
    return Math.max(0, centavos(c.valor) - centavos(c.pagado));
  }

  /* Reparte un pago: primero la cuota elegida y el excedente a las demás
     cuotas pendientes del préstamo, de la más antigua a la más nueva. */
  function distribuirPago(cuotas, cuotaId, monto, fecha, obs) {
    var pendientes = cuotas.filter(function (c) { return saldoCentavos(c) > 0; });
    var saldoTotal = pendientes.reduce(function (s, c) { return s + saldoCentavos(c); }, 0);
    var restante = centavos(monto);
    if (!(restante > 0) || restante > saldoTotal) return { ok: false, maximo: saldoTotal / 100 };

    var elegida = pendientes.filter(function (c) { return c.id === cuotaId; });
    var resto = pendientes
      .filter(function (c) { return c.id !== cuotaId; })
      .sort(function (a, b) { return String(a.fechaVence).localeCompare(String(b.fechaVence)); });

    var cambios = [];
    elegida.concat(resto).forEach(function (c) {
      if (restante <= 0) return;
      var abono = Math.min(restante, saldoCentavos(c));
      restante -= abono;
      var pagado = centavos(c.pagado) + abono;
      cambios.push({
        id: c.id,
        abono: abono / 100,
        patch: {
          pagado: pagado / 100,
          estado: pagado >= centavos(c.valor) ? 'pagado' : 'pendiente',
          fechaPago: fecha,
          obs: obs
        }
      });
    });
    return { ok: true, cambios: cambios, total: centavos(monto) / 100 };
  }

  /* Aplica los cambios en orden; se detiene en el primer error. */
  async function aplicarCambios(cambios, actualizar) {
    var aplicados = [];
    for (var i = 0; i < cambios.length; i++) {
      try {
        await actualizar(cambios[i].id, cambios[i].patch);
        aplicados.push(cambios[i]);
      } catch (e) {
        return { aplicados: aplicados, error: e };
      }
    }
    return { aplicados: aplicados, error: null };
  }

  /* ── Capital de la tía ── */
  function fraccionTia(p) {
    var imp = Number(p.importe) || 0;
    if (imp <= 0) return 0;
    return Math.min(1, Math.max(0, (Number(p.capitalTia) || 0) / imp));
  }

  function origenPrestamo(p) {
    var f = fraccionTia(p);
    return f <= 0 ? 'mio' : (f >= 1 ? 'tia' : 'mixto');
  }

  function r2(n) { return Math.round(n * 100) / 100; }

  /* Divide lo cobrado y lo pendiente en capital e interés (proporcional a
     1 + tasa) y reparte entre la tía (f · p del interés) y yo (el resto). */
  function repartoTia(p, cuotas, pctDefecto) {
    var f = fraccionTia(p);
    var pct = (p.pctTia === null || p.pctTia === undefined || p.pctTia === '') ? pctDefecto : Number(p.pctTia);
    pct = Math.min(1, Math.max(0, Number(pct) || 0));
    var factor = 1 + (Number(p.tasa) || 0);
    var cobrado = 0, pendiente = 0;
    cuotas.forEach(function (c) {
      cobrado += Number(c.pagado) || 0;
      pendiente += saldoCentavos(c) / 100;
    });
    var capCob = cobrado / factor, intCob = cobrado - capCob;
    var capPen = pendiente / factor, intPen = pendiente - capPen;
    function parte(fc, fi) {
      return { capitalCobrado: r2(capCob * fc), interesCobrado: r2(intCob * fi),
               capitalPendiente: r2(capPen * fc), interesPendiente: r2(intPen * fi) };
    }
    return { f: f, p: pct, tia: parte(f, f * pct), mio: parte(1 - f, 1 - f * pct) };
  }

  /* ── Seguridad y utilidades de interfaz ── */
  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Supabase devuelve las filas tocadas (Prefer: return=representation).
     Sin filas = no se guardó (sin conexión, RLS o id inexistente). */
  function filasActualizadas(respuesta) {
    if (!Array.isArray(respuesta) || respuesta.length < 1) throw new Error('El cambio no se guardó en la base de datos. Revisa la conexión.');
    return respuesta.length;
  }

  /* Días de calendario de "desde" a "hasta" (YYYY-MM-DD), sin depender de la hora */
  function diasEntre(desde, hasta) {
    var a = Date.UTC(+desde.slice(0, 4), +desde.slice(5, 7) - 1, +desde.slice(8, 10));
    var b = Date.UTC(+hasta.slice(0, 4), +hasta.slice(5, 7) - 1, +hasta.slice(8, 10));
    return Math.round((b - a) / 86400000);
  }

  /* Formatea mientras se escribe: 500000 → 500.000 · conserva hasta 2 decimales con coma */
  function formatearEntradaMonto(texto) {
    var limpio = String(texto == null ? '' : texto).replace(/[^\d,]/g, '');
    var partes = limpio.split(',');
    var ent = partes[0].replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return partes.length > 1 ? ent + ',' + partes.slice(1).join('').slice(0, 2) : ent;
  }
  function montoATexto(n) {
    var cent = Math.round((Number(n) || 0) * 100), ent = Math.floor(cent / 100), dec = cent % 100;
    return formatearEntradaMonto(String(ent)) + (dec ? ',' + (dec < 10 ? '0' : '') + dec : '');
  }

  /* capitalTia y pctTia desde el formulario. pctTia null = usar el % general */
  function valoresOrigen(origen, importe, capitalTexto, pctTexto, usarGeneral) {
    if (origen === 'mio') return { capitalTia: 0, pctTia: null };
    var cap = origen === 'tia' ? importe : Math.min(importe, Math.max(0, parseMonto(capitalTexto) || 0));
    var txt = String(pctTexto == null ? '' : pctTexto).trim();
    if (usarGeneral || txt === '' || !isFinite(Number(txt))) return { capitalTia: cap, pctTia: null };
    return { capitalTia: cap, pctTia: Math.min(100, Math.max(0, Number(txt))) / 100 };
  }

  /* ── Auditoría: columnas reales de ca_logs (id uuid y created_at los pone la base) ── */
  function filaDeLog(e) {
    return { accion: e.accion, detalles: String(e.detalles == null ? '' : e.detalles), tipo_evento: e.tipo, usuario_email: e.usuario };
  }
  function logDeFila(f) {
    var d = f.detalles;
    return {
      id: f.id,
      accion: f.accion,
      detalles: d == null ? '' : (typeof d === 'string' ? d : JSON.stringify(d)),
      tipo: f.tipo_evento || 'sistema',
      usuario: f.usuario_email,
      creado_en: f.created_at
    };
  }

  var GSG = {
    filaDeLog: filaDeLog,
    logDeFila: logDeFila,
    escHTML: escHTML,
    filasActualizadas: filasActualizadas,
    diasEntre: diasEntre,
    formatearEntradaMonto: formatearEntradaMonto,
    montoATexto: montoATexto,
    valoresOrigen: valoresOrigen,
    hoyLocal: hoyLocal,
    parseMonto: parseMonto,
    distribuirPago: distribuirPago,
    aplicarCambios: aplicarCambios,
    origenPrestamo: origenPrestamo,
    repartoTia: repartoTia
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = GSG;
  if (raiz) raiz.GSG = GSG;
})(typeof window !== 'undefined' ? window : null);
