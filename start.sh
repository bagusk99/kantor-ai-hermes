#!/bin/bash

echo "🚀 Menjalankan Backend Server Kantor AI..."
echo "============================================="

# Kantor AI butuh Hermes dashboard (port 9119) untuk profile dan kanban.
if ! curl -s -o /dev/null -m 2 http://127.0.0.1:9119/; then
    echo "⚠️  Hermes dashboard tidak terdeteksi di http://127.0.0.1:9119"
    echo "   Jalankan dulu: hermes dashboard"
fi

echo "============================================="
echo "🌍 Membuka http://127.0.0.1:3000 ..."

# Jalankan server node
node --watch server/server.js
