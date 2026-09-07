// =========================================================
// api/[func].js — Satu endpoint dinamis untuk semua resource
// /api/produk | /api/bahan | /api/supplier | /api/tenagakerja
// /api/overhead | /api/penjualan | /api/bom | /api/po
// /api/po-material | /api/po-labor | /api/hpp-detail
// /api/hpp-latest | /api/dashboard
// =========================================================
const { createClient } = require('@supabase/supabase-js');

let _sb = null;
const sb = () => (_sb ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY));

const TABLE = {
  produk: 'produk', bahan: 'bahan', supplier: 'supplier',
  tenagakerja: 'tenaga_kerja', overhead: 'overhead', penjualan: 'penjualan',
};

const ok  = (res, data) => res.status(200).json(data);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return bad(res, 'Env SUPABASE_URL / SUPABASE_SERVICE_KEY belum diatur di Vercel', 500);

  const func = String(req.query.func || '').toLowerCase();
  const id   = req.query.id ? Number(req.query.id) : null;
  let body   = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  try {
    switch (func) {

      /* ================= GENERIC CRUD MASTER ================= */
      case 'produk': case 'bahan': case 'supplier':
      case 'tenagakerja': case 'overhead': case 'penjualan': {
        const t = TABLE[func];

        if (req.method === 'GET') {
          if (func === 'penjualan') {
            const { data, error } = await sb().from('v_penjualan')
              .select('*').order('tanggal', { ascending: false }).order('id', { ascending: false });
            if (error) throw error;
            return ok(res, data);
          }
          const q = (req.query.q || '').trim();
          let query = sb().from(t).select('*');
          if (q) query = query.or(`kode.ilike.%${q}%,nama.ilike.%${q}%`);
          query = func === 'overhead'
            ? query.order('periode', { ascending: false }).order('id', { ascending: false })
            : query.order('kode');
          const { data, error } = await query;
          if (error) throw error;
          return ok(res, data);
        }

        if (req.method === 'POST') {
          const { data, error } = await sb().from(t).insert(body).select().single();
          if (error) throw error;
          // Penjualan: auto-isi HPP dari PO "Selesai" terakhir produk tsb
          if (func === 'penjualan' && !Number(data.hpp_satuan)) {
            const hpp = await latestHpp(data.produk_id);
            if (hpp > 0) {
              await sb().from('penjualan').update({ hpp_satuan: hpp }).eq('id', data.id);
              data.hpp_satuan = hpp;
            }
          }
          return ok(res, data);
        }

        if (req.method === 'PUT') {
          if (!id) return bad(res, 'Parameter ?id= wajib');
          const { data, error } = await sb().from(t).update(body).eq('id', id).select().single();
          if (error) throw error;
          return ok(res, data);
        }

        if (req.method === 'DELETE') {
          if (!id) return bad(res, 'Parameter ?id= wajib');
          const { error } = await sb().from(t).delete().eq('id', id);
          if (error) throw error;
          return ok(res, { success: true });
        }
        return bad(res, 'Method tidak didukung', 405);
      }

      /* ================= BOM ================= */
      case 'bom': {
        if (req.method === 'GET') {
          const pid = Number(req.query.produk_id);
          if (!pid) return bad(res, '?produk_id= wajib');
          const { data, error } = await sb().from('bom')
            .select('*, bom_detail(*, bahan(kode, nama, satuan, harga, kelompok))')
            .eq('produk_id', pid).eq('aktif', true).maybeSingle();
          if (error) throw error;
          return ok(res, data);
        }
        if (req.method === 'POST') {
          const pid = Number(body.produk_id);
          const items = Array.isArray(body.items) ? body.items : [];
          if (!pid) return bad(res, 'produk_id wajib');
          const rows = items
            .filter(i => Number(i.bahan_id) > 0 && Number(i.qty_standar) > 0)
            .map(i => ({ bahan_id: Number(i.bahan_id), qty_standar: Number(i.qty_standar), waste_pct: Number(i.waste_pct) || 0 }));

          await sb().from('bom').delete().eq('produk_id', pid); // replace BOM lama
          const { data: bom, error: e1 } = await sb().from('bom')
            .insert({ produk_id: pid, nama: body.nama || 'BOM Standar', aktif: true }).select().single();
          if (e1) throw e1;
          if (rows.length) {
            const { error: e2 } = await sb().from('bom_detail').insert(rows.map(r => ({ ...r, bom_id: bom.id })));
            if (e2) throw e2;
          }
          return ok(res, { success: true, bom_id: bom.id, items: rows.length });
        }
        if (req.method === 'DELETE') {
          if (!id) return bad(res, '?id= wajib');
          const { error } = await sb().from('bom').delete().eq('id', id);
          if (error) throw error;
          return ok(res, { success: true });
        }
        return bad(res, 'Method tidak didukung', 405);
      }

      /* ================= PRODUCTION ORDER ================= */
      case 'po': {
        if (req.method === 'GET') {
          if (id) {
            const { data, error } = await sb().from('v_hpp_po').select('*').eq('id', id).maybeSingle();
            if (error) throw error;
            if (!data) return bad(res, 'PO tidak ditemukan', 404);
            return ok(res, data);
          }
          const { data, error } = await sb().from('v_hpp_po').select('*')
            .order('tanggal', { ascending: false }).order('id', { ascending: false });
          if (error) throw error;
          return ok(res, data);
        }
        if (req.method === 'POST') {
          const payload = {
            kode_po: (body.kode_po || '').trim() || 'PO-' + Date.now().toString().slice(-8),
            produk_id: Number(body.produk_id),
            qty: parseInt(body.qty, 10),
            tanggal: body.tanggal || new Date().toISOString().slice(0, 10),
            status: ['Draft', 'Produksi', 'Selesai'].includes(body.status) ? body.status : 'Draft',
          };
          if (!payload.produk_id || !payload.qty) return bad(res, 'produk_id & qty wajib');
          const { data, error } = await sb().from('production_order').insert(payload).select().single();
          if (error) throw error;
          return ok(res, data);
        }
        if (req.method === 'PUT') {
          if (!id) return bad(res, '?id= wajib');
          const patch = {};
          if (body.qty !== undefined) patch.qty = parseInt(body.qty, 10);
          if (body.tanggal) patch.tanggal = body.tanggal;
          if (body.status) {
            if (!['Draft', 'Produksi', 'Selesai'].includes(body.status)) return bad(res, 'Status tidak valid');
            patch.status = body.status;
            if (body.status === 'Selesai') patch.tanggal_selesai = new Date().toISOString().slice(0, 10);
          }
          const { data, error } = await sb().from('production_order').update(patch).eq('id', id).select().single();
          if (error) throw error;
          return ok(res, data);
        }
        if (req.method === 'DELETE') {
          if (!id) return bad(res, '?id= wajib');
          const { error } = await sb().from('production_order').delete().eq('id', id);
          if (error) throw error;
          return ok(res, { success: true });
        }
        return bad(res, 'Method tidak didukung', 405);
      }

      /* ================= MATERIAL AKTUAL ================= */
      case 'po-material': {
        const poId = Number(req.query.po_id);
        if (req.method === 'GET') {
          let q = sb().from('po_material').select('*, bahan(kode, nama, satuan, harga)').order('id');
          if (poId) q = q.eq('po_id', poId);
          const { data, error } = await q;
          if (error) throw error;
          return ok(res, data);
        }
        if (req.method === 'POST') {
          if (!poId) return bad(res, '?po_id= wajib');
          const items = (body.items || []).filter(i => Number(i.bahan_id) > 0)
            .map(i => ({ po_id: poId, bahan_id: Number(i.bahan_id), qty_aktual: Number(i.qty_aktual) || 0 }));
          await sb().from('po_material').delete().eq('po_id', poId); // replace
          if (items.length) {
            const { error } = await sb().from('po_material').insert(items);
            if (error) throw error;
          }
          return ok(res, { success: true, saved: items.length });
        }
        return bad(res, 'Method tidak didukung', 405);
      }

      /* ================= LABOR AKTUAL ================= */
      case 'po-labor': {
        const poId = Number(req.query.po_id);
        if (req.method === 'GET') {
          let q = sb().from('po_labor').select('*, tenaga_kerja(kode, proses, sistem, tarif, kategori)').order('id');
          if (poId) q = q.eq('po_id', poId);
          const { data, error } = await q;
          if (error) throw error;
          return ok(res, data);
        }
        if (req.method === 'POST') {
          if (!poId) return bad(res, '?po_id= wajib');
          const items = (body.items || []).filter(i => Number(i.tenaga_kerja_id) > 0)
            .map(i => ({
              po_id: poId,
              tenaga_kerja_id: Number(i.tenaga_kerja_id),
              qty_output: parseInt(i.qty_output, 10) || 0,
              jumlah_hari: Number(i.jumlah_hari) || 0,
            }));
          await sb().from('po_labor').delete().eq('po_id', poId); // replace
          if (items.length) {
            const { error } = await sb().from('po_labor').insert(items);
            if (error) throw error;
          }
          return ok(res, { success: true, saved: items.length });
        }
        return bad(res, 'Method tidak didukung', 405);
      }

      /* ================= RINCIAN HPP PER PO ================= */
      case 'hpp-detail': {
        const poId = Number(req.query.po_id);
        if (!poId) return bad(res, '?po_id= wajib');

        const { data: po, error: e0 } = await sb().from('production_order')
          .select('*, produk(kode, nama, harga_jual)').eq('id', poId).maybeSingle();
        if (e0) throw e0;
        if (!po) return bad(res, 'PO tidak ditemukan', 404);
        const qty = Number(po.qty) || 0;

        const { data: bahanAll } = await sb().from('bahan').select('id, kode, nama, satuan, harga');
        const bMap = Object.fromEntries((bahanAll || []).map(b => [b.id, b]));

        // BOM standar
        const { data: bom } = await sb().from('bom')
          .select('*, bom_detail(*, bahan(kode, nama, satuan, harga))')
          .eq('produk_id', po.produk_id).eq('aktif', true).maybeSingle();

        const material = (bom?.bom_detail || []).map(d => {
          const harga = Number(d.bahan?.harga || 0);
          const perPcs = Number(d.qty_efektif || 0);
          return {
            bahan_id: d.bahan_id, kode: d.bahan?.kode, nama: d.bahan?.nama, satuan: d.bahan?.satuan,
            harga, qty_std_pcs: perPcs, qty_std_total: perPcs * qty,
            biaya_std: perPcs * harga, qty_aktual: null, biaya_aktual: null,
          };
        });

        // Realisasi aktual
        const { data: act } = await sb().from('po_material').select('bahan_id, qty_aktual').eq('po_id', poId);
        (act || []).forEach(a => {
          const m = material.find(x => x.bahan_id === a.bahan_id);
          if (m) {
            m.qty_aktual = Number(a.qty_aktual);
            m.biaya_aktual = m.qty_aktual * m.harga;
          } else {
            const bb = bMap[a.bahan_id] || {};
            material.push({
              bahan_id: a.bahan_id, kode: bb.kode || '—',
              nama: (bb.nama || 'Bahan #' + a.bahan_id) + ' (di luar BOM)',
              satuan: bb.satuan || '-', harga: Number(bb.harga || 0),
              qty_std_pcs: 0, qty_std_total: 0, biaya_std: 0,
              qty_aktual: Number(a.qty_aktual),
              biaya_aktual: Number(a.qty_aktual) * Number(bb.harga || 0),
            });
          }
        });
        const dm = material.reduce((s, m) => s + (m.biaya_aktual ?? m.biaya_std * qty), 0);

        // Tenaga kerja
        const { data: labRows } = await sb().from('po_labor')
          .select('*, tenaga_kerja(proses, sistem, tarif, kategori)').eq('po_id', poId);
        const labor = (labRows || []).map(l => {
          const tk = l.tenaga_kerja || {};
          const tarif = Number(tk.tarif || 0);
          return {
            tk_id: l.tenaga_kerja_id, proses: tk.proses, sistem: tk.sistem, tarif,
            qty_output: Number(l.qty_output || 0), jumlah_hari: Number(l.jumlah_hari || 0),
            biaya: tk.sistem === 'Harian' ? Number(l.jumlah_hari || 0) * tarif : Number(l.qty_output || 0) * tarif,
          };
        });
        const dl = labor.reduce((s, l) => s + l.biaya, 0);

        // Overhead periode PO
        const periode = String(po.tanggal).slice(0, 7);
        const { data: oh } = await sb().from('v_overhead_periode').select('*').eq('periode', periode).maybeSingle();
        const ohPerPcs = Number(oh?.overhead_per_pcs || 0);
        const foh = ohPerPcs * qty;

        const total = dm + dl + foh;
        const perPcs = qty > 0 ? total / qty : 0;
        const hargaJual = Number(po.produk?.harga_jual || 0);

        return ok(res, {
          po: { id: po.id, kode_po: po.kode_po, tanggal: po.tanggal, qty, status: po.status,
                periode, produk: po.produk, harga_jual: hargaJual },
          material, labor,
          overhead: {
            periode,
            total_overhead_bulan: Number(oh?.total_overhead || 0),
            basis_qty_bulan: Number(oh?.total_qty_produksi || 0),
            per_pcs: ohPerPcs, dialokasikan: foh,
            note: !oh ? 'Belum ada data overhead untuk periode ' + periode : null,
          },
          ringkasan: {
            dm, dl, foh, total_hpp: total, hpp_per_pcs: perPcs,
            dm_per_pcs: qty ? dm / qty : 0, dl_per_pcs: qty ? dl / qty : 0, foh_per_pcs: ohPerPcs,
            margin_rp: hargaJual - perPcs,
            margin_pct: hargaJual ? ((hargaJual - perPcs) / hargaJual) * 100 : 0,
          },
        });
      }

      /* ================= HPP TERAKHIR PER PRODUK ================= */
      case 'hpp-latest': {
        const pid = Number(req.query.produk_id);
        if (!pid) return bad(res, '?produk_id= wajib');
        const hpp = await latestHpp(pid);
        return ok(res, { hpp });
      }

      /* ================= DASHBOARD ================= */
      case 'dashboard': {
        const today = new Date().toISOString().slice(0, 10);
        const bulan = today.slice(0, 7);
        const awalBulan = bulan + '-01';
        const awalChart = new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10);

        const [rProduk, rBahan, rPO] = await Promise.all([
          sb().from('produk').select('id', { count: 'exact', head: true }),
          sb().from('bahan').select('id', { count: 'exact', head: true }),
          sb().from('production_order').select('id', { count: 'exact', head: true }).neq('status', 'Selesai'),
        ]);

        const { data: salesBulan } = await sb().from('v_penjualan')
          .select('net_sales, laba_bersih, total_hpp').gte('tanggal', awalBulan);
        const net  = (salesBulan || []).reduce((s, r) => s + Number(r.net_sales || 0), 0);
        const laba = (salesBulan || []).reduce((s, r) => s + Number(r.laba_bersih || 0), 0);
        const hpp  = (salesBulan || []).reduce((s, r) => s + Number(r.total_hpp || 0), 0);

        const { data: chartRows } = await sb().from('v_penjualan')
          .select('tanggal, net_sales').gte('tanggal', awalChart);
        const byDay = {};
        (chartRows || []).forEach(r => { byDay[r.tanggal] = (byDay[r.tanggal] || 0) + Number(r.net_sales || 0); });
        const chart = [];
        for (let i = 13; i >= 0; i--) {
          const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
          chart.push({ tanggal: d, nilai: byDay[d] || 0 });
        }

        const [rHpp, rSales] = await Promise.all([
          sb().from('v_hpp_po').select('id, kode_po, tanggal, qty, status, nama_produk, hpp_per_pcs')
            .order('id', { ascending: false }).limit(5),
          sb().from('v_penjualan').select('id, tanggal, qty, channel, nama_produk, net_sales, laba_bersih')
            .order('id', { ascending: false }).limit(5),
        ]);

        return ok(res, {
          periode: bulan,
          counts: { produk: rProduk.count || 0, bahan: rBahan.count || 0, po_aktif: rPO.count || 0 },
          bulan_ini: { net_sales: net, laba, hpp, margin_pct: net > 0 ? (laba / net) * 100 : 0 },
          chart,
          hpp_terbaru: rHpp.data || [],
          penjualan_terbaru: rSales.data || [],
        });
      }

      default:
        return bad(res, `Endpoint "/api/${func}" tidak ditemukan`, 404);
    }
  } catch (err) {
    return bad(res, err.message || 'Kesalahan server', 500);
  }
};

async function latestHpp(produkId) {
  const { data } = await sb().from('v_hpp_po').select('hpp_per_pcs')
    .eq('produk_id', produkId).eq('status', 'Selesai')
    .order('tanggal', { ascending: false }).order('id', { ascending: false })
    .limit(1).maybeSingle();
  return data ? Number(data.hpp_per_pcs) : 0;
}
