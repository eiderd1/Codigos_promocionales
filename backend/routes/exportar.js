const express = require('express');
const ExcelJS = require('exceljs');
const supabase = require('../config/supabase');

const router = express.Router();

router.get('/admin/exportar', async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Ganadores');

    sheet.columns = [
      { header: 'Código', key: 'codigo' },
      { header: 'Dorado', key: 'dorado' }
    ];

    // 🔎 Obtener dorados
    const { data, error } = await supabase
      .from('codigos')
      .select('codigo, dorado')
      .eq('dorado', true);

    if (error) {
      console.error(error);
      return res.status(500).json({ ok: false });
    }

    data.forEach(row => sheet.addRow(row));

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader(
      'Content-Disposition',
      'attachment; filename=ganadores.xlsx'
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error("💥 Error exportar:", error);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;