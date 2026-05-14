const supabase = require('../config/supabase');

// ══════════════════════════════════════════════════════
//  ACTIVAR desde consola:
//  node -e "require('./services/promociones').activarPromo(500000, 1500000, '2026-05-13T22:00:00-05:00')"
//
//  DESACTIVAR desde consola:
//  node -e "require('./services/promociones').desactivarPromo()"
// ══════════════════════════════════════════════════════

async function activarPromo(precioDorado, precioNormal, expiraEn) {
  // Desactivar cualquier promo anterior
  await supabase.from('promociones').update({ activa: false }).eq('activa', true);

  const { data, error } = await supabase
    .from('promociones')
    .insert({ activa: true, precio_dorado: precioDorado, precio_normal: precioNormal, expira_en: expiraEn })
    .select()
    .single();

  if (error) {
    console.error('❌ Error activando promo:', error);
    return null;
  }

  console.log(`✅ Promo activa hasta ${expiraEn}`);
  console.log(`   Precio normal:  $${precioNormal.toLocaleString()}`);
  console.log(`   Precio dorado:  $${precioDorado.toLocaleString()}`);
  return data;
}

async function desactivarPromo() {
  await supabase.from('promociones').update({ activa: false }).eq('activa', true);
  console.log('🔴 Promo desactivada');
}

async function getPromoActiva() {
  const { data, error } = await supabase
    .from('promociones')
    .select('*')
    .eq('activa', true)
    .maybeSingle();

  if (error || !data) return null;

  // Auto-expirar si ya pasó la hora
  if (data.expira_en && new Date(data.expira_en) < new Date()) {
    await desactivarPromo();
    return null;
  }

  return data;
}

module.exports = { activarPromo, desactivarPromo, getPromoActiva };