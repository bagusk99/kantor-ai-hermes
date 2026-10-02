#!/bin/bash

echo "🚀 Menjalankan Backend Server Kantor AI..."
echo "============================================="

# Cek apakah file .env ada
if [ ! -f .env ]; then
    echo "⚠️  Peringatan: File .env tidak ditemukan!"
    echo "💡 Membuat .env dari .env.example (Dry-run mode aktif)..."
    cp .env.example .env
fi

# Cek apakah ANTHROPIC_API_KEY sudah diisi
if grep -q "ANTHROPIC_API_KEY=your_anthropic_api_key_here" .env; then
    echo "⚠️  Perhatian: ANTHROPIC_API_KEY belum disetel di .env!"
    echo "   Server akan berjalan dalam mode DRY RUN (tanpa memanggil API AI)."
else
    echo "✅ ANTHROPIC_API_KEY terdeteksi (AI aktif jika key valid)."
fi

echo "============================================="
echo "🌍 Membuka http://127.0.0.1:3000 ..."

# Jalankan server node
node --watch server/server.js
