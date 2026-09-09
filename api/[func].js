// =========================================================
// api/[func].js — v1.1
// Master CRUD: produk|bahan|supplier|tenagakerja|overhead|penjualan
// Modul: bom|po|po-material|po-labor|hpp-detail|hpp-latest|dashboard
// Baru : pembelian | invoice | pengaturan
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
const tgl = () => new Date().toISOString().slice(0, 10);

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

      /* ================= PENGATURAN USAHA ================= */
      case 'pengaturan': {
        if (req.method === 'GET') {
          const { data } = await sb().from('pengaturan').select('*').eq('id', 1).maybeSingle();
          return ok(res, data || { nama_usaha: 'Nama Usaha Anda' });
        }
        if (req.method === 'PUT') {
          const allow = ['nama_usaha','alamat','telepon','email','rekening','catatan_invoice','footer_invoice','logo_url','nama_aplikasi','inisial_aplikasi','tagline_aplikasi'];
          const patch = {};
          allow.forEach(k => { if (body[k] !== undefined) patch[k] = body[k] === '' ? null : body[k]; });
          if (patch.nama_usaha === null) patch.nama_usaha = 'Nama Usaha Anda';
          const { data, error } = await sb().from('pengaturan').upsert({ id: 1, ...patch }).select().single();
          if (error) throw error;
          return ok(res, data);
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
          await sb().from('bom').delete().eq('produk_id', pid);
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
            tanggal: body.tanggal || tgl(),
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
            if (body.status === 'Selesai') patch.tanggal_selesai = tgl();
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
          await sb().from('po_material').delete().eq('po_id', poId);
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
          await sb().from('po_labor').delete().eq('po_id', poId);
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
        const { data: act } = await sb().from('po_material').select('bahan_id, qty_aktual').eq('po_id', poId);
        (act || []).forEach(a => {
          const m = material.find(x => x.bahan_id === a.bahan_id);
          if (m) { m.qty_aktual = Number(a.qty_aktual); m.biaya_aktual = m.qty_aktual * m.harga; }
          else {
            const bb = bMap[a.bahan_id] || {};
            material.push({
              bahan_id: a.bahan_id, kode: bb.kode || '—',
              nama: (bb.nama || 'Bahan #' + a.bahan_id) + ' (di luar BOM)',
              satuan: bb.satuan || '-', harga: Number(bb.harga || 0),
              qty_std_pcs: 0, qty_std_total: 0, biaya_std: 0,
              qty_aktual: Number(a.qty_aktual), biaya_aktual: Number(a.qty_aktual) * Number(bb.harga || 0),
            });
          }
        });
        const dm = material.reduce((s, m) => s + (m.biaya_aktual ?? m.biaya_std * qty), 0);
        const { data: labRows } = await sb().from('po_labor')
          .select('*, tenaga_kerja(proses, sistem, tarif, kategori)').eq('po_id', poId);
        const labor = (labRows || []).map(l => {
          const tk = l.tenaga_kerja || {}; const tarif = Number(tk.tarif || 0);
          return { tk_id: l.tenaga_kerja_id, proses: tk.proses, sistem: tk.sistem, tarif,
            qty_output: Number(l.qty_output || 0), jumlah_hari: Number(l.jumlah_hari || 0),
            biaya: tk.sistem === 'Harian' ? Number(l.jumlah_hari || 0) * tarif : Number(l.qty_output || 0) * tarif };
        });
        const dl = labor.reduce((s, l) => s + l.biaya, 0);
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
          overhead: { periode, total_overhead_bulan: Number(oh?.total_overhead || 0),
            basis_qty_bulan: Number(oh?.total_qty_produksi || 0), per_pcs: ohPerPcs, dialokasikan: foh,
            note: !oh ? 'Belum ada data overhead untuk periode ' + periode : null },
          ringkasan: { dm, dl, foh, total_hpp: total, hpp_per_pcs: perPcs,
            dm_per_pcs: qty ? dm / qty : 0, dl_per_pcs: qty ? dl / qty : 0, foh_per_pcs: ohPerPcs,
            margin_rp: hargaJual - perPcs,
            margin_pct: hargaJual ? ((hargaJual - perPcs) / hargaJual) * 100 : 0 },
        });
      }

      /* ================= HPP TERAKHIR PER PRODUK ================= */
      case 'hpp-latest': {
        const pid = Number(req.query.produk_id);
        if (!pid) return bad(res, '?produk_id= wajib');
        return ok(res, { hpp: await latestHpp(pid) });
      }

      /* ================= PEMBELIAN BAHAN (v1.1) ================= */
      case 'pembelian': {
        if (req.method === 'GET') {
          if (id) {
            const { data: pb, error } = await sb().from('pembelian')
              .select('*, supplier(kode, nama)').eq('id', id).maybeSingle();
            if (error) throw error;
            if (!pb) return bad(res, 'Pembelian tidak ditemukan', 404);
            const { data: items, error: e2 } = await sb().from('pembelian_detail')
              .select('*, bahan(kode, nama, satuan, harga)').eq('pembelian_id', id).order('id');
            if (e2) throw e2;
            return ok(res, { ...pb, items: items || [] });
          }
          const { data, error } = await sb().from('v_pembelian').select('*')
            .order('tanggal', { ascending: false }).order('id', { ascending: false });
          if (error) throw error;
          return ok(res, data);
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const items = (body.items || []).filter(i => Number(i.bahan_id) > 0 && Number(i.qty) > 0)
            .map(i => ({ bahan_id: Number(i.bahan_id), qty: Number(i.qty), harga_beli: Number(i.harga_beli) || 0 }));
          if (!items.length) return bad(res, 'Minimal 1 item bahan valid');
          const header = {
            tanggal: body.tanggal || tgl(),
            supplier_id: Number(body.supplier_id) || null,
            nomor_nota: (body.nomor_nota || '').trim() || null,
            keterangan: (body.keterangan || '').trim() || null,
          };
          let pbId = id;
          if (req.method === 'POST') {
            const kode = await nextNum('pembelian', 'kode', 'PB');
            const { data, error } = await sb().from('pembelian').insert({ ...header, kode }).select().single();
            if (error) throw error;
            pbId = data.id;
          } else {
            if (!pbId) return bad(res, '?id= wajib');
            const { error } = await sb().from('pembelian').update(header).eq('id', pbId);
            if (error) throw error;
            await sb().from('pembelian_detail').delete().eq('pembelian_id', pbId);
          }
          const { error: e3 } = await sb().from('pembelian_detail')
            .insert(items.map(i => ({ ...i, pembelian_id: pbId })));
          if (e3) throw e3;
          if (body.update_master) {
            for (const it of items)
              await sb().from('bahan').update({ harga: it.harga_beli }).eq('id', it.bahan_id);
          }
          return ok(res, { success: true, id: pbId, items: items.length });
        }
        if (req.method === 'DELETE') {
          if (!id) return bad(res, '?id= wajib');
          const { error } = await sb().from('pembelian').delete().eq('id', id);
          if (error) throw error;
          return ok(res, { success: true });
        }
        return bad(res, 'Method tidak didukung', 405);
      }

      /* ================= INVOICE (v1.1) ================= */
      case 'invoice': {
        const calcInv = (items, pot, pjk, ong) => {
          const sub = items.reduce((s, i) => s + Number(i.qty) * Number(i.harga) * (1 - Number(i.diskon_pct || 0) / 100), 0);
          const dpp = Math.max(sub - Number(pot || 0), 0);
          return { subtotal: sub, total: dpp * (1 + Number(pjk || 0) / 100) + Number(ong || 0) };
        };
        const normItems = arr => (arr || []).filter(i => Number(i.produk_id) > 0 && Number(i.qty) > 0)
          .map(i => ({ produk_id: Number(i.produk_id), qty: parseInt(i.qty, 10),
            harga: Number(i.harga) || 0, diskon_pct: Number(i.diskon_pct) || 0,
            deskripsi: (i.deskripsi || '').trim() || null }));

        if (req.method === 'GET') {
          if (id) {
            const { data: inv, error } = await sb().from('invoice').select('*').eq('id', id).maybeSingle();
            if (error) throw error;
            if (!inv) return bad(res, 'Invoice tidak ditemukan', 404);
            const { data: items } = await sb().from('invoice_detail')
              .select('*, produk(kode, nama, satuan)').eq('invoice_id', id).order('id');
            const { data: set } = await sb().from('pengaturan').select('*').eq('id', 1).maybeSingle();
            return ok(res, { ...inv, items: items || [], set: set || {} });
          }
          const { data, error } = await sb().from('v_invoice').select('*')
            .order('tanggal', { ascending: false }).order('id', { ascending: false });
          if (error) throw error;
          return ok(res, data);
        }

        if (req.method === 'POST') {
          const items = normItems(body.items);
          const srcIds = (body.sumber_penjualan_ids || []).map(Number).filter(Boolean);
          if (!items.length && !srcIds.length) return bad(res, 'Minimal 1 item invoice');
          if (!(body.customer_nama || '').trim()) return bad(res, 'Nama pelanggan wajib diisi');

          let det = items;
          if (srcIds.length) {
            const { data: srcRows, error: eS } = await sb().from('penjualan')
              .select('produk_id, qty, harga_jual, diskon_pct').in('id', srcIds);
            if (eS) throw eS;
            det = (srcRows || []).map(r => ({ produk_id: r.produk_id, qty: r.qty,
              harga: Number(r.harga_jual), diskon_pct: Number(r.diskon_pct || 0), deskripsi: null }));
            if (!det.length) return bad(res, 'Data penjualan sumber tidak ditemukan');
          }
          const ong = Number(body.ongkir) || 0, pot = Number(body.potongan) || 0, pjk = Number(body.pajak_pct) || 0;
          const { subtotal, total } = calcInv(det, pot, pjk, ong);
          const nomor = await nextNum('invoice', 'nomor', 'INV');
          const invRow = {
            nomor, tanggal: body.tanggal || tgl(), jatuh_tempo: body.jatuh_tempo || null,
            customer_nama: body.customer_nama.trim(),
            customer_telepon: (body.customer_telepon || '').trim() || null,
            customer_email: (body.customer_email || '').trim() || null,
            customer_alamat: (body.customer_alamat || '').trim() || null,
            channel: (body.channel || 'Invoice').trim(),
            ongkir: ong, potongan: pot, pajak_pct: pjk, total,
            status_bayar: ['Belum Bayar', 'DP', 'Lunas'].includes(body.status_bayar) ? body.status_bayar : 'Belum Bayar',
            nominal_bayar: Number(body.nominal_bayar) || 0,
            metode_bayar: (body.metode_bayar || '').trim() || null,
            catatan: (body.catatan || '').trim() || null,
          };
          const { data: inv, error: e1 } = await sb().from('invoice').insert(invRow).select().single();
          if (e1) throw e1;
          const { error: e2 } = await sb().from('invoice_detail').insert(det.map(d => ({ ...d, invoice_id: inv.id })));
          if (e2) throw e2;
          if (srcIds.length) {
            const { error: e3 } = await sb().from('penjualan').update({ invoice_id: inv.id }).in('id', srcIds);
            if (e3) throw e3;
          } else if (body.catat_penjualan !== false) {
            await createSalesFromInvoice(inv, det);
          }
          return ok(res, inv);
        }

        if (req.method === 'PUT') {
          if (!id) return bad(res, '?id= wajib');
          const { data: cur, error: e0 } = await sb().from('invoice').select('*').eq('id', id).maybeSingle();
          if (e0) throw e0;
          if (!cur) return bad(res, 'Invoice tidak ditemukan', 404);
          const patch = {};
          ['tanggal','jatuh_tempo','customer_nama','customer_telepon','customer_email','customer_alamat','channel','metode_bayar','catatan']
            .forEach(k => { if (body[k] !== undefined) patch[k] = body[k] === '' ? null : body[k]; });
          ['ongkir','potongan','pajak_pct','nominal_bayar']
            .forEach(k => { if (body[k] !== undefined) patch[k] = Number(body[k]) || 0; });
          if (body.status_bayar) {
            if (!['Belum Bayar','DP','Lunas'].includes(body.status_bayar)) return bad(res, 'Status tidak valid');
            patch.status_bayar = body.status_bayar;
          }
          if (Array.isArray(body.items)) {
            const items = normItems(body.items);
            const srcIds = (body.sumber_penjualan_ids || []).map(Number).filter(Boolean);
            if (!items.length) return bad(res, 'Minimal 1 item invoice');
            await sb().from('penjualan').delete().eq('invoice_id', id).eq('dari_invoice', true);
            await sb().from('penjualan').update({ invoice_id: null }).eq('invoice_id', id);
            await sb().from('invoice_detail').delete().eq('invoice_id', id);
            await sb().from('invoice_detail').insert(items.map(d => ({ ...d, invoice_id: id })));
            if (srcIds.length) {
              await sb().from('penjualan').update({ invoice_id: id }).in('id', srcIds);
            } else {
              const catat = body.catat_penjualan === undefined ? true : !!body.catat_penjualan;
              if (catat) await createSalesFromInvoice({ ...cur, ...patch, id }, items);
            }
          }
          const { data: det } = await sb().from('invoice_detail').select('qty, harga, diskon_pct').eq('invoice_id', id);
          const { total } = calcInv(det || [], patch.potongan ?? cur.potongan, patch.pajak_pct ?? cur.pajak_pct, patch.ongkir ?? cur.ongkir);
          patch.total = total;
          const { data: inv, error } = await sb().from('invoice').update(patch).eq('id', id).select().single();
          if (error) throw error;
          return ok(res, inv);
        }

        if (req.method === 'DELETE') {
          if (!id) return bad(res, '?id= wajib');
          await sb().from('penjualan').delete().eq('invoice_id', id).eq('dari_invoice', true);
          await sb().from('penjualan').update({ invoice_id: null }).eq('invoice_id', id);
          const { error } = await sb().from('invoice').delete().eq('id', id);
          if (error) throw error;
          return ok(res, { success: true });
        }
        return bad(res, 'Method tidak didukung', 405);
      }

      /* ================= DASHBOARD ================= */
      case 'dashboard': {
        const bulan = tgl().slice(0, 7);
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
        const [rHpp, rSales, rInv, rPb] = await Promise.all([
          sb().from('v_hpp_po').select('id, kode_po, tanggal, qty, status, nama_produk, hpp_per_pcs')
            .order('id', { ascending: false }).limit(5),
          sb().from('v_penjualan').select('id, tanggal, qty, channel, nama_produk, net_sales, laba_bersih')
            .order('id', { ascending: false }).limit(5),
          sb().from('v_invoice').select('id, nomor, tanggal, customer_nama, total, nominal_bayar, status_bayar')
            .order('id', { ascending: false }),
          sb().from('v_pembelian').select('total').gte('tanggal', awalBulan),
        ]);
        const invAll = rInv.data || [];
        const piutang = invAll.reduce((s, r) =>
          s + (r.status_bayar === 'Lunas' ? 0 : Math.max(0, Number(r.total) - Number(r.nominal_bayar))), 0);
        return ok(res, {
          periode: bulan,
          counts: { produk: rProduk.count || 0, bahan: rBahan.count || 0, po_aktif: rPO.count || 0 },
          bulan_ini: { net_sales: net, laba, hpp, margin_pct: net > 0 ? (laba / net) * 100 : 0 },
          piutang_invoice: piutang,
          pembelian_bulan: (rPb.data || []).reduce((s, r) => s + Number(r.total || 0), 0),
          chart,
          hpp_terbaru: rHpp.data || [],
          penjualan_terbaru: rSales.data || [],
          invoice_terbaru: invAll.slice(0, 5),
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

async function nextNum(table, col, prefix) {
  const ym = tgl().slice(0, 7).replace('-', '');
  const { count } = await sb().from(table).select('id', { count: 'exact', head: true }).like(col, `${prefix}-${ym}-%`);
  return `${prefix}-${ym}-${String((count || 0) + 1).padStart(4, '0')}`;
}

async function createSalesFromInvoice(inv, items) {
  const rows = [];
  for (const it of items) {
    rows.push({
      tanggal: inv.tanggal, produk_id: it.produk_id, qty: it.qty,
      channel: inv.channel || 'Invoice', harga_jual: it.harga, diskon_pct: it.diskon_pct || 0,
      fee_pct: 0, biaya_lain: 0, hpp_satuan: await latestHpp(it.produk_id),
      invoice_id: inv.id, dari_invoice: true,
    });
  }
  if (rows.length) {
    const { error } = await sb().from('penjualan').insert(rows);
    if (error) throw error;
  }
}
